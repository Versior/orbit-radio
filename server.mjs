// 环听 Orbit · 零依赖本地服务：托管静态文件 + AI 找台接口 + 地球光点数据。
// 运行：node server.mjs   （Node 18+；大模型配置见 .env.example）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeo } from './lib/geo.mjs';
import { createNowPlaying } from './lib/icy.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '127.0.0.1';
const AI = {
  base: (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, ''),
  key: (process.env.AI_API_KEY || '').trim(),
  model: (process.env.AI_MODEL || '').trim(),
};
const aiReady = () => Boolean(AI.base && AI.key && AI.model);

const MAX_BODY = 8 << 10;
const AI_TIMEOUT = 20000;
const MAX_INFLIGHT = 2;
const RATE = { limit: 20, windowMs: 60000 };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8', '.bin': 'application/octet-stream',
};

// 只读取 .env 里尚未在环境变量中设置的键；从不打印值
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------- 输入清洗 ----------
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const cc2 = (v) => { const c = str(v, 8).toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : ''; };
const strList = (v, max, len) => (Array.isArray(v) ? v.map((x) => str(x, len)).filter(Boolean).slice(0, max) : []);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

function readContext(c) {
  c = c && typeof c === 'object' ? c : {};
  const ctx = {
    hour: num(c.hour, 0, 23),
    weekday: str(c.weekday, 8),
    timezone: str(c.timezone, 40),
    language: str(c.language, 16),
    region: cc2(c.region),
  };
  const lat = num(c.location?.lat, -90, 90);
  const lon = num(c.location?.lon, -180, 180);
  // 位置只保留一位小数（约 10 公里精度）
  if (lat !== null && lon !== null) ctx.location = { lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10 };
  const taste = { tags: strList(c.taste?.tags, 6, 24), countries: strList(c.taste?.countries, 4, 2).map(cc2).filter(Boolean) };
  if (taste.tags.length || taste.countries.length) ctx.taste = taste;
  if (c.current && typeof c.current === 'object') {
    ctx.current = { name: str(c.current.name, 60), countrycode: cc2(c.current.countrycode), tags: strList(c.current.tags, 4, 24) };
  }
  for (const k of Object.keys(ctx)) if (ctx[k] === null || ctx[k] === '') delete ctx[k];
  return ctx;
}

function readHistory(h) {
  if (!Array.isArray(h)) return [];
  return h.slice(-6)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: str(m.content, 400) }))
    .filter((m) => m.content);
}

function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.queries) || !raw.queries.length) throw codeError('invalid_reply');
  const queries = raw.queries.slice(0, 4).map((q) => {
    q = q && typeof q === 'object' ? q : {};
    const out = { title: str(q.title, 30) || '为你推荐', reason: str(q.reason, 60) };
    const cc = cc2(q.countrycode);
    if (cc) out.countrycode = cc;
    for (const k of ['tag', 'language', 'name']) { const v = str(q[k], 40).toLowerCase(); if (v) out[k] = v; }
    const lat = num(q.geo?.lat, -90, 90);
    const lon = num(q.geo?.lon, -180, 180);
    if (lat !== null && lon !== null) out.geo = { lat: +lat.toFixed(3), lon: +lon.toFixed(3), km: Math.min(500, Math.max(5, Math.round(num(q.geo.km, 1, 20000) ?? 60))) };
    return out;
  });
  // 没有任何条件的查询只会返回全球热门，有其它查询时丢掉
  const useful = queries.filter((q) => q.countrycode || q.tag || q.language || q.name || q.geo);
  return {
    reply: str(raw.reply, 140) || '帮你找了几个台。',
    queries: useful.length ? useful : queries.slice(0, 1),
    followups: strList(raw.followups, 4, 16),
  };
}

// ---------- 大模型 ----------
const SYSTEM_PROMPT = `你是「环听 Orbit」的找台助手。用户用一句话描述想听的内容，你把它翻译成 Radio Browser 电台库的查询计划。你只生成查询条件，不要编造电台名字。

查询字段：
- countrycode：ISO 3166-1 两位大写国家码，如 JP、FR、US。
- tag：社区标签，英文小写，一次只填一个。常见：jazz, blues, soul, funk, classical, piano, rock, metal, indie, pop, electronic, house, techno, ambient, chillout, lofi, lounge, hip hop, rnb, reggae, latin, bossa nova, country, folk, oldies, 80s, 90s, news, talk, sports, kpop, jpop, anime, world music。
- language：电台语言，英文小写，如 english、japanese、french、spanish、chinese、cantonese。
- name：只有用户点名某个电台或品牌时才填，如 bbc、nhk、fip。
- geo：{"lat":纬度,"lon":经度,"km":半径公里}。用户提到具体城市时使用，城市一般 30~80 公里，同时填上该城市的 countrycode。用户说「附近」且上下文有 location 时用那个坐标。

规则：
1. 输出 1~4 个查询，彼此要有差异（不同风格、城市或语言）。每个查询最多组合 2~3 个条件，叠太多会搜不到。
2. 用户说得模糊（「随便」「此刻适合听什么」）时，结合上下文的本地时间、星期、常听风格（taste）和正在播放的台（current）推断。
3. 用户在追问（如「更安静一点」「换个国家」）时，在对话历史的上一轮计划基础上调整。
4. title 是分组名，中文 12 字以内；reason 一句中文说明推荐理由，30 字以内。
5. reply 是一句自然、简短、有温度的中文回应，40 字以内，不要列清单。
6. followups 给 3~4 个用户可能接着说的短句，每句 8 字以内。

只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：
{"reply":"...","queries":[{"title":"...","reason":"...","countrycode":"FR","tag":"jazz","geo":{"lat":48.86,"lon":2.35,"km":50}}],"followups":["..."]}`;

