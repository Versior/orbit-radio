// AI 找台：一句话 → 查询计划（大模型或本地理解）→ 分组结果；找相似的台；我附近
import { $, esc, regionName, guessRegion, toast } from './util.js';
import { api, httpsOnly, norm } from './radio.js';
import { S, P, A } from './state.js';
import { side, rowHTML, headHTML, renderPanel } from './panel.js';
import { globe } from './map.js';
import { localPlan, remotePlan, NEAR_RE } from '../intent.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const AI_ERR = { timeout: 'AI 想得太久了', rate_limited: '问得有点快', busy: 'AI 正忙', network: '连不上 AI 服务', unconfigured: '大模型未配置' };

function tasteProfile() {
  const tags = new Map(); const countries = new Map();
  const add = (list, w) => list.forEach((s) => {
    s.tags.slice(0, 3).forEach((t) => { const k = t.toLowerCase(); tags.set(k, (tags.get(k) || 0) + w); });
    if (s.cc) countries.set(s.cc, (countries.get(s.cc) || 0) + w);
  });
  add(S.favs, 2); add(S.recents.slice(0, 20), 1);
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return { tags: top(tags, 4), countries: top(countries, 3) };
}

function buildContext(prompt, useLocation) {
  const now = new Date();
  const region = guessRegion();
  const ctx = {
    hour: now.getHours(), weekday: WEEKDAYS[now.getDay()],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language,
    region, regionLabel: regionName(region), taste: tasteProfile(),
  };
  if (A.location && (useLocation || NEAR_RE.test(prompt))) ctx.location = A.location;
  if (P.cur) ctx.current = { name: P.cur.name, countrycode: P.cur.cc, cc: P.cur.cc, tags: P.cur.tags.slice(0, 4) };
  return ctx;
}

function planParams(q) {
  const p = { hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: 16 };
  if (q.countrycode) p.countrycode = q.countrycode;
  if (q.tag) p.tag = q.tag;
  if (q.language) p.language = q.language;
  if (q.name) p.name = q.name;
  if (q.geo) { p.geo_lat = q.geo.lat; p.geo_long = q.geo.lon; p.geo_distance = Math.round(q.geo.km * 1000); }
  return httpsOnly(p);
}

// 搜不到时逐步放宽：城市→国家，去掉语言，最后去掉风格
async function searchQuery(q) {
  const base = { countrycode: q.countrycode, tag: q.tag, language: q.language, name: q.name, geo: q.geo };
  const attempts = [base];
  if (base.geo) attempts.push({ ...base, geo: undefined });
  if (base.language && (base.tag || base.countrycode)) attempts.push({ ...base, geo: undefined, language: undefined });
  if (base.tag && (base.countrycode || base.geo)) attempts.push({ countrycode: base.countrycode, geo: base.countrycode ? undefined : base.geo });
  const tried = new Set();
  for (let i = 0; i < attempts.length; i++) {
    const params = planParams(attempts[i]);
    const key = JSON.stringify(params);
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      const list = (await api('/json/stations/search', params)).map(norm).filter((s) => s.url);
      if (list.length) return { list, relaxed: i > 0 };
    } catch { /* 换下一种条件 */ }
  }
  return { list: [], relaxed: false };
}

async function runPlan(plan) {
  const results = await Promise.all(plan.queries.map(searchQuery));
  const seen = new Set();
  return results.map((r, i) => ({
    ...plan.queries[i], relaxed: r.relaxed,
    stations: r.list.filter((s) => s.id !== P.cur?.id && !seen.has(s.url) && seen.add(s.url)).slice(0, 8),
  })).filter((g) => g.stations.length);
}

function enterAI(prompt, stepText) {
  S.place = null; globe?.select(null, null);
  A.busy = true; A.result = null; A.prompt = prompt; A.step = stepText;
  S.panel = 'ai';
  $('#ask').classList.add('busy');
  renderPanel();
}

async function showPlan(prompt, plan, source, seq) {
  A.step = '正在全球电台里找';
  if (S.panel === 'ai' && A.busy) renderPanel();
  const groups = await runPlan(plan);
  if (seq !== A.seq) return false;
  A.busy = false;
  A.result = { prompt, plan, groups, source };
  $('#ask').classList.remove('busy');
  renderAIResult(true);
  side.scrollTop = 0;
  const spot = groups.flatMap((g) => g.stations).find((s) => s.lat !== null);
  if (spot) globe?.flyTo(spot.lat, spot.lon, 1.8);
  return true;
}

