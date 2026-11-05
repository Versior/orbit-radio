// 播放器：连接电台（含 HLS）、失败自动换台、收藏与最近收听、音量、定时停止、读数区
import { $, $$, store, regionName, canLoad, toast } from './util.js';
import { api, httpsOnly, norm } from './radio.js';
import { S, P } from './state.js';
import { syncRows, currentList, renderPanel } from './panel.js';
import { globe, refreshAvoid, placeName } from './map.js';
import { renderScale, M, setMode } from './tune.js';
import { renderTrail } from './trail.js';
import { scheduleHash } from './share.js';

const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const CONNECT_TIMEOUT = 15000;
const SLEEP_OPTIONS = [0, 15, 30, 60];

let favSet = new Set(S.favs.map((s) => s.id));

const audio = $('#audio');

const STATUS_TEXT = { idle: '', loading: '连接中', live: '直播中', paused: '已暂停', error: '无法播放' };

// 收听时长：只在直播中计时，换台清零
let elapsedTimer = 0;
function renderElapsed() {
  const sec = P.liveSince ? Math.floor((Date.now() - P.liveSince) / 1000) : 0;
  const text = sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '';
  $$('[data-bind="elapsed"]').forEach((el) => { el.textContent = text; });
}

function setStatus(s) {
  P.status = s;
  document.body.dataset.status = s;
  $$('[data-bind="status"]').forEach((el) => { el.textContent = STATUS_TEXT[s]; });
  clearInterval(elapsedTimer);
  if (s === 'live') {
    P.skips = 0;
    P.liveSince ||= Date.now();
    elapsedTimer = setInterval(renderElapsed, 1000);
  } else if (s !== 'loading') P.liveSince = 0;
  if (s === 'live') songLoop(true); else if (s !== 'loading') songLoop(false);
  renderElapsed();
  clearTimeout(P.connectTimer);
  if (s === 'loading') P.connectTimer = setTimeout(fail, CONNECT_TIMEOUT);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s === 'live' || s === 'loading' ? 'playing' : 'paused';
}

// 正在播的歌名：直播中每 20 秒问一次服务端（见 lib/icy.mjs）。这个台不带歌名就不再问；
// 静态托管没有这个接口（404）就整个关掉；页面在后台时不问
const SONG = { timer: 0, id: '', off: new Set(), api: true };
const artistOf = (st) => [regionName(st.cc) || st.country, st.tags.slice(0, 2).join(' / ')].filter(Boolean).join(' · ');

function renderSong(title) {
  const el = $('[data-bind="song"]');
  el.textContent = title ? `♪ ${title}` : '';
  el.title = title;
  const meta = 'mediaSession' in navigator ? navigator.mediaSession.metadata : null;
  if (meta && P.cur) { meta.title = title || P.cur.name; meta.artist = title ? P.cur.name : artistOf(P.cur); }
}

async function pollSong() {
  const st = P.cur;
  if (!st || !SONG.api || SONG.off.has(st.id) || document.hidden || P.status !== 'live') return;
  try {
    const r = await fetch(`/api/now/${encodeURIComponent(st.id)}`, { signal: AbortSignal.timeout(12000) });
    if (r.status === 404) { SONG.api = false; return; }
    if (!r.ok) return;
    const v = await r.json();
    if (P.cur !== st) return;
    if (!v.supported) SONG.off.add(st.id);
    renderSong(typeof v.title === 'string' ? v.title : '');
  } catch { /* 下一轮再问 */ }
}

function songLoop(on) {
  if (on && SONG.timer && SONG.id === P.cur?.id) return; // 缓冲一下又恢复直播，不重新计时
  clearInterval(SONG.timer); SONG.timer = 0; SONG.id = '';
  if (!on || !P.cur) return;
  SONG.id = P.cur.id;
  pollSong();
  SONG.timer = setInterval(pollSong, 20000);
}

let hlsLoader = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HLS_CDN;
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsLoader = null; reject(new Error('hls.js 加载失败')); };
    document.head.appendChild(s);
  });
  return hlsLoader;
}

function teardown() {
  if (P.hls) { P.hls.destroy(); P.hls = null; }
  audio.removeAttribute('src');
  audio.load();
}

