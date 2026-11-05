// 右侧内容面板：电台行与封面、收藏/足迹列表、地点面板（附近 / 省州 / 全国）
import { $, $$, esc, regionName, hashOf, letterOf, canLoad, toast } from './util.js';
import { nearbyStations, regionStations, countryStations } from './radio.js';
import { S, P, A } from './state.js';
import { favSet, playStation } from './player.js';
import { clearAI, renderAIResult } from './ai.js';
import { globe, REGION_COUNT, placeName } from './map.js';
import { trailSummary } from './trail.js';

const side = $('#side');

// 没有台标时的封面色：夜空蓝黑、纸色、铜色，少量朱砂，和浑天仪一个色调
const PALETTE = [
  ['#161b25', '#eee6d4'], ['#1f2633', '#eee6d4'], ['#e9dfc9', '#10141c'], ['#2a3140', '#eee6d4'],
  ['#e2442b', '#f7ebe2'], ['#10141c', '#c8a26a'], ['#c8a26a', '#10141c'], ['#232a38', '#e98a74'],
];
const colorOf = (st) => PALETTE[hashOf(st.id) % PALETTE.length];

function coverHTML(st, cls = '', extra = '') {
  const [bg, fg] = colorOf(st);
  const plate = canLoad(st.favicon) ? `<span class="plate"><img src="${esc(st.favicon)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>` : '';
  const foot = [st.cc, st.bitrate ? st.bitrate + 'K' : ''].filter(Boolean).join(' · ');
  return `<span class="cover ${cls}" style="--cv-bg:${bg};--cv-fg:${fg}">${plate}<span class="cv-name">${esc(st.name)}</span><span class="cv-foot">${esc(foot)}</span><span class="cv-letter">${esc(letterOf(st.name))}</span>${extra}</span>`;
}

function metaOf(st) {
  const tag = st.tags.find((t) => t.length <= 16);
  return [regionName(st.cc) || st.country, tag].filter(Boolean).join(' · ');
}

function rowHTML(st, i) {
  const cls = ['row', P.cur?.id === st.id && 'is-current', favSet.has(st.id) && 'is-fav', S.broken.has(st.id) && 'is-broken'].filter(Boolean).join(' ');
  const eq = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
  return `<article class="${cls}" data-id="${esc(st.id)}" style="--i:${i % 16}" tabindex="0" role="button" aria-label="播放 ${esc(st.name)}">
    ${coverHTML(st, 'sm', eq)}
    <span class="row-body"><b>${esc(st.name)}</b><small>${esc(metaOf(st))}</small></span>
    <button class="fav" data-act="fav" aria-label="收藏"><svg><use href="#i-heart"/></svg></button>
  </article>`;
}

const skeletonHTML = (n) => Array.from({ length: n }, () => '<div class="row skeleton"><span class="cover sm"></span><span class="row-body"><span class="line"></span><span class="line"></span></span></div>').join('');

function syncRows() {
  for (const el of $$('.row[data-id]')) {
    const id = el.dataset.id;
    el.classList.toggle('is-current', P.cur?.id === id);
    el.classList.toggle('is-fav', favSet.has(id));
    el.classList.toggle('is-broken', S.broken.has(id));
  }
}

const aiStations = () => (A.result ? A.result.groups.flatMap((g) => g.stations) : []);

function currentList() {
  if (S.panel === 'fav') return S.favs;
  if (S.panel === 'recent') return S.recents;
  if (S.panel === 'place') return placeList();
  if (S.panel === 'ai') return aiStations();
  return [];
}

function stationById(id) {
  const placeAll = S.place ? Object.values(S.place.scopes).flatMap((x) => x.list) : [];
  return [currentList(), placeAll, aiStations(), S.favs, S.recents, P.queue].reduce((hit, list) => hit || list.find((s) => s.id === id), null);
}

function headHTML(title, sub = '', extra = '') {
  return `<div class="side-head">
      <div class="side-title">${title}${sub ? `<p>${sub}</p>` : ''}</div>
      <button class="ic" data-act="close-panel" aria-label="关闭"><svg><use href="#i-x"/></svg></button>
    </div>${extra}`;
}

