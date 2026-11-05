// 环听 Orbit · 转动地球收听全球电台。数据来自 Radio Browser（https://api.radio-browser.info）
// 这里只负责把各模块接起来：点击、键盘、音频事件和启动顺序。各部分的逻辑见 js/ 目录
import { $, $$, esc, store } from './js/util.js';
import { S, P, A } from './js/state.js';
import { audio, setStatus, fail, playStation, pause, resume, toggle, step, shuffle, toggleFav, renderFavCount, renderPlayer, setVolume, toggleMute, cycleSleep, renderSleep } from './js/player.js';
import { side, currentList, stationById, openPanel, closePanel, setScope } from './js/panel.js';
import { askAI, similar, locate, loadAIStatus } from './js/ai.js';
import { globe, homeView, initGlobe } from './js/map.js';
import { T, renderTune, renderScale, tuneTo, tuneStep, renderSky, M, setMode, takeWheel } from './js/tune.js';
import { renderTrail } from './js/trail.js';
import { shareLink, applyHash } from './js/share.js';
import { EXAMPLES } from './intent.js';

document.addEventListener('click', (e) => {
  P.skips = 0; // 用户自己点过之后，重新允许自动换台
  const actEl = e.target.closest('[data-act]');
  const row = e.target.closest('.row[data-id]');
  const scope = e.target.closest('[data-scope]');
  if (scope) return setScope(scope.dataset.scope);
  const tuneEl = e.target.closest('[data-tune]');
  if (tuneEl) {
    const i = Number(tuneEl.dataset.tune);
    if (!T.items[i]) return;
    T.focus = i;
    if (M.mode !== 'free') setMode('free');
    return tuneTo(T.items[i]);
  }
  const modeEl = e.target.closest('#mode [data-mode]');
  if (modeEl) return setMode(modeEl.dataset.mode);
  if (actEl?.dataset.act === 'fav' && row) return toggleFav(stationById(row.dataset.id), actEl);
  if (row) return playStation(stationById(row.dataset.id), currentList());

  const ask = e.target.closest('[data-ask]');
  if (ask) { $('#askInput').value = ask.dataset.ask; $('#askInput').blur(); return askAI(ask.dataset.ask); }
  const follow = e.target.closest('[data-follow]');
  if (follow) return askAI(follow.dataset.follow, { follow: true });
  const panelBtn = e.target.closest('[data-panel]');
  if (panelBtn) return openPanel(panelBtn.dataset.panel);
  if (!actEl) return;

  switch (actEl.dataset.act) {
    case 'toggle': return toggle();
    case 'prev': return step(-1);
    case 'next': return step(1);
    case 'shuffle': return shuffle();
    case 'close-panel': return closePanel();
    case 'fav-cur': return toggleFav(P.cur, actEl);
    case 'mute': return toggleMute();
    case 'sleep': return cycleSleep();
    case 'locate': return locate();
    case 'similar': return similar();
    case 'share': return shareLink();
    case 'play-group': {
      const g = A.result?.groups[Number(actEl.dataset.g)];
      if (g) playStation(g.stations[0], g.stations);
    }
  }
});

$('#ask').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#askInput').blur();
  askAI($('#askInput').value);
});

side.addEventListener('keydown', (e) => {
  const row = e.target.closest('.row[data-id]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playStation(stationById(row.dataset.id), currentList()); }
});

// 台标加载失败或尺寸太小，退回文字封面
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.closest('.plate')?.remove(); }, true);
document.addEventListener('load', (e) => {
  const plate = e.target.tagName === 'IMG' && e.target.closest('.plate');
  if (!plate) return;
  if (e.target.naturalWidth < 32) plate.remove(); else plate.classList.add('ok');
}, true);

$$('[data-bind="vol"]').forEach((r) => r.addEventListener('input', () => setVolume(r.value)));

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input:not([type="range"]), textarea');
  // 音量滑块获得焦点时，方向键留给它调音量
  if (e.target.matches('input[type="range"]') && e.key.startsWith('Arrow')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return $('#askInput').focus(); }
  if (e.key === 'Escape') {
    if (typing) e.target.blur(); else if (S.panel) closePanel();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case '/': e.preventDefault(); return $('#askInput').focus();
    case ' ': if (e.target.matches('button, a, [role="button"]')) return; e.preventDefault(); return toggle();
    case 'ArrowRight': if (P.cur) { e.preventDefault(); step(1); } return;
    case 'ArrowLeft': if (P.cur) { e.preventDefault(); step(-1); } return;
    case 'ArrowUp': e.preventDefault(); return tuneStep(-1);
    case 'ArrowDown': e.preventDefault(); return tuneStep(1);
    case 'm': case 'M': return toggleMute();
    case 'f': case 'F': return toggleFav(P.cur);
    case 's': case 'S': return shuffle();
    case '+': case '=': return globe?.zoomBy(1.4);
    case '-': case '_': return globe?.zoomBy(1 / 1.4);
    case 'h': case 'H': { const [la, lo] = homeView(); return globe?.flyTo(la, lo, 1); }
    // 键盘转旋钮：[ 往西、] 往东，每次 5°；按住 Shift（{ }）每次 1°
    case '[': case '{': case ']': case '}': {
      e.preventDefault();
      takeWheel('drag');
      const deg = e.key === '[' || e.key === '{' ? -1 : 1;
      return globe?.turn(deg * (e.key === '{' || e.key === '}' ? 1 : 5));
    }
  }
});

audio.addEventListener('playing', () => { P.starting = false; setStatus('live'); });
audio.addEventListener('waiting', () => { if (!audio.paused && P.status === 'live') setStatus('loading'); });
audio.addEventListener('pause', () => { if (!P.starting && P.status !== 'error') setStatus('paused'); });
audio.addEventListener('error', () => { if (audio.getAttribute('src') && !P.hls) fail(); });

if ('mediaSession' in navigator) {
  const handlers = { play: resume, pause, stop: pause, previoustrack: () => step(-1), nexttrack: () => step(1) };
  for (const [k, fn] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch { /* 不支持的动作 */ } }
}

// ---------- 启动 ----------
$('#suggest').innerHTML = '<p class="label">试试这样问</p>'
  + '<button type="button" data-act="locate"><svg><use href="#i-pin"/></svg>我附近的电台</button>'
  + EXAMPLES.map((t) => `<button type="button" data-ask="${esc(t)}"><svg><use href="#i-spark"/></svg>${esc(t)}</button>`).join('');
setVolume(store.get('vol', 0.8));
renderSleep();
renderFavCount();
setMode('free');
if (P.cur) { renderPlayer(); setStatus('paused'); } // 恢复上次的台，但不自动播放
loadAIStatus();
initGlobe().then(() => {
  renderTrail();
  applyHash();
  // 刻度上的当地时间、顶部的日落线、足迹的 12 小时窗口每分钟更新一次
  setInterval(() => { renderTune(); renderScale(true); renderSky(); renderTrail(); }, 60000);
});

