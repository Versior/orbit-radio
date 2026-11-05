// 地球用的电台分布数据：每 24 小时从 Radio Browser 拉一遍全库，生成两样东西
// 1. clusters：带坐标的台按 0.5° 网格聚合 [纬度, 经度, 台数]
// 2. regions ：每个省/州里有哪些台（按点击量排序的 uuid）
//    - 有坐标的台：查 vendor/admin1-ids.bin，看坐标落在哪个省/州
//    - 没坐标的台：用 state 字段匹配 vendor/region-alias.json 里的别名（Radio Browser 里中国 2181 个台只有 32 个有坐标，主要靠这一步）
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { normName } from './region-name.mjs';

const TTL = 24 * 3600 * 1000;
// 重新生成 vendor/admin1-ids.bin 后省/州编号会变，记得同时改这个版本号让缓存失效
const VERSION = 4;
const PAGE = 10000;
const KEEP = 150; // 每个省/州最多保留多少个台

export function createGeo({ root, ua }) {
  const file = path.join(root, 'data', 'geo-clusters.json');
  const state = { data: null, pub: null, building: false };
  const headers = { 'User-Agent': ua };

  async function servers() {
    try {
      const r = await fetch('https://all.api.radio-browser.info/json/servers', { headers, signal: AbortSignal.timeout(8000) });
      const list = [...new Set((await r.json()).map((s) => 'https://' + s.name))];
      if (list.length) return list.sort(() => Math.random() - 0.5);
    } catch { /* 用默认服务器 */ }
    return ['https://de1.api.radio-browser.info'];
  }

  async function loadIndex() {
    const vendor = path.join(root, 'vendor');
    const [bin, meta, alias] = await Promise.all([
      readFile(path.join(vendor, 'admin1-ids.bin')),
      readFile(path.join(vendor, 'regions.json'), 'utf8').then(JSON.parse),
      readFile(path.join(vendor, 'region-alias.json'), 'utf8').then(JSON.parse),
    ]);
    const raw = zlib.inflateSync(bin);
    const ids = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const names = new Map(); // "CN|jiangsu" → 编号；同一国家里有重名的记为 -1，不用
    for (const [iso, id, ...list] of alias) {
      for (const a of list) {
        const k = iso + '|' + a;
        names.set(k, names.has(k) && names.get(k) !== id ? -1 : id);
      }
    }
    const { w, h } = meta;
    // 坐标 → 编号；海边的台可能落在海里，向周围两格找一下
    const at = (lat, lon) => {
      const x = Math.min(w - 1, Math.floor((lon + 180) / 360 * w)); const y = Math.min(h - 1, Math.floor((90 - lat) / 180 * h));
      for (let r = 0; r <= 2; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const yy = y + dy; const xx = (x + dx + w) % w;
            if (yy >= 0 && yy < h && ids[yy * w + xx]) return ids[yy * w + xx];
          }
        }
      }
      return 0;
    };
    // 先整串匹配；不行再按逗号、斜杠拆开从后往前试（"Miami, Florida"、"Bayern, München"），
    // 最后试末尾的词（"New York NY" 里的州缩写）
    const byName = (cc, st) => {
      const s = String(st);
      const tries = [s, ...s.split(/[,/;|]|\s-\s/).reverse(), s.trim().split(/\s+/).pop()];
      for (const t of tries) { const id = names.get(cc + '|' + normName(t)); if (id > 0) return id; }
      return 0;
    };
    return { at, byName };
  }

  async function build() {
    if (state.building) return;
    state.building = true;
    const started = Date.now();
    try {
      const [list, index] = await Promise.all([servers(), loadIndex()]);
      const cells = new Map(); const regions = new Map();
      let withGeo = 0; let matched = 0;
      for (let offset = 0; ; offset += PAGE) {
        let page = null;
        for (const base of list) {
          try {
            const r = await fetch(`${base}/json/stations/search?hidebroken=true&order=clickcount&reverse=true&limit=${PAGE}&offset=${offset}`, { headers, signal: AbortSignal.timeout(120000) });
            if (r.ok) { page = await r.json(); break; }
          } catch { /* 换下一个服务器 */ }
        }
        if (!page) throw new Error('directory unavailable');
        for (const s of page) {
          const lat = Number(s.geo_lat); const lon = Number(s.geo_long);
          const geo = s.geo_lat != null && s.geo_long != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
          let id = 0;
          if (geo) {
            const key = `${Math.round(lat * 2)},${Math.round(lon * 2)}`;
            const c = cells.get(key) || { lat: 0, lon: 0, n: 0 };
            c.lat += lat; c.lon += lon; c.n += 1; cells.set(key, c);
            withGeo += 1;
            id = index.at(lat, lon);
          } else if (s.state && s.countrycode) {
            id = index.byName(String(s.countrycode).toUpperCase(), s.state);
            if (id) matched += 1;
          }
          if (!id) continue;
          const reg = regions.get(id) || { geo: 0, extra: 0, list: [] };
          if (geo) reg.geo += 1; else reg.extra += 1;
          if (reg.list.length < KEEP) reg.list.push(s.stationuuid); // 已按点击量排序，前面的就是热门台
          regions.set(id, reg);
        }
        if (page.length < PAGE) break;
      }
      const round = (v) => Math.round(v * 100) / 100;
      const data = {
        v: VERSION, builtAt: Date.now(), stations: withGeo,
        clusters: [...cells.values()].map((c) => [round(c.lat / c.n), round(c.lon / c.n), c.n]),
        regions: Object.fromEntries(regions),
      };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data));
      set(data);
      console.log(`[geo] ${data.clusters.length} 个地点 / ${withGeo} 个带坐标的台；按省州名补上 ${matched} 个；覆盖 ${regions.size} 个省/州；用时 ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (e) {
      console.warn(`[geo] 生成失败：${e.message}`);
    } finally {
      state.building = false;
    }
  }

  // 对外的 /api/geo 只带计数：regions 每项 [编号, 总台数, 没坐标的台数]
  function set(data) {
    state.data = data;
    state.pub = {
      builtAt: data.builtAt, stations: data.stations, clusters: data.clusters,
      regions: Object.entries(data.regions).map(([id, r]) => [Number(id), r.geo + r.extra, r.extra]),
    };
  }

  const stale = () => !state.data || state.data.v !== VERSION || Date.now() - state.data.builtAt > TTL;

  return {
    async init() {
      try { set(JSON.parse(await readFile(file, 'utf8'))); } catch { /* 首次运行没有缓存 */ }
      if (stale()) build(); // 旧版本缓存先照常提供，新数据生成后替换
      setInterval(() => { if (stale()) build(); }, 3600 * 1000).unref();
    },
    get public() { return state.pub?.regions && state.data?.v === VERSION ? state.pub : null; },
    region(id) {
      const r = state.data?.v === VERSION ? state.data.regions[id] : null;
      return r ? { id, total: r.geo + r.extra, uuids: r.list.slice(0, 100) } : null;
    },
  };
}