function codeError(code, status) { return Object.assign(new Error(code), { code, status }); }

function parseModelJSON(content) {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw codeError('invalid_reply');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { throw codeError('invalid_reply'); }
}

async function recommend(prompt, context, history) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `上下文：${JSON.stringify(context)}\n用户说：${prompt}` },
  ];
  let res;
  try {
    res = await fetch(AI.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${AI.key}` },
      body: JSON.stringify({ model: AI.model, messages, temperature: 0.7, max_tokens: 800 }),
      signal: AbortSignal.timeout(AI_TIMEOUT),
    });
  } catch (e) {
    throw codeError(e.name === 'TimeoutError' ? 'timeout' : 'upstream');
  }
  if (!res.ok) { await res.body?.cancel(); throw codeError('upstream', res.status); }
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw codeError('invalid_reply');
  return sanitizePlan(parseModelJSON(content));
}

// ---------- 地球光点：见 lib/geo.mjs ----------
const geo = createGeo({ root: ROOT, ua: 'orbit-radio/0.1' });

// ---------- 正在播的歌名：见 lib/icy.mjs ----------
const nowPlaying = createNowPlaying({ ua: 'orbit-radio/0.1' });

// ---------- HTTP ----------
const hits = new Map();
const nowHits = new Map();
let inflight = 0;

function limited(ip, map = hits, rate = RATE) {
  const now = Date.now();
  const h = map.get(ip);
  if (!h || now > h.reset) {
    if (map.size > 5000) map.clear();
    map.set(ip, { count: 1, reset: now + rate.windowMs });
    return false;
  }
  h.count += 1;
  return h.count > rate.limit;
}

// 前端每 20 秒问一次；每个 IP 每分钟最多 12 次
async function handleNow(req, res, id) {
  if (!nowPlaying.valid(id)) return send(res, 400, { error: 'invalid_input' });
  if (limited(req.socket.remoteAddress || '', nowHits, { limit: 12, windowMs: 60000 })) return send(res, 429, { error: 'rate_limited' });
  if (nowPlaying.busy()) return send(res, 429, { error: 'busy' });
  const v = await nowPlaying.get(id.toLowerCase());
  send(res, 200, v);
}

function send(res, status, body, headers = {}) {
  const isJSON = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJSON ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJSON ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(codeError('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRecommend(req, res) {
  if (!aiReady()) return send(res, 503, { error: 'unconfigured' });
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'invalid_input' });
  if (limited(req.socket.remoteAddress || '')) return send(res, 429, { error: 'rate_limited' });
  if (inflight >= MAX_INFLIGHT) return send(res, 429, { error: 'busy' });

  let input;
  try { input = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.code === 'too_large' ? 413 : 400, { error: 'invalid_input' }); }
  const prompt = str(input?.prompt, 200);
  if (!prompt) return send(res, 400, { error: 'invalid_input' });

  inflight += 1;
  const started = Date.now();
  try {
    const plan = await recommend(prompt, readContext(input.context), readHistory(input.history));
    console.log(`[ai] ok ${Date.now() - started}ms queries=${plan.queries.length}`);
    send(res, 200, plan);
  } catch (e) {
    // 只记录错误码和上游状态码，不记录提示词、回复或密钥
    console.warn(`[ai] fail code=${e.code || 'internal'}${e.status ? ' http=' + e.status : ''}`);
    send(res, e.code === 'timeout' ? 504 : 502, { error: e.code || 'upstream' });
  } finally {
    inflight -= 1;
  }
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = path.join(ROOT, rel);
  const ext = path.extname(file).toLowerCase();
  // 只放行白名单扩展名，拒绝点文件（.env 等）和根目录之外的路径
  // .json / .bin 只允许 vendor/ 下的地图数据
  const jsonBlocked = (ext === '.json' || ext === '.bin') && !/^vendor[/\\][\w.-]+\.(json|bin)$/.test(rel);
  if (!file.startsWith(ROOT + path.sep) || !MIME[ext] || jsonBlocked || rel.split(/[/\\]/).some((p) => p.startsWith('.'))) {
    return send(res, 404, 'Not Found');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[ext], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return send(res, 400, 'Bad Request'); }
  try {
    if (pathname === '/api/ai/status' && req.method === 'GET') return send(res, 200, { enabled: aiReady(), model: aiReady() ? AI.model : null });
    if (pathname === '/api/geo' && req.method === 'GET') {
      return geo.public ? send(res, 200, geo.public, { 'Cache-Control': 'public, max-age=3600' }) : send(res, 503, { error: 'building' });
    }
    const regionId = pathname.match(/^\/api\/region\/(\d{1,5})$/)?.[1];
    if (regionId && req.method === 'GET') {
      const reg = geo.region(Number(regionId));
      return reg ? send(res, 200, reg, { 'Cache-Control': 'public, max-age=3600' }) : send(res, 404, { error: 'not_found' });
    }
    if (pathname === '/api/ai/recommend') return req.method === 'POST' ? await handleRecommend(req, res) : send(res, 405, { error: 'method_not_allowed' });
    const nowId = pathname.match(/^\/api\/now\/([\w-]{36})$/)?.[1];
    if (nowId && req.method === 'GET') return await handleNow(req, res, nowId);
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
    return await serveStatic(req, res, pathname);
  } catch {
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
});

geo.init();

server.listen(PORT, HOST, () => {
  console.log(`环听 Orbit 已启动：http://${HOST}:${PORT}/`);
  console.log(aiReady() ? `大模型：已配置（${AI.model}）` : '大模型：未配置，前端使用本地理解模式');
});
