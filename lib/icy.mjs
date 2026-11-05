// 正在播的歌名：连上电台的音频流，带 Icy-MetaData: 1 请求头，读到第一个元数据块里的 StreamTitle 就断开。
// 安全：前端只传电台 uuid，流地址由这里向 Radio Browser 查（不接受任意 URL）；
// 连接前解析域名并拒绝内网、回环、链路本地等地址，按解析出的 IP 直连（防 DNS 重绑定）；
// 限制跳转次数、超时和读取字节数；结果按电台缓存 15 秒，同一电台并发请求只发一次。
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL = 15000;
const URL_TTL = 3600000;
const TIMEOUT = 8000;
const MAX_BYTES = 160 << 10;
const MAX_REDIRECTS = 3;
const MAX_INFLIGHT = 6;

// ---------- 地址检查 ----------
// 198.18.0.0/15 不拦：Clash 等代理的 fake-ip 模式会把所有域名解析到这一段，拦了就一个台都读不到
function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
function isPublic(ip) {
  if (net.isIPv4(ip)) return !v4Private(ip);
  if (!net.isIPv6(ip)) return false;
  const low = ip.toLowerCase();
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !v4Private(mapped[1]);
  return !(low === '::' || low === '::1' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low) || /^ff/.test(low));
}

async function resolvePublic(host) {
  if (net.isIP(host)) { if (!isPublic(host)) throw new Error('blocked'); return host; }
  const all = await dns.lookup(host, { all: true, verbatim: true });
  // 有任何一个解析结果落在内网就整体拒绝
  if (!all.length || all.some((a) => !isPublic(a.address))) throw new Error('blocked');
  // 优先 IPv4：很多家庭网络没有 IPv6 出口
  return (all.find((a) => a.family === 4) || all[0]).address;
}

// ---------- 读一次元数据 ----------
const clean = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
function decode(buf) {
  const utf = buf.toString('utf8');
  return utf.includes('\ufffd') ? buf.toString('latin1') : utf;
}
function titleOf(meta) {
  // 歌名里可能有单引号（Kamakawiwo'ole），所以要求 '; 后面紧跟下一个字段或结尾
  const text = decode(meta);
  const m = text.match(/StreamTitle='(.*?)';(?=\s*(?:[A-Za-z_]+=|\0|$))/s) || text.match(/StreamTitle='(.*?)';/s);
  // 缺歌手或缺歌名时会剩下孤零零的「 - 」
  const t = m ? clean(m[1]).replace(/^[\s\-–|]+|[\s\-–|]+$/g, '') : '';
  // 占位符（unknown、纯数字编号如 287837 - 404994）不显示
  return !/\p{L}/u.test(t) || /^(unknown|n\/a|null|undefined)$/i.test(t) ? '' : t;
}

async function readOnce(url, hops = 0) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  const ip = await resolvePublic(u.hostname);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
    const opts = { host: ip, port };
    const sock = u.protocol === 'https:'
      ? tls.connect({ ...opts, servername: net.isIP(u.hostname) ? undefined : u.hostname })
      : net.connect(opts);
    const timer = setTimeout(() => finish(new Error('timeout')), TIMEOUT);
    sock.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      // HTTP/1.0：服务器不会用分块传输，音频和元数据按原样交错到来
      sock.write(`GET ${u.pathname || '/'}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\nUser-Agent: orbit-radio/0.1\r\nIcy-MetaData: 1\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    });
    sock.on('error', (e) => finish(e));
    sock.on('end', () => finish(null, { supported: false, title: '' }));

    let buf = Buffer.alloc(0); let total = 0; let metaint = 0; let headerEnd = -1;
    sock.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) return finish(null, { supported: !!metaint, title: '' });
      buf = Buffer.concat([buf, chunk]);
      if (headerEnd < 0) {
        headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) { if (buf.length > 16 << 10) finish(new Error('header')); return; }
        const lines = buf.subarray(0, headerEnd).toString('latin1').split('\r\n');
        const code = Number(lines[0].match(/^(?:HTTP\/\d\.\d|ICY)\s+(\d{3})/)?.[1]);
        const h = Object.fromEntries(lines.slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; }));
        if (code >= 300 && code < 400 && h.location && hops < MAX_REDIRECTS) {
          const next = new URL(h.location, u).href;
          done = true; clearTimeout(timer); sock.destroy();
          return readOnce(next, hops + 1).then(resolve, reject);
        }
        if (code !== 200) return finish(new Error('status'));
        metaint = Number(h['icy-metaint']);
        if (!Number.isInteger(metaint) || metaint <= 0 || metaint > 65536) return finish(null, { supported: false, title: '' });
        buf = buf.subarray(headerEnd + 4);
      }
      // 每 metaint 字节音频后跟 1 字节长度（×16）和元数据；第一块常常是空的，最多看两块
      for (let block = 0; block < 2; block++) {
        if (buf.length < metaint + 1) return;
        const len = buf[metaint] * 16;
        if (buf.length < metaint + 1 + len) return;
        const meta = buf.subarray(metaint + 1, metaint + 1 + len);
        if (len) return finish(null, { supported: true, title: titleOf(meta) });
        buf = buf.subarray(metaint + 1);
        if (block === 1) return finish(null, { supported: true, title: '' });
      }
    });
  });
}

// ---------- 对外 ----------
export function createNowPlaying({ ua }) {
  const cache = new Map(); // uuid → { at, value }
  const urls = new Map(); // uuid → { at, url, hls }
  const pending = new Map();
  let inflight = 0;
  let servers = null;

  async function rb(pathname) {
    if (!servers) {
      try {
        const r = await fetch('https://all.api.radio-browser.info/json/servers', { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(6000) });
        servers = [...new Set((await r.json()).map((s) => 'https://' + s.name))];
      } catch { /* 用默认服务器 */ }
      if (!servers?.length) servers = ['https://de1.api.radio-browser.info'];
    }
    for (const base of servers) {
      try {
        const r = await fetch(base + pathname, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(6000) });
        if (r.ok) return await r.json();
      } catch { /* 换下一个 */ }
    }
    throw new Error('directory');
  }

  async function streamOf(id) {
    const hit = urls.get(id);
    if (hit && Date.now() - hit.at < URL_TTL) return hit;
    const [st] = await rb(`/json/stations/byuuid/${id}`);
    const val = { at: Date.now(), url: st?.url_resolved || st?.url || '', hls: !!st?.hls };
    urls.set(id, val);
    if (urls.size > 2000) urls.delete(urls.keys().next().value);
    return val;
  }

  async function lookup(id) {
    const { url, hls } = await streamOf(id);
    if (!url || hls || /\.m3u8($|\?)/i.test(url)) return { supported: false, title: '' };
    try { return await readOnce(url); } catch { return { supported: false, title: '' }; }
  }

  return {
    valid: (id) => UUID_RE.test(id || ''),
    busy: () => inflight >= MAX_INFLIGHT,
    async get(id) {
      const hit = cache.get(id);
      if (hit && Date.now() - hit.at < TTL) return hit.value;
      if (pending.has(id)) return pending.get(id);
      inflight += 1;
      const p = lookup(id).finally(() => { inflight -= 1; pending.delete(id); });
      pending.set(id, p);
      const value = await p;
      cache.set(id, { at: Date.now(), value });
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      return value;
    },
  };
}