// 面板收起时先播完退场动画再隐藏
let closeTimer = 0;
function renderPanel() {
  const open = !!S.panel;
  document.body.classList.toggle('panel-open', open);
  $$('[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === S.panel));
  globe?.relayout();
  clearTimeout(closeTimer);
  if (!open) {
    if (!side.hidden) {
      side.classList.add('closing');
      closeTimer = setTimeout(() => { side.hidden = true; side.classList.remove('closing'); }, 280);
    }
    return;
  }
  const entering = side.hidden || side.classList.contains('closing');
  side.classList.remove('closing');
  side.hidden = false;
  if (entering) { side.classList.remove('enter'); void side.offsetWidth; side.classList.add('enter'); }

  if (S.panel === 'fav' || S.panel === 'recent') {
    const list = S.panel === 'fav' ? S.favs : S.recents;
    const title = S.panel === 'fav' ? '收藏' : '足迹';
    const trail = S.panel === 'recent' ? trailSummary() : '';
    side.innerHTML = headHTML(title, [list.length ? `${list.length} 个电台` : '', trail].filter(Boolean).map(esc).join(' · '))
      + (list.length ? `<div class="list">${list.map(rowHTML).join('')}</div>`
        : `<p class="empty">${S.panel === 'fav' ? '听到喜欢的台，点一下 ♥ 留住它。' : '还没有收听记录。'}</p>`);
    return;
  }

  if (S.panel === 'place') {
    const pl = S.place;
    const coord = `${Math.abs(pl.lat).toFixed(1)}°${pl.lat >= 0 ? 'N' : 'S'}  ${Math.abs(pl.lon).toFixed(1)}°${pl.lon >= 0 ? 'E' : 'W'}`;
    const cur = pl.scopes[pl.scope];
    const chips = SCOPES.filter((k) => pl.labels[k]).map((k) => `<button class="chip${k === pl.scope ? ' on' : ''}" data-scope="${k}">${esc(pl.labels[k])}</button>`).join('');
    const sub = cur.loading ? '正在调频…' : `${esc(cur.sub)} · ${cur.list.length} 个电台`;
    side.innerHTML = headHTML(`<span class="coord">${coord}</span><h2>${esc(pl.title)}</h2>`, sub, `<div class="follow scopes">${chips}</div>`)
      + `<div class="list">${cur.loading ? skeletonHTML(5) : cur.list.length ? cur.list.map(rowHTML).join('') : '<p class="empty">这个范围里暂时没有找到电台。</p>'}</div>`;
    return;
  }

  if (S.panel === 'ai') {
    if (A.busy) {
      side.innerHTML = headHTML(`<span class="coord">${esc(A.prompt)}</span><h2 class="muted"><span class="dots"><i></i><i></i><i></i></span>${esc(A.step)}</h2>`) + `<div class="list">${skeletonHTML(5)}</div>`;
      return;
    }
    renderAIResult(false);
  }
}

function openPanel(name) {
  if (S.panel === name && (name === 'fav' || name === 'recent')) return closePanel();
  if (name !== 'place') { S.place = null; globe?.select(null, null); }
  if (name !== 'ai') clearAI();
  S.panel = name;
  renderPanel();
  side.scrollTop = 0;
}

function closePanel() {
  S.panel = null; S.place = null;
  clearAI();
  globe?.select(null, null);
  renderPanel();
}

// ---------- 地点面板：附近 / 省州 / 全国 三个范围 ----------
const SCOPES = ['near', 'region', 'country'];

const placeList = () => (S.place ? S.place.scopes[S.place.scope].list : []);

async function loadScope(name) {
  const pl = S.place;
  const box = pl.scopes[name];
  if (!box.loading && box.done) return box;
  box.loading = true;
  const seq = S.seq;
  const got = name === 'near' ? await nearbyStations(pl.lat, pl.lon)
    : name === 'region' ? await regionStations(pl.region)
      : await countryStations(pl.country.iso, pl.country.name);
  if (seq !== S.seq || S.place !== pl) return null;
  const seen = new Set();
  Object.assign(box, got, { list: got.list.filter((s) => !seen.has(s.url) && seen.add(s.url)), loading: false, done: true });
  return box;
}

async function setScope(name) {
  const pl = S.place;
  if (!pl || !pl.labels[name] || pl.scope === name) return;
  pl.scope = name;
  renderPanel();
  if (await loadScope(name)) renderPanel();
}

// 点光点、地标、省州或国家：飞过去、列出电台、直接开播
async function openPlace(pick) {
  if (pick.mark?.quip) { toast(pick.mark.quip); return; }
  const { lat, lon } = pick;
  clearAI();
  const seq = ++S.seq;
  const region = pick.meta?.region ? globe.region(pick.meta.region) : globe.regionAt(lat, lon);
  const country = globe.countryAt(lat, lon) || (region && globe.country(region.iso));
  const hasRegion = !!region && (REGION_COUNT.get(region.id) || 0) > 0;
  const labels = { near: '附近', region: hasRegion ? region.name : '', country: country?.iso ? country.name : '' };
  // 点的是带坐标的光点或地标就先看附近；点的是空地或按省州名收录的点就看整个省/州
  const first = (pick.kind === 'station' && !pick.meta) || pick.mark ? 'near' : hasRegion ? 'region' : 'near';
  S.place = {
    lat, lon, region, country, labels, scope: first,
    title: pick.mark ? `${pick.mark.city} · ${pick.mark.name}` : placeName(region, country) || '这片区域',
    scopes: Object.fromEntries(SCOPES.map((k) => [k, { list: [], sub: '', loading: k === first, done: false }])),
  };
  S.panel = 'place';
  globe.select(lat, lon, region?.id || 0);
  globe.flyTo(lat, lon, Math.max(globe.zoom, 2.4));
  renderPanel();
  side.scrollTop = 0;
  // 当前范围台太少就依次放宽：附近 → 省州 → 全国。附近不到 5 个台、又有省州可选时，直接看全省州
  let fallback = '';
  for (const k of SCOPES.slice(SCOPES.indexOf(first))) {
    if (!labels[k]) continue;
    S.place.scope = k;
    const box = await loadScope(k);
    if (!box) return;
    if (box.list.length && !fallback) fallback = k;
    if (box.list.length >= (k === 'near' && labels.region ? 5 : 1)) { fallback = k; break; }
  }
  if (fallback) S.place.scope = fallback;
  if (seq !== S.seq || !S.place) return;
  renderPanel();
  const list = placeList();
  if (!list.length) { closePanel(); return toast('这里暂时收不到电台信号'); }
  const top = list.find((s) => !S.broken.has(s.id));
  if (top && P.cur?.id !== top.id) playStation(top, list, { fly: false });
}

export { syncRows, currentList, renderPanel, side, rowHTML, headHTML, openPlace, stationById, openPanel, closePanel, setScope };