async function start(url) {
  const token = ++P.token;
  P.starting = true;
  teardown();
  setStatus('loading');
  const isHls = P.cur.hls || /\.m3u8($|\?)/i.test(url);
  if (isHls && !audio.canPlayType('application/vnd.apple.mpegurl')) {
    let Hls = null;
    try { Hls = await loadHls(); } catch { /* 按普通流兜底 */ }
    if (token !== P.token) return;
    if (Hls?.isSupported()) {
      const hls = new Hls();
      P.hls = hls;
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal && token === P.token) fail(); });
      hls.loadSource(url);
      hls.attachMedia(audio);
    } else audio.src = url;
  } else audio.src = url;
  try {
    await audio.play();
  } catch (e) {
    if (token !== P.token) return;
    if (e.name === 'NotAllowedError') { P.starting = false; setStatus('paused'); } else if (e.name !== 'AbortError') fail();
  }
}

function fail() {
  const st = P.cur;
  if (!st || P.status === 'error' || P.status === 'paused') return;
  if (!P.fallback && st.url2 && st.url2 !== st.url) { P.fallback = true; start(st.url2); return; }
  P.token++; P.starting = false;
  teardown();
  setStatus('error');
  S.broken.add(st.id);
  syncRows();
  // 列表里还有别的台时自动换下一个；连续失败 3 次就停下，交给用户决定
  const q = P.queue.length ? P.queue : currentList();
  if (P.skips < 3 && q.some((s) => s.id !== st.id && !S.broken.has(s.id))) {
    P.skips += 1;
    toast(`「${st.name}」连不上，换到下一个`);
    return step(1);
  }
  toast(`「${st.name}」暂时连不上`, '换一个', () => { P.skips = 0; step(1); });
}

function playStation(st, queue, { fly = true } = {}) {
  if (!st) return;
  if (queue) P.queue = queue.slice();
  if (P.cur?.id === st.id && P.status !== 'error') return toggle();
  P.cur = st;
  P.fallback = false;
  P.liveSince = 0;
  store.set('last', st);
  songLoop(false);
  renderPlayer();
  renderSong('');
  syncRows();
  start(st.url);
  addRecent(st);
  if (fly && st.lat !== null) globe?.flyTo(st.lat, st.lon, Math.min(2.6, Math.max(globe.zoom, 1.6)));
  api(`/json/url/${encodeURIComponent(st.id)}`).catch(() => {}); // 官方要求的点击上报
}

function pause() { P.token++; P.starting = false; teardown(); setStatus('paused'); }
function resume() { if (!P.cur) return; P.fallback = false; start(P.cur.url); }
function toggle() { if (!P.cur) return shuffle(); if (P.status === 'live' || P.status === 'loading') pause(); else resume(); }

function step(dir) {
  const q = P.queue.length ? P.queue : currentList();
  if (!q.length) return shuffle();
  let i = q.findIndex((s) => s.id === P.cur?.id);
  for (let n = 0; n < q.length; n++) {
    i = (i + dir + q.length) % q.length;
    if (!S.broken.has(q[i].id) && q[i].id !== P.cur?.id) return playStation(q[i]);
  }
  shuffle();
}

// 随机一个带坐标的台，地球飞过去
async function shuffle() {
  if (M.mode !== 'free') setMode('free');
  try {
    const list = (await api('/json/stations/search', httpsOnly({ order: 'random', has_geo_info: 'true', hidebroken: 'true', limit: 20 })))
      .map(norm).filter((s) => s.url && !S.broken.has(s.id) && s.id !== P.cur?.id);
    if (!list.length) return toast('暂时没有可播的台');
    playStation(list[0], list);
    const where = [list[0].state, regionName(list[0].cc) || list[0].country].filter(Boolean).join('，');
    if (where) toast(`信号来自 ${where}`);
  } catch { toast('电台目录暂时连不上'); }
}

// 记下收听时间，地球上的足迹按它排先后
function addRecent(st) {
  S.recents = [{ ...st, at: Date.now() }, ...S.recents.filter((s) => s.id !== st.id)].slice(0, 40);
  store.set('recents', S.recents);
  renderTrail();
}

