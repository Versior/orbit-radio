// 调频：指针经线、右侧经线刻度、追着日落 / 日出听
import { $, $$, esc, regionName, isMobile, fmt, toast } from './util.js';
import { nearbyStations, regionStations } from './radio.js';
import { S, P } from './state.js';
import { playStation } from './player.js';
import { globe } from './map.js';
import { sunLon, solarHour, wrapLon } from '../globe.js';
import { scheduleHash } from './share.js';

const T = { lon: 0, zoom: 1, items: [], key: '', focus: -1, timer: 0, at: 0, seq: 0 };
const PHASES = [[5, '深夜'], [6.5, '拂晓'], [9, '清晨'], [11.5, '上午'], [13.5, '正午'], [17, '下午'], [19, '黄昏'], [24, '夜晚']];
const phaseOf = (h) => PHASES.find(([end]) => h < end)[1];
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const lonText = (lon) => `${lon >= 0 ? 'E' : 'W'} ${Math.abs(lon).toFixed(1)}°`;
const latText = (lat) => `${lat >= 0 ? 'N' : 'S'} ${Math.abs(lat).toFixed(1)}°`;
const lonWord = (lon) => `${lon >= 0 ? '东' : '西'}经 ${Math.abs(Math.round(lon))}°`;

// 光点所在的省/州和国家；按省州名收录的点直接用它的省州。
// 海边的城市常落在编号图的海里（分辨率约 0.18°），就在周围一圈找最近的陆地
const PROBE = [[0, 0], ...[0.3, 0.7].flatMap((r) => [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [r, -r], [-r, r], [-r, -r]])];
function clusterPlace(c) {
  if (c.meta?.region) {
    const region = globe.region(c.meta.region);
    return { region, country: region && globe.country(region.iso), name: region?.name || '' };
  }
  for (const [dy, dx] of PROBE) {
    const region = globe.regionAt(c.lat + dy, c.lon + dx);
    const country = globe.countryAt(c.lat + dy, c.lon + dx) || (region && globe.country(region.iso));
    if (region || country) return { region, country, name: region?.name || country?.name };
  }
  return { region: null, country: null, name: '' };
}

// 指针经线两侧的光点：按台数挑，纬度挨得太近、同一个省州的只留一个，最多 7 个，由北向南排
function meridianItems(lon, zoom) {
  const band = Math.max(0.4, 3 / zoom);
  const gap = Math.max(0.8, 6 / zoom);
  const names = new Set(); const out = [];
  for (const c of globe.meridian(lon, band)) {
    if (out.length >= 7) break;
    if (out.some((o) => Math.abs(o.lat - c.lat) < gap)) continue;
    const pl = clusterPlace(c);
    if (!pl.name || names.has(pl.name)) continue;
    names.add(pl.name);
    out.push({ lat: c.lat, lon: c.lon, n: c.n, meta: c.meta, ...pl });
  }
  return { items: out.sort((a, b) => b.lat - a.lat), band, gap };
}

// 指针下的经线：经度 + 那里此刻的当地时间
function renderTune() {
  const h = solarHour(T.lon);
  // 按太阳算的时间，和当地时钟可能差一两个小时（比如新疆用北京时间），所以写明是太阳时
  $('[data-bind="tune"]').textContent = `${lonText(T.lon)} · 太阳时 ${hhmm(h)} ${phaseOf(h)}`;
  $('[data-bind="scale-h"]').textContent = `沿${lonWord(T.lon)} · 由北向南`;
}

