// Radio Browser 接口（https://api.radio-browser.info）：选服务器、失败换下一个、按地点/省州/国家取台
import { $, shuffled, canLoad } from './util.js';

const FALLBACK_SERVERS = ['https://de1.api.radio-browser.info'];

let servers = null;
async function getServers() {
  if (servers) return servers;
  try {
    const cached = JSON.parse(sessionStorage.getItem('air:servers') || 'null');
    if (Array.isArray(cached) && cached.length) return (servers = cached);
  } catch { /* 忽略损坏缓存 */ }
  try {
    const r = await fetch('https://all.api.radio-browser.info/json/servers', { signal: AbortSignal.timeout(5000) });
    const list = [...new Set((await r.json()).map((s) => 'https://' + s.name))];
    servers = list.length ? shuffled(list) : FALLBACK_SERVERS.slice();
  } catch { servers = FALLBACK_SERVERS.slice(); }
  try { sessionStorage.setItem('air:servers', JSON.stringify(servers)); } catch { /* 忽略 */ }
  return servers;
}

// 按官方建议：失败就换下一个服务器
async function api(path, params) {
  const qs = params ? '?' + new URLSearchParams(params) : '';
  const list = await getServers();
  let lastErr;
  for (let i = 0; i < list.length; i++) {
    try {
      const r = await fetch(list[i] + path + qs, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (i > 0) list.push(...list.splice(0, i));
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const httpsOnly = (p) => { if (location.protocol === 'https:') p.is_https = 'true'; return p; };

const norm = (s) => ({
  id: s.stationuuid,
  name: (s.name || '').replace(/\s+/g, ' ').trim() || '未命名电台',
  url: s.url_resolved || s.url,
  url2: s.url,
  favicon: s.favicon || '',
  cc: (s.countrycode || '').toUpperCase(),
  country: s.country || '',
  state: s.state || '',
  tags: (s.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5),
  codec: s.codec || '',
  bitrate: s.bitrate || 0,
  hls: !!s.hls,
  homepage: s.homepage || '',
  lat: Number.isFinite(s.geo_lat) ? s.geo_lat : null,
  lon: Number.isFinite(s.geo_long) ? s.geo_long : null,
});

async function nearbyStations(lat, lon) {
  for (const km of [40, 150, 300]) {
    try {
      const list = (await api('/json/stations/search', httpsOnly({ geo_lat: lat.toFixed(4), geo_long: lon.toFixed(4), geo_distance: km * 1000, hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: 50 }))).map(norm).filter((s) => s.url);
      if (list.length) return { list, sub: `方圆 ${km} 公里` };
    } catch { /* 换更大的范围 */ }
  }
  return { list: [], sub: '方圆 300 公里' };
}

// 省/州里的台：服务端给按点击量排好的 uuid，详情从 Radio Browser 取
async function regionStations(region) {
  try {
    const r = await fetch(`/api/region/${region.id}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { list: [], sub: '全省州' };
    const { uuids } = await r.json();
    if (!uuids.length) return { list: [], sub: '全省州' };
    const order = new Map(uuids.map((u, i) => [u, i]));
    const list = (await api('/json/stations/byuuid', { uuids: uuids.join(',') })).map(norm)
      .filter((s) => canLoad(s.url) || canLoad(s.url2))
      .sort((a, b) => order.get(a.id) - order.get(b.id))
      // 没坐标的台放在省会/州府，播放时地球能飞过去
      .map((s) => (s.lat === null ? { ...s, lat: region.lat, lon: region.lon } : s));
    return { list, sub: `${region.name}全境` };
  } catch { return { list: [], sub: '全省州' }; }
}

async function countryStations(iso, name) {
  try {
    const list = (await api('/json/stations/search', httpsOnly({ countrycode: iso, hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: 50 }))).map(norm).filter((s) => s.url);
    return { list, sub: `${name}热门` };
  } catch { return { list: [], sub: `${name}热门` }; }
}

// 按 uuid 取一个台（分享链接用）
async function fetchStation(id) {
  const [s] = await api('/json/stations/byuuid', { uuids: id });
  return s ? norm(s) : null;
}

export { api, httpsOnly, norm, nearbyStations, regionStations, countryStations, fetchStation };