function toggleFav(st, btn) {
  if (!st) return;
  if (favSet.has(st.id)) S.favs = S.favs.filter((s) => s.id !== st.id); else S.favs = [st, ...S.favs];
  favSet = new Set(S.favs.map((s) => s.id));
  store.set('favs', S.favs);
  if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
  if (S.panel === 'fav') renderPanel(); else syncRows();
  const on = !!P.cur && favSet.has(P.cur.id);
  $$('.fav-btn').forEach((b) => b.classList.toggle('on', on));
  renderFavCount();
}

function renderFavCount() { $('[data-bind="fav-n"]').textContent = S.favs.length; }

function renderPlayer() {
  const st = P.cur;
  if (!st) return;
  document.body.classList.add('has-player');
  refreshAvoid();
  globe?.setMarker(st.lat, st.lon);
  renderScale();
  $$('[data-bind="name"]').forEach((el) => { el.textContent = st.name; el.title = st.name; });
  // 有坐标时用地图上的中文省/州名，比 state 字段里的 "Szechuan" 这类写法好认
  const reg = st.lat !== null ? globe?.regionAt(st.lat, st.lon) : null;
  const place = reg ? placeName(reg, globe.countryAt(st.lat, st.lon)) : [st.state, regionName(st.cc) || st.country].filter(Boolean).join('，');
  $('[data-bind="place"]').textContent = place || '未知地点';
  const kbps = st.bitrate ? `${st.bitrate} kbps` : '';
  $('[data-bind="tags"]').textContent = [...st.tags.slice(0, 3), [st.codec, kbps].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const home = $('[data-bind="home"]');
  home.hidden = !/^https?:\/\//.test(st.homepage);
  if (!home.hidden) home.href = st.homepage;
  $$('.fav-btn').forEach((b) => b.classList.toggle('on', favSet.has(st.id)));
  document.title = `${st.name} · 环听 Orbit`;
  scheduleHash();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: st.name,
      artist: artistOf(st),
      album: '环听 Orbit',
      artwork: canLoad(st.favicon) ? [{ src: st.favicon }] : [],
    });
  }
}

function setVolume(v) {
  v = Math.min(1, Math.max(0, Number(v)));
  audio.volume = v;
  if (v > 0) audio.muted = false;
  store.set('vol', v);
  $$('[data-bind="vol"]').forEach((r) => { r.value = v; r.style.setProperty('--v', v * 100 + '%'); });
  document.body.classList.toggle('is-muted', audio.muted || v === 0);
}

function toggleMute() {
  audio.muted = !audio.muted;
  document.body.classList.toggle('is-muted', audio.muted || audio.volume === 0);
}

function cycleSleep() {
  P.sleepIdx = (P.sleepIdx + 1) % SLEEP_OPTIONS.length;
  const min = SLEEP_OPTIONS[P.sleepIdx];
  clearTimeout(P.sleepTimer); clearInterval(P.sleepTick);
  P.sleepAt = 0;
  if (min) {
    P.sleepAt = Date.now() + min * 60000;
    P.sleepTimer = setTimeout(() => { setMode('free'); pause(); P.sleepIdx = 0; P.sleepAt = 0; clearInterval(P.sleepTick); renderSleep(); toast('晚安，电台已停止'); }, min * 60000);
    P.sleepTick = setInterval(renderSleep, 20000);
    toast(`${min} 分钟后自动停止`);
  }
  renderSleep();
}

function renderSleep() {
  const el = $('[data-bind="sleep"]');
  const left = P.sleepAt ? Math.max(1, Math.ceil((P.sleepAt - Date.now()) / 60000)) : 0;
  el.textContent = left ? String(left) : '';
  el.parentElement.title = left ? `${left} 分钟后停止（再点切换）` : '定时停止';
  el.parentElement.classList.toggle('active', !!left);
}

export { favSet, playStation, audio, setStatus, fail, pause, resume, toggle, step, shuffle, toggleFav, renderFavCount, renderPlayer, setVolume, toggleMute, cycleSleep, renderSleep };