async function askAI(prompt, { follow = false, useLocation = false } = {}) {
  prompt = prompt.trim().slice(0, 200);
  if (!prompt) return;
  const seq = ++A.seq;
  if (!follow) { A.history = []; A.lastPrompt = ''; }
  enterAI(prompt, '正在理解');
  const ctx = buildContext(prompt, useLocation);
  const merged = follow && A.lastPrompt ? `${A.lastPrompt} ${prompt}` : prompt;
  let plan = null; let source = 'local';
  if (A.enabled) {
    try { plan = await remotePlan(prompt, ctx, A.history); source = 'ai'; } catch (e) {
      if (seq !== A.seq) return;
      toast(`${AI_ERR[e.code] || 'AI 暂时不可用'}，先用本地理解`);
    }
  }
  if (seq !== A.seq) return;
  plan ??= localPlan(merged, ctx);
  if (!(await showPlan(prompt, plan, source, seq))) return;
  const brief = JSON.stringify({ reply: plan.reply, queries: plan.queries.map(({ reason, ...q }) => q) });
  A.history = [...A.history, { role: 'user', content: prompt }, { role: 'assistant', content: brief }].slice(-6);
  A.lastPrompt = merged;
}

function similar() {
  const st = P.cur;
  if (!st) return;
  const tag = st.tags[0]?.toLowerCase();
  const where = regionName(st.cc) || st.country;
  const queries = [];
  if (tag) queries.push({ title: `同风格 · ${tag}`, reason: '和正在播放的台风格一样', tag });
  if (tag && st.cc) queries.push({ title: `${where} · ${tag}`, reason: '同一个国家、同一种风格', countrycode: st.cc, tag });
  if (st.cc) queries.push({ title: `更多${where}的台`, reason: `${where}此刻正在热播`, countrycode: st.cc });
  if (!queries.length) return toast('这个台信息太少，找不到相似的');
  const prompt = `和「${st.name}」相似的台`;
  const seq = ++A.seq;
  A.history = []; A.lastPrompt = [where, tag].filter(Boolean).join(' ');
  enterAI(prompt, '正在找气质相近的台');
  showPlan(prompt, { reply: `这些台和「${st.name}」气质相近。`, queries, followups: ['更安静一点', '换个国家', '热闹一些'] }, 'local', seq);
}

function clearAI() {
  A.seq++; A.busy = false; A.result = null; A.history = []; A.lastPrompt = '';
  $('#ask').classList.remove('busy');
}

function typeText(el, text) {
  if (!el) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = text; return; }
  const chars = Array.from(text);
  let n = 0;
  el.classList.add('typing');
  const tick = () => {
    if (!el.isConnected) return;
    el.textContent = chars.slice(0, ++n).join('');
    if (n < chars.length) setTimeout(tick, 26); else el.classList.remove('typing');
  };
  tick();
}

function renderAIResult(animate) {
  const { prompt, plan, groups, source } = A.result;
  const follow = plan.followups.map((f) => `<button class="chip" data-follow="${esc(f)}">${esc(f)}</button>`).join('');
  let i = 0;
  const body = groups.length
    ? groups.map((g, gi) => `<section class="group" style="--d:${gi}">
        <header><div><h3>${esc(g.title)}</h3><p>${esc(g.reason)}${g.relaxed ? ' · 条件放宽了一点' : ''}</p></div>
        <button class="ic sm" data-act="play-group" data-g="${gi}" aria-label="播放这组"><svg class="f"><use href="#i-play"/></svg></button></header>
        <div class="list">${g.stations.map((s) => rowHTML(s, i++)).join('')}</div>
      </section>`).join('')
    : '<p class="empty">这次没找到合适的台，换个说法试试。</p>';
  side.innerHTML = headHTML(`<span class="coord">${esc(prompt)} · ${source === 'ai' ? esc(A.model) : '本地理解'}</span><h2 id="aiText">${animate ? '' : esc(plan.reply)}</h2>`, '',
    follow ? `<div class="follow">${follow}</div>` : '') + body;
  if (animate) typeText($('#aiText'), plan.reply);
}

function locate() {
  if (A.location) return askAI('我附近的电台', { useLocation: true });
  if (!navigator.geolocation) { toast('浏览器不支持定位，按你的地区来找'); return askAI('本地电台'); }
  const btn = $('[data-act="locate"]');
  btn.classList.add('busy');
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.classList.remove('busy'); btn.classList.add('on');
    A.location = { lat: Math.round(pos.coords.latitude * 10) / 10, lon: Math.round(pos.coords.longitude * 10) / 10 };
    askAI('我附近的电台', { useLocation: true });
  }, () => {
    btn.classList.remove('busy');
    toast('没拿到位置，按你的地区来找');
    askAI('本地电台');
  }, { timeout: 8000, maximumAge: 600000 });
}

async function loadAIStatus() {
  try {
    const r = await fetch('/api/ai/status', { signal: AbortSignal.timeout(4000) });
    const s = r.ok ? await r.json() : null;
    A.enabled = !!s?.enabled; A.model = s?.model || '';
  } catch { A.enabled = false; }
}

export { clearAI, renderAIResult, askAI, similar, locate, loadAIStatus };
