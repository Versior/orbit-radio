// 地球：布局区域、文字避让、光点与统计数据、悬停提示、创建地球
import { $, $$, esc, regionName, isMobile, fmt, guessRegion, toast } from './util.js';
import { api } from './radio.js';
import { S, P } from './state.js';
import { openPlace } from './panel.js';
import { onTune, renderSky, takeWheel } from './tune.js';
import { createGlobe } from '../globe.js';
import { LANDMARKS, OCEANS } from '../landmarks.js';

const SIDE_W = 380; // 和 style.css 里的 --side-w 保持一致
const SCALE_W = 260; // 和 style.css 里的 --scale-w 保持一致

let globe = null;

// 初始视角：整颗地球完整可见，正对用户所在地区
const REGION_HOME = { CN: [30, 105], JP: [36, 138], KR: [36, 128], US: [38, -97], GB: [50, 0], FR: [46, 2], DE: [50, 10] };
const homeView = () => [...(REGION_HOME[guessRegion()] || [25, 100]), 1];

// 地球（连同赤道环）画在顶栏、底部读数和右侧经线刻度之间；面板打开时向左（手机上向上）让位。
// 半径 = size × 0.42，环上的字最远到 1.29 倍半径
function globeArea() {
  const W = innerWidth; const H = innerHeight;
  if (isMobile()) {
    const top = 70; const bottom = S.panel ? H * 0.44 : H - 300;
    // 手机上地球尽量大：环的两侧会出屏，但那里的刻度本来就侧着看不清，不画字
    return { cx: W / 2, cy: (top + bottom) / 2, size: Math.min(W, (bottom - top) * 1.3) };
  }
  const gx = Math.min(40, Math.max(16, W * 0.032));
  const top = 92; const bottom = 236;
  const cy = top + (H - top - bottom) / 2;
  let size = Math.min((H - top - bottom) / 0.86, 760);
  if (S.panel) {
    const right = W - SIDE_W - gx * 2;
    size = Math.min(size, (right - 60) / 1.1);
    return { cx: right / 2 + 10, cy, size };
  }
  const scaleLeft = W - gx - SCALE_W;
  size = Math.min(size, (scaleLeft - 120) / 1.1);
  return { cx: Math.min(W / 2, scaleLeft - 1.3 * size * 0.42 - 36), cy, size };
}

// 页面上压在地球上的文字块，地名要避开。布局变化后等过渡动画结束再量一次，平时只读缓存
let AVOID = [];
let SCALE_BOX = null;
let avoidTimer = 0;
const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility === 'visible' && cs.opacity !== '0'; };
function refreshAvoid() {
  clearTimeout(avoidTimer);
  avoidTimer = setTimeout(() => {
    AVOID = $$('.read, .mode, .hint, .side, .scale, .poem, .sky').filter(shown)
      .map((el) => { const r = el.getBoundingClientRect(); return [r.left - 8, r.top - 8, r.width + 16, r.height + 16]; });
    const sc = $('#scale');
    const r = sc.getBoundingClientRect();
    SCALE_BOX = shown(sc) ? [r.left, r.top, r.width, r.height] : null;
    globe?.relayout();
  }, 700);
}
addEventListener('resize', refreshAvoid);
new MutationObserver(refreshAvoid).observe(document.body, { attributes: true, attributeFilter: ['class'] });
// 读数里多出一行歌名、台名换行时，读数区变高，也要重新量
new ResizeObserver(refreshAvoid).observe($('.read'));

// 印章旁边的统计：多少个电台、多少个国家和地区
function renderStats() {
  const total = [...COUNTRY_COUNT.values()].reduce((a, b) => a + b, 0);
  const lands = [...COUNTRY_COUNT.values()].filter((n) => n > 0).length;
  if (!total) return;
  $('[data-bind="stats"]').textContent = `${fmt(total)} 个电台 · ${lands} 个国家和地区`;
}

function clusterLocal(list) {
  const cells = new Map();
  for (const s of list) {
    const lat = Number(s.geo_lat); const lon = Number(s.geo_long);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const k = `${Math.round(lat * 2)},${Math.round(lon * 2)}`;
    const c = cells.get(k) || { lat: 0, lon: 0, n: 0 };
    c.lat += lat; c.lon += lon; c.n += 1; cells.set(k, c);
  }
  return [...cells.values()].map((c) => [c.lat / c.n, c.lon / c.n, c.n]);
}

