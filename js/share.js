// 分享链接：网址 # 后面记着调到的经线和正在播的台（#lon=116.4&lat=30.0&st=电台uuid），打开就是同一个画面。
// 浏览器不允许没点过页面就自动出声，所以分享的台先摆好、暂停着，提示里点一下「收听」
import { P } from './state.js';
import { toast, isMobile } from './util.js';
import { fetchStation } from './radio.js';
import { globe } from './map.js';
import { renderPlayer, setStatus, resume } from './player.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 打开页面时的 #，要在地球转起来、自动改写地址之前先记下
const INITIAL = location.hash;
let timer = 0;
let ready = false;

function hashNow() {
  const v = globe?.view;
  if (!v) return '';
  const p = new URLSearchParams({ lon: v.lon.toFixed(1), lat: v.lat.toFixed(1) });
  if (P.cur?.id && UUID_RE.test(P.cur.id)) p.set('st', P.cur.id);
  return '#' + p;
}

// 调频、换台后半秒更新地址栏（replaceState 不产生历史记录，后退键不受影响）
function scheduleHash() {
  if (!ready) return;
  clearTimeout(timer);
  timer = setTimeout(() => { const h = hashNow(); if (h && h !== location.hash) history.replaceState(null, '', h); }, 500);
}

async function shareLink() {
  const url = location.origin + location.pathname + hashNow();
  const title = P.cur ? `${P.cur.name} · 环听 Orbit` : '环听 Orbit';
  if (navigator.share && isMobile()) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制，朋友打开就是这条经线、这个台');
  } catch {
    history.replaceState(null, '', hashNow());
    toast('没法自动复制，地址栏里就是这个链接');
  }
}

// 启动时读一次分享进来的 #
async function applyHash() {
  ready = true;
  const p = new URLSearchParams(INITIAL.slice(1));
  const lon = Number(p.get('lon')); const lat = Number(p.get('lat'));
  const hasLon = p.has('lon') && Number.isFinite(lon) && Math.abs(lon) <= 180;
  const hasLat = p.has('lat') && Number.isFinite(lat) && Math.abs(lat) <= 80;
  if (hasLon) globe?.flyTo(hasLat ? lat : 20, lon, 1, 900);
  const id = p.get('st');
  if (!id || !UUID_RE.test(id)) return;
  if (id === P.cur?.id) return;
  try {
    const st = await fetchStation(id);
    if (!st) return toast('分享的电台已经下线了');
    P.cur = st; P.queue = [st];
    renderPlayer();
    setStatus('paused');
    if (!hasLon && st.lat != null) globe?.flyTo(st.lat, st.lon, 1, 900);
    toast(`朋友分享的台：${st.name}`, '收听', resume);
  } catch { toast('电台目录暂时连不上，分享的台没取到'); }
}

export { scheduleHash, shareLink, applyHash };