function renderScale(force = false) {
  if (!globe) return;
  let { items, band, gap } = meridianItems(T.lon, T.zoom);
  // 正在播的台离哪个地点最近（1.5° 以内），哪个就标成朱砂色；
  // 没有挨着的、但台本身就在这条经线附近，就把它自己的位置插进刻度里
  const cur = P.cur?.lat != null ? P.cur : null;
  let best = 1.5; let hit = null;
  if (cur) for (const it of items) {
    const d = Math.hypot(it.lat - cur.lat, wrapLon(it.lon - cur.lon) * Math.cos(it.lat * Math.PI / 180));
    if (d < best) { best = d; hit = it; }
  }
  if (cur && !hit && Math.abs(wrapLon(cur.lon - T.lon)) <= band) {
    const pl = clusterPlace(cur);
    hit = { lat: cur.lat, lon: cur.lon, n: 0, meta: null, ...pl, name: pl.name || cur.state || regionName(cur.cc) || '这里' };
    items = [...items.filter((it) => Math.abs(it.lat - cur.lat) >= gap && it.name !== hit.name), hit].sort((a, b) => b.lat - a.lat);
  }
  items.forEach((it) => { it.on = it === hit; });
  const onIdx = items.indexOf(hit);
  const key = items.map((it) => `${it.lat},${it.lon},${it.on ? 1 : 0}`).join('|');
  if (key === T.key && !force) return;
  T.key = key; T.items = items;
  T.focus = onIdx; // 刻度换了一批地点，旧的序号不再对应原来的地方
  $('#scale').classList.toggle('empty', !items.length);
  $('#scaleList').innerHTML = items.map((it, i) => `<button class="st${it.on ? ' on' : ''}" data-tune="${i}">
      <b>${esc(it.name)}</b><small>${latText(it.lat)} · ${hhmm(solarHour(it.lon))}${it.on ? ' · 正在播放' : ` · ${fmt(it.n)} 台`}</small></button>`).join('');
  globe.setScale(items);
  // 手机上刻度是横向一排，把正在播的那个滑到中间
  if (isMobile()) $('#scaleList .st.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// 拖动时指针经线一直在变：读数每帧更新，刻度最多每 120ms 重算一次
function onTune(lon, zoom) {
  T.lon = lon; T.zoom = zoom;
  renderTune();
  scheduleHash();
  clearTimeout(T.timer);
  T.timer = setTimeout(() => { T.at = performance.now(); renderScale(); }, Math.max(0, 120 - (performance.now() - T.at)));
}

// 调到刻度上的一个地点：取那里的台，直接开播；←/→ 在这些台之间换
async function tuneTo(it, { quiet = false } = {}) {
  const seq = ++T.seq;
  const got = it.meta?.region ? await regionStations(globe.region(it.meta.region)) : await nearbyStations(it.lat, it.lon);
  if (seq !== T.seq) return false;
  const top = got.list.find((s) => !S.broken.has(s.id));
  if (!top) { if (!quiet) toast(`${it.name}暂时收不到信号`); return false; }
  playStation(top, got.list, { fly: false });
  return true;
}

// ↑ / ↓：沿经线往北、往南换一个地点
function tuneStep(dir) {
  if (!T.items.length) return toast('这条经线上没有电台，转一转地球');
  const i = T.focus < 0 ? (dir > 0 ? 0 : T.items.length - 1) : T.focus + dir;
  if (i < 0 || i >= T.items.length) return toast(dir > 0 ? '已经是最南边的台了' : '已经是最北边的台了');
  T.focus = i;
  if (M.mode !== 'free') setMode('free');
  tuneTo(T.items[i]);
}

// 顶部一行：此刻的 UTC 时间，日落线经过哪里
function lineSpot(lon) {
  for (const c of globe?.meridian(lon, 4) || []) {
    if (c.lat < -45 || c.lat > 62) continue;
    const name = clusterPlace(c).name;
    if (name) return name;
  }
  return '';
}
function renderSky() {
  const now = new Date();
  const utc = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const dusk = wrapLon(sunLon(now) + 90);
  $('[data-bind="sky"]').innerHTML = `UTC ${utc} · 日落线正经过 <em>${esc(lineSpot(dusk) || lonWord(dusk))}</em> · 每小时西移 15°`;
}

// 追着日落 / 日出听：指针停在日落（日出）线上，每分钟跟着挪一点；
// 正在播的台被甩开 3° 以上（约 12 分钟）就换成线上的下一个地方
const MODE_TIP = {
  free: '拖动地球就是转旋钮，正中那条朱砂经线就是指针。',
  dusk: '指针停在正在日落的经线上，随地球自转慢慢西移。坐着不动，一晚上听遍半个地球。',
  dawn: '指针跟着第一缕阳光走，一路听各地的早间节目。',
};
const M = { mode: 'free', timer: 0, used: new Set(), busy: false };
const lineLon = () => wrapLon(sunLon() + (M.mode === 'dusk' ? 90 : -90));

function setMode(mode) {
  // 再点一次当前方式（或按空格触发了已选中的按钮）什么都不做，免得追日落时被换台
  if (!MODE_TIP[mode] || (M.started && mode === M.mode)) return;
  M.started = true;
  M.mode = mode;
  document.body.dataset.mode = mode;
  $$('#mode [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('[data-bind="mode-tip"]').textContent = MODE_TIP[mode];
  clearInterval(M.timer);
  if (mode === 'free') return;
  M.used.clear();
  chase(true);
  M.timer = setInterval(() => chase(false), 60000);
}

async function chase(force) {
  if (!globe || M.busy || M.mode === 'free') return;
  const lon = lineLon();
  const v = globe.view;
  globe.flyTo(Math.min(45, Math.max(-20, v.lat)), lon, Math.min(v.zoom, 1.2));
  // 用户自己暂停了（或定时停止了），地球照样跟着转，但不替他重新开播
  if (!force && P.status === 'paused') return;
  if (!force && P.cur?.lon != null && Math.abs(wrapLon(P.cur.lon - lon)) < 3 && P.status !== 'error') return;
  M.busy = true;
  try {
    for (let tries = 0; tries < 3; tries++) {
      let cands = [];
      for (const band of [3, 6, 12]) {
        cands = globe.meridian(lon, band).filter((c) => c.lat > -50 && c.lat < 64 && !M.used.has(`${c.lat},${c.lon}`));
        if (cands.length) break;
      }
      if (!cands.length) return;
      // 台多的几个地方里随机挑一个，免得每晚都是同一串城市
      const pick = cands[Math.floor(Math.random() * Math.min(5, cands.length))];
      M.used.add(`${pick.lat},${pick.lon}`);
      const pl = clusterPlace(pick);
      pl.name ||= lonWord(lon);
      if (await tuneTo({ ...pick, name: pl.name }, { quiet: true })) {
        toast(`${M.mode === 'dusk' ? '日落' : '日出'}线到了${pl.name}`);
        return;
      }
    }
  } finally { M.busy = false; }
}

// 用户自己转了地球，就交还旋钮；只是缩放不算
function takeWheel(kind) {
  if (M.mode === 'free' || kind === 'zoom') return;
  setMode('free');
  toast('回到自由调频');
}

export { renderScale, M, setMode, onTune, renderSky, takeWheel, T, renderTune, tuneTo, tuneStep };