// 每个省/州有多少台（含没坐标、按省州名收录的台）
const REGION_COUNT = new Map();
async function loadGeo(retry = 0) {
  try {
    const r = await fetch('/api/geo', { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      const extra = [];
      for (const [id, total, noGeo] of data.regions || []) {
        REGION_COUNT.set(id, total);
        const g = globe.region(id);
        // 没坐标的台画在省会/州府附近（标注点）
        if (noGeo && g) extra.push([g.lat, g.lon, noGeo, { region: id }]);
      }
      globe.setPoints([...data.clusters, ...extra]);
      globe.setRegionCounts(REGION_COUNT);
      renderSky();
      return;
    }
    if (r.status === 503 && retry < 6) setTimeout(() => loadGeo(retry + 1), 20000);
  } catch { /* 静态托管时没有这个接口 */ }
  if (retry > 0) return;
  try {
    globe.setPoints(clusterLocal(await api('/json/stations/search', { has_geo_info: 'true', hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: 2500 })));
    renderSky();
  } catch { toast('电台分布暂时加载不出来'); }
}

// 各国电台总数（含没有坐标的台），悬停国家时显示
const COUNTRY_COUNT = new Map();
async function loadCountryCounts() {
  try {
    for (const c of await api('/json/countries')) {
      const iso = (c.iso_3166_1 || '').toUpperCase();
      if (iso) COUNTRY_COUNT.set(iso, (COUNTRY_COUNT.get(iso) || 0) + (c.stationcount || 0));
    }
    renderStats();
  } catch { /* 只影响提示文字 */ }
}

// 「四川，中国」；省/州名和国名一样（如新加坡）时只写一个
function placeName(region, country) {
  const c = country?.name || (region ? regionName(region.iso) : '');
  return region && region.name !== c ? `${region.name}，${c}` : c;
}

function tipText(h) {
  if (h.kind === 'landmark') return [`${h.mark.city} · ${h.mark.name}`, h.mark.quip ? '点一下看看' : `点一下，收听${h.mark.city}`];
  if (h.kind === 'station') {
    const region = h.meta?.region ? globe.region(h.meta.region) : h.region;
    return [placeName(region, h.country) || '这里', h.meta ? `按省州名收录 · ${h.n} 个电台` : `${h.n} 个电台`];
  }
  if (h.regionMode && h.region) {
    const n = REGION_COUNT.get(h.region.id) || 0;
    return [placeName(h.region, h.country), n ? `${fmt(n)} 个电台` : '暂时没有收录这里的台'];
  }
  const total = h.country?.iso ? COUNTRY_COUNT.get(h.country.iso) : 0;
  return [h.country?.name || '', total ? `全国 ${fmt(total)} 个电台` : '点一下，看看这里'];
}

function renderTip(h) {
  const tip = $('#globeTip');
  if (!h || (h.kind === 'country' && !h.country)) { tip.hidden = true; return; }
  const [title, sub] = tipText(h);
  tip.innerHTML = `<b>${esc(title)}</b><small>${esc(sub)}</small>`;
  tip.hidden = false;
  const x = Math.min(h.x + 14, innerWidth - tip.offsetWidth - 8);
  tip.style.transform = `translate(${x}px, ${h.y - 52}px)`;
}

async function initGlobe() {
  const [lat, lon, zoom] = homeView();
  try {
    globe = await createGlobe($('#globe'), {
      fx: $('#globeFx'),
      getArea: globeArea,
      avoid: () => AVOID,
      scale: () => (S.panel || isMobile() ? null : SCALE_BOX),
      home: [lat, lon],
      landmarks: LANDMARKS,
      oceans: OCEANS,
      overlays: { marker: $('#pinNow'), selected: $('#pinSel'), scale: $('#scaleList') },
      onPick: openPlace,
      onInteract: takeWheel,
      onHover: renderTip,
      onTune,
    });
  } catch (e) { console.error(e); toast('地球加载失败'); return; }
  // 上次听的台还在，就从那条经线开始
  if (P.cur?.lat != null) globe.flyTo(P.cur.lat, P.cur.lon, 1, 1); else globe.flyTo(lat, lon, zoom, 1);
  if (P.cur) globe.setMarker(P.cur.lat, P.cur.lon);
  loadGeo();
  loadCountryCounts();
  refreshAvoid();
}

export { globe, refreshAvoid, placeName, REGION_COUNT, homeView, initGlobe };
