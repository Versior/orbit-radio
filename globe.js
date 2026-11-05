// 浑天仪式的点阵地球：WebGL 画球面和电台光点（globe-gl.js），2D 叠层画赤道环、调谐经线、地名、地标和调频弧线。
// 赤道环是调频刻度：刻着每条经线此刻的当地时间，环上立着各经度的电台数。
// 屏幕正中那条竖直的朱砂经线是指针，转地球就是转旋钮。
// 点阵贴在地表上跟着转（参考 cobe / GitHub Globe 的「点固定在地表」思路），转动时不闪、不爬边。
// 只在画面需要变化时重绘。
import { createRenderer } from './globe-gl.js';

const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const MIN_Z = 0.85;
const MAX_Z = 6;
const INTRO_MS = 1600;
const BEAM_MS = 1500;
const LOD_MS = 320;
// 点阵的几档间距（度）；缩放时选屏幕上最接近目标间距的一档。最细一档接近编号图的分辨率（0.176°）
const LEVELS = [2, 1.5, 1, 0.7, 0.5, 0.35, 0.25, 0.18];
const INK = '238,230,212';
const SIGNAL = '226,68,43'; // 朱砂
const BRASS = '200,162,106';
const BG = '8,10,15';
const SANS = 'Inter, system-ui, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const SERIF = 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "Adobe Song Std", STSong, SimSun, serif';
const MONO = '"Cascadia Mono", Consolas, "JetBrains Mono", ui-monospace, monospace';
const RING = 1.17; // 赤道环半径（地球半径的倍数）
const BIN = 2; // 环上频谱每格的经度宽度

function toXYZ(lat, lon) {
  const p = lat * RAD; const l = lon * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}
function slerp(a, b, t) {
  const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const w = Math.acos(d);
  if (w < 1e-6) return b;
  const s = Math.sin(w);
  const k1 = Math.sin((1 - t) * w) / s; const k2 = Math.sin(t * w) / s;
  return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
}
const angleOf = (a, b) => Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));

const inflate = async (url) => new Response((await fetch(url)).body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
const places = (list) => [null, ...list.map(([iso, name, lx, ly, rank], i) => ({ id: i + 1, iso, name, lon: lx, lat: ly, rank, xyz: toXYZ(ly, lx) }))];

async function loadWorld() {
  const [meta, rmeta, raw, araw] = await Promise.all([
    fetch('vendor/countries.json').then((r) => r.json()), fetch('vendor/regions.json').then((r) => r.json()),
    inflate('vendor/world-ids.bin'), inflate('vendor/admin1-ids.bin'),
  ]);
  const tex = new Uint8Array(raw);
  const admBytes = new Uint8Array(araw);
  if (tex.length !== meta.w * meta.h || admBytes.length !== meta.w * meta.h * 2) throw new Error('地图数据尺寸不对');
  return { tex, admBytes, adm: new Uint16Array(araw), TW: meta.w, TH: meta.h, countries: places(meta.list), regions: places(rmeta.list) };
}

export const wrapLon = (lon) => ((lon + 540) % 360 + 360) % 360 - 180;
const utcHours = (date = new Date()) => date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
// 太阳直射点的经度：那里正是正午。日落线在它以东 90°，日出线在以西 90°
export const sunLon = (date = new Date()) => wrapLon((12 - utcHours(date)) * 15);
// 某条经线此刻的当地太阳时（0–24）
export const solarHour = (lon, date = new Date()) => ((utcHours(date) + lon / 15) % 24 + 24) % 24;

// 太阳直射点（不计均时差，误差十几分钟，画昼夜够用）
function sunXYZ(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = (date - start) / 864e5;
  const lat = -23.44 * Math.cos((2 * Math.PI / 365) * (doy + 10));
  return toXYZ(lat, sunLon(date));
}

// avoid：返回页面上文字块的矩形 [x, y, w, h]（CSS 像素），地名不会画到它们上面
// onTune(经度, 缩放)：指针下的经线变了。scale()：右侧经线刻度栏的矩形 [x, y, w, h]，不显示时返回 null；
// overlays.scale 是刻度栏里的列表，第 i 个子元素对应 setScale 传入的第 i 个地点，由这里按纬度摆放并画引线
export async function createGlobe(canvas, { fx, getArea, avoid, scale, onPick, onHover, onInteract, onTune, overlays = {}, home = [30, 105], landmarks = [], oceans = [] }) {
  const world = await loadWorld();
  const { tex, adm, TW, TH, countries, regions } = world;
  let regionOrder = []; // 有台的省/州，台多的在前，只给它们写名字
  let sun = sunXYZ();
  setInterval(() => { sun = sunXYZ(); request(); }, 60000);
  const gl = createRenderer(canvas, world);
  const g2 = fx.getContext('2d');
  const byIso = new Map(countries.filter((c) => c?.iso).map((c) => [c.iso, c]));
  const marks = landmarks.map((m) => ({ ...m, xyz: toXYZ(m.lat, m.lon) }));
  const seas = oceans.map(([name, lat, lon]) => ({ name: [...name].join(' '), xyz: toXYZ(lat, lon) }));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const view = { lat: home[0], lon: home[1], zoom: 1, zoomT: 1 };
  let W = 0; let H = 0; let dpr = 1; let mobile = false;
  let pts = []; // 电台光点 {lat, lon, n, meta, xyz}
  let lod = { deg: 1, prev: 1, at: 0 };
  let hover = { idx: -1, mark: -1, country: 0, region: 0, at: 0 };
  let marker = null; let selected = null; let selId = 0; let selR = 0; let beam = null;
  let anim = null; let drag = null; let inertia = null; let pinch = null;
  let cur = null; let lastInteract = 0; let lastMove = 0;
  let markRects = [];
  let labelA = 0;
  let bins = new Float32Array(360 / BIN); let maxBin = 1; // 每格经度里的电台数
  let scaleItems = []; let scaleShown = false;
  let trail = []; // 足迹：按时间先后的地点 xyz
  let tuned = { lon: NaN, zoom: 0 };
  const intro = { start: performance.now(), dur: reduced ? 1 : INTRO_MS };
  let raf = 0; let lastFrame = 0;
  const pointers = new Map();
  const widths = new Map();

  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight; mobile = W < 760;
    for (const c of [canvas, fx]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
    widths.clear();
    request();
  }
  function request() { if (!raf) raf = requestAnimationFrame(frame); }

  // 视图基向量：U 屏幕向右，V 屏幕向上，D 朝向观众
  function basis() {
    const cl = Math.cos(view.lon * RAD); const sl = Math.sin(view.lon * RAD);
    const cp = Math.cos(view.lat * RAD); const sp = Math.sin(view.lat * RAD);
    return { U: [-sl, cl, 0], V: [-cl * sp, -sl * sp, cp], D: [cl * cp, sl * cp, sp] };
  }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // 球面点 → CSS 像素 [x, y, 深度]
  function screenOf(p, b, s) { return [s.cx + dot3(p, b.U) * s.R, s.cy - dot3(p, b.V) * s.R, dot3(p, b.D)]; }
  const radius = () => (cur || getArea()).size * 0.42 * view.zoom;

  function invert(sx, sy) {
    const r = radius();
    const u = (sx - cur.cx) / r; const v = -(sy - cur.cy) / r;
    const q = u * u + v * v;
    if (q > 1) return null;
    const d = Math.sqrt(1 - q); const b = basis();
    const P = [0, 1, 2].map((i) => b.U[i] * u + b.V[i] * v + b.D[i] * d);
    return [Math.asin(clamp(P[2], -1, 1)) / RAD, Math.atan2(P[1], P[0]) / RAD];
  }

  const texel = (lat, lon) => clamp(Math.floor((90 - lat) / 180 * TH), 0, TH - 1) * TW + clamp(Math.floor((lon + 180) / 360 * TW), 0, TW - 1);
  const countryAt = (lat, lon) => countries[tex[texel(lat, lon)]] || null;
  const regionAt = (lat, lon) => regions[adm[texel(lat, lon)]] || null;
  // 放大到一定程度后，悬停和选中都以省/州为单位
  const regionMode = () => view.zoom >= 1.9;
  // 光点大小随缩放略微变大（和着色器里一致，用于点选范围）
  const dotScale = () => clamp(0.8 + 0.35 * view.zoom, 1, 2.6);
  const dotRadius = (n) => (1.3 + Math.log2(n + 1) * 0.7) * dotScale() * 0.5;

  function pickLevel(R) {
    const target = mobile ? 5 : 5.5; // 点阵间距在屏幕上大约多少 CSS 像素
    const px = (deg) => R * deg * RAD;
    let best = lod.deg;
    for (const d of LEVELS) if (Math.abs(Math.log(px(d) / target)) < Math.abs(Math.log(px(best) / target))) best = d;
    // 留一点回差，缩放停在两档之间时不来回跳
    if (best !== lod.deg && Math.abs(Math.log(px(lod.deg) / target)) > 0.3) lod = { deg: best, prev: lod.deg, at: performance.now() };
  }

  // ---------- 绘制 ----------
  function draw(now) {
    const ip = clamp((now - intro.start) / intro.dur, 0, 1);
    const ie = easeOut(ip);
    const a = cur;
    const R = a.size * 0.42 * view.zoom * (0.94 + 0.06 * ie);
    const s = { cx: a.cx, cy: a.cy, R };
    const b = basis();
    pickLevel(R);
    const lm = clamp((now - lod.at) / LOD_MS, 0, 1);

    gl.render({
      w: canvas.width, h: canvas.height, dpr, cx: s.cx * dpr, cy: (H - s.cy) * dpr, R: R * dpr,
      U: b.U, V: b.V, D: b.D,
      degA: lod.deg, degB: lod.prev, mix: 1 - easeOut(lm),
      intro: reduced ? 1 : ip * 1.1, fade: ie,
      hover: hover.mark < 0 && !regionMode() ? hover.country : 0, sel: selId,
      hoverR: hover.mark < 0 && regionMode() ? hover.region : 0, selR, sun,
      dotSize: dotScale() * dpr, dotAlpha: clamp((ip - 0.35) / 0.65, 0, 1),
    });

    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, W, H);
    // 拖动、飞行时地名淡一些，停下来再完全显示
    const moving = !!(drag || anim || inertia || pinch) || now - lastMove < 200;
    const target = ip < 0.7 ? 0 : moving ? 0.3 : 1;
    labelA += (target - labelA) * 0.18;
    if (Math.abs(target - labelA) < 0.01) labelA = target;
    // 指针经线、赤道环、足迹都不画进页面文字块里（放大后地球会伸到底部读数下面）。放大后环在画面外，渐渐淡掉
    const blocks = avoid?.() || [];
    g2.save();
    if (blocks.length) {
      g2.beginPath(); g2.rect(0, 0, W, H);
      for (const [x, y, w, h] of blocks) g2.rect(x, y, w, h);
      g2.clip('evenodd');
    }
    drawMeridian(b, s, ie);
    const ringA = ie * clamp((1.75 - view.zoom) / 0.5, 0, 1);
    if (ringA > 0.01) drawRing(b, s, ringA);
    drawTrail(b, s, ie);
    g2.restore();
    // 先摆好准星和页面上的文字块，地名、地标都避开它们
    const keep = blocks.slice();
    const mk = placeOverlay(overlays.marker, marker, b, s);
    if (mk) keep.push(mk);
    const sp = placeOverlay(overlays.selected, selected, b, s);
    if (sp) keep.push(sp);
    const taken = labelA > 0.01 ? drawMarks(b, s, labelA, keep) : (markRects = [], []);
    if (labelA > 0.01) drawLabels(b, s, labelA, taken);
    drawScale(b, s, ie);
    const beamBusy = drawBeam(now, b, s);
    return ip < 1 || lm < 1 || beamBusy || labelA !== target || now - hover.at < 200;
  }

  // 返回准星占的区域，地名会避开它
  function placeOverlay(el, pt, b, s) {
    if (!el) return null;
    if (!pt) { el.hidden = true; return null; }
    const [x, y, d] = screenOf(toXYZ(pt.lat, pt.lon), b, s);
    if (d < 0.15) { el.hidden = true; return null; }
    el.hidden = false;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    el.style.opacity = String(clamp((d - 0.15) * 5, 0, 1));
    return [x - 22, y - 22, 44, 44];
  }

  // ---------- 浑天仪 ----------
  const ringAt = (lon, r, z, b, s) => { const l = lon * RAD; return screenOf([Math.cos(l) * r, Math.sin(l) * r, z], b, s); };
  // 环的背面被地球挡住的部分不画（2D 层叠在地球上面，只能这样模拟前后关系）
  const behind = (p, s) => p[2] < 0 && Math.hypot(p[0] - s.cx, p[1] - s.cy) < s.R;
  function strokeSegs(segs, style, width) {
    if (!segs.length) return;
    g2.beginPath();
    for (let i = 0; i < segs.length; i += 2) { g2.moveTo(segs[i][0], segs[i][1]); g2.lineTo(segs[i + 1][0], segs[i + 1][1]); }
    g2.strokeStyle = style; g2.lineWidth = width; g2.stroke();
  }

  // 指针：屏幕正中那条经线，从北到南一道朱砂细线
  function drawMeridian(b, s, alpha) {
    const lon = view.lon;
    g2.beginPath();
    let pen = false;
    for (let lat = -90; lat <= 90; lat += 2) {
      const [x, y, d] = screenOf(toXYZ(lat, lon), b, s);
      if (d > 0) { if (pen) g2.lineTo(x, y); else g2.moveTo(x, y); pen = true; } else pen = false;
    }
    g2.lineCap = 'round';
    g2.strokeStyle = `rgba(${SIGNAL},${(0.16 * alpha).toFixed(3)})`; g2.lineWidth = 4; g2.stroke();
    g2.strokeStyle = `rgba(${SIGNAL},${(0.85 * alpha).toFixed(3)})`; g2.lineWidth = 1.1; g2.stroke();
  }

  // 赤道环：24 小时刻度（刻在此刻正好是整点的经线上，所以刻度随时间缓缓西移），
  // 6/12/18/0 点写成日出、正午、日落、子夜；环上立着每 2° 经度的电台数
  function drawRing(b, s, A) {
    const tune = wrapLon(view.lon);
    const utc = utcHours();
    const front = []; const back = [];
    for (const r of [RING, RING + 0.012]) {
      let prev = null;
      for (let a = -180; a <= 180; a += 1.5) {
        const p = ringAt(a, r, 0, b, s);
        if (prev) {
          if (prev[2] >= 0 && p[2] >= 0) front.push(prev, p);
          else if (!behind(prev, s) && !behind(p, s)) back.push(prev, p);
        }
        prev = p;
      }
    }
    strokeSegs(back, `rgba(${BRASS},${(0.2 * A).toFixed(3)})`, 1);
    strokeSegs(front, `rgba(${BRASS},${(0.68 * A).toFixed(3)})`, 1);

    // 频谱柱
    const bf = []; const bb = []; const bt = [];
    const base = RING + 0.022;
    for (let i = 0; i < bins.length; i++) {
      if (!bins[i]) continue;
      const lon = -180 + (i + 0.5) * BIN;
      const p = ringAt(lon, base, 0, b, s);
      const q = ringAt(lon, base, (Math.log2(bins[i] + 1) / Math.log2(maxBin + 1)) * 0.05, b, s);
      if (behind(p, s) || behind(q, s)) continue;
      (Math.abs(wrapLon(lon - tune)) < BIN * 1.5 ? bt : p[2] >= 0 ? bf : bb).push(p, q);
    }
    strokeSegs(bb, `rgba(${BRASS},${(0.16 * A).toFixed(3)})`, 1.2);
    strokeSegs(bf, `rgba(${BRASS},${(0.55 * A).toFixed(3)})`, 1.2);
    strokeSegs(bt, `rgba(${SIGNAL},${(0.95 * A).toFixed(3)})`, 1.4);

    // 刻度：每 15 分钟一小格，整点一大格
    const tf = []; const tb = [];
    const labels = [];
    for (let k = 0; k < 96; k++) {
      const lon = wrapLon((k / 4 - utc) * 15);
      const major = k % 4 === 0;
      const p = ringAt(lon, RING - 0.012, 0, b, s);
      if (behind(p, s)) continue;
      const q = ringAt(lon, RING - (major ? 0.045 : 0.024), 0, b, s);
      (p[2] >= 0 ? tf : tb).push(p, q);
      if (major && p[2] > 0.08) labels.push([k / 4, lon, p[2]]);
    }
    strokeSegs(tb, `rgba(${BRASS},${(0.14 * A).toFixed(3)})`, 1);
    strokeSegs(tf, `rgba(${BRASS},${(0.5 * A).toFixed(3)})`, 1);

    g2.textAlign = 'center'; g2.textBaseline = 'middle';
    const WORDS = { 0: '子夜', 6: '日出', 12: '正午', 18: '日落' };
    for (const [h, lon, d] of labels) {
      const [x, y] = ringAt(lon, RING + 0.1, 0, b, s);
      const word = WORDS[h];
      const k = A * (0.25 + 0.65 * d);
      if (word) {
        g2.font = `400 12.5px ${SERIF}`;
        g2.fillStyle = `rgba(${BRASS},${Math.min(1, k * 1.25).toFixed(3)})`;
        const [rx, ry] = ringAt(lon, RING, 0, b, s);
        g2.beginPath(); g2.arc(rx, ry, 2.6, 0, Math.PI * 2); g2.fill();
      } else {
        g2.font = `400 10.5px ${MONO}`;
        g2.fillStyle = `rgba(${BRASS},${k.toFixed(3)})`;
      }
      g2.fillText(word || String(h).padStart(2, '0'), x, y);
    }

    // 指针落在环上的一个小三角
    const [nx, ny] = ringAt(tune, RING, 0, b, s);
    g2.fillStyle = `rgba(${SIGNAL},${A.toFixed(3)})`;
    g2.beginPath(); g2.moveTo(nx, ny - 7); g2.lineTo(nx + 5, ny + 2); g2.lineTo(nx - 5, ny + 2); g2.closePath(); g2.fill();
  }

  // 足迹：听过的地方按先后连成大圆弧，略微抬离地面，越早的越淡；每个地方一个铜色小圈
  function drawTrail(b, s, A) {
    if (!trail.length) return;
    const n = trail.length;
    g2.lineCap = 'round'; g2.lineWidth = 1.2;
    for (let i = 1; i < n; i++) {
      const from = trail[i - 1]; const to = trail[i];
      const ang = angleOf(from, to);
      if (ang < 1e-4) continue;
      const k = A * (0.25 + 0.6 * (i / (n - 1)));
      const steps = Math.max(6, Math.ceil(ang / RAD / 3));
      const lift = 0.02 + 0.08 * Math.min(1, ang / 1.5);
      g2.strokeStyle = `rgba(${BRASS},${k.toFixed(3)})`;
      g2.setLineDash([3, 4]);
      g2.beginPath();
      let pen = false;
      for (let j = 0; j <= steps; j++) {
        const u = j / steps;
        const v = slerp(from, to, u);
        const h = 1 + lift * Math.sin(Math.PI * u);
        const px = dot3(v, b.U) * h; const py = dot3(v, b.V) * h; const d = dot3(v, b.D);
        if (d > 0 || px * px + py * py > 1) {
          const x = s.cx + px * s.R; const y = s.cy - py * s.R;
          if (pen) g2.lineTo(x, y); else g2.moveTo(x, y);
          pen = true;
        } else pen = false;
      }
      g2.stroke();
    }
    g2.setLineDash([]);
    trail.forEach((p, i) => {
      const [x, y, d] = screenOf(p, b, s);
      if (d < 0.05) return;
      const k = A * (0.35 + 0.6 * (n > 1 ? i / (n - 1) : 1)) * clamp((d - 0.05) * 5, 0, 1);
      g2.strokeStyle = `rgba(${BRASS},${k.toFixed(3)})`;
      g2.beginPath(); g2.arc(x, y, 3, 0, Math.PI * 2); g2.stroke();
    });
  }

  // 右侧经线刻度：沿指针经线由北向南排的地点，引线连到它们在地球上的位置；挤在一起时往下错开
  function drawScale(b, s, A) {
    const list = overlays.scale;
    if (!list) return;
    const box = scaleItems.length ? scale?.() : null;
    if (!box) {
      if (scaleShown) { for (const el of list.children) { el.style.transform = ''; el.style.visibility = ''; } scaleShown = false; }
      return;
    }
    scaleShown = true;
    // 从刻度栏标题（top: 116px）下面开始排，不和顶栏挤在一起
    const x0 = box[0]; const top = box[1] + 150; const bottom = box[1] + box[3] - 24;
    let last = -Infinity;
    g2.lineWidth = 1;
    scaleItems.forEach((it, i) => {
      const el = list.children[i];
      if (!el) return;
      const [px, py, d] = screenOf(it.xyz, b, s);
      const ly = Math.max(py, last + 46, top);
      if (d < 0.05 || ly > bottom) { el.style.visibility = 'hidden'; return; }
      last = ly;
      el.style.visibility = 'visible';
      el.style.transform = `translate3d(0, ${ly.toFixed(1)}px, 0)`;
      const k = A * clamp((d - 0.05) * 5, 0, 1);
      g2.strokeStyle = it.on ? `rgba(${SIGNAL},${(0.8 * k).toFixed(3)})` : `rgba(${INK},${(0.13 * k).toFixed(3)})`;
      g2.beginPath(); g2.moveTo(px + 6, py);
      if (px + 6 < x0 - 40) g2.lineTo(x0 - 40, py);
      g2.lineTo(x0 - 14, ly); g2.lineTo(x0 - 6, ly); g2.stroke();
      g2.fillStyle = it.on ? `rgba(${SIGNAL},${k.toFixed(3)})` : `rgba(${INK},${(0.85 * k).toFixed(3)})`;
      g2.beginPath(); g2.arc(px, py, it.on ? 3.6 : 2.3, 0, Math.PI * 2); g2.fill();
      if (it.on) { g2.strokeStyle = `rgba(${SIGNAL},${(0.5 * k).toFixed(3)})`; g2.beginPath(); g2.arc(px, py, 9, 0, Math.PI * 2); g2.stroke(); }
    });
  }

  const width = (k, t) => { if (!widths.has(k)) widths.set(k, g2.measureText(t).width); return widths.get(k); };
  const topSafe = () => (mobile ? 76 : 84);

  // 地标：一个小圆圈 + 斜引线 + 衬线字，重要的先放，互相挡住的跳过
  function drawMarks(b, s, alpha, keep) {
    markRects = [];
    const taken = keep.slice();
    g2.font = `400 12.5px ${SERIF}`;
    g2.textBaseline = 'middle'; g2.textAlign = 'left';
    g2.lineWidth = 1;
    marks.forEach((m, mi) => {
      if (view.zoom < Math.max(1.15, m.z)) return;
      const [x, y, d] = screenOf(m.xyz, b, s);
      if (d < 0.35 || y < topSafe() + 20) return;
      const w = width('m' + mi, m.name);
      const rect = [x - 5, y - 24, w + 26, 30];
      if (taken.some((o) => rect[0] < o[0] + o[2] && o[0] < rect[0] + rect[2] && rect[1] < o[1] + o[3] && o[1] < rect[1] + rect[3])) return;
      taken.push(rect);
      const on = hover.mark === mi;
      const c = on ? SIGNAL : INK;
      const k = alpha * clamp((d - 0.35) * 4, 0, 1);
      g2.strokeStyle = `rgba(${c},${(0.55 * k).toFixed(3)})`;
      g2.beginPath(); g2.arc(x, y, 2.5, 0, Math.PI * 2); g2.moveTo(x + 2, y - 2); g2.lineTo(x + 11, y - 11); g2.stroke();
      g2.fillStyle = `rgba(${c},${((on ? 1 : 0.72) * k).toFixed(3)})`;
      g2.fillText(m.name, x + 14, y - 13);
      markRects.push([...rect, mi]);
    });
    return taken;
  }

  // 海洋名、国名、省州名：缩放越大写得越多，重叠的跳过
  function drawLabels(b, s, alpha, taken) {
    g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.lineJoin = 'round';
    const boxes = taken.slice();
    const top = topSafe();
    const fits = (x, y, w, h) => {
      if (x < 4 || y < top || x + w > W - 4 || y + h > H - 40) return false;
      const p = 5; // 字和字之间至少留一点空
      if (boxes.some((o) => x - p < o[0] + o[2] && o[0] < x + w + p && y < o[1] + o[3] && o[1] < y + h)) return false;
      boxes.push([x, y, w, h]); return true;
    };

    if (view.zoom < 2.2) {
      g2.font = `400 13px ${SERIF}`;
      for (const o of seas) {
        const [x, y, d] = screenOf(o.xyz, b, s);
        if (d < 0.3) continue;
        const w = width('s' + o.name, o.name) + 8;
        if (!fits(x - w / 2, y - 9, w, 18)) continue;
        g2.fillStyle = `rgba(${INK},${(0.2 * alpha * clamp((d - 0.3) * 3, 0, 1)).toFixed(3)})`;
        g2.fillText(o.name, x, y);
      }
    }

    // 默认视角下不写国名，画面保持干净；放大后按重要程度逐步出现
    const limit = view.zoom < 1.3 ? 0 : view.zoom < 2.2 ? 2 : view.zoom < 3.2 ? 3 : 5;
    g2.font = `500 11.5px ${SANS}`;
    g2.lineWidth = 3; g2.strokeStyle = `rgba(${BG},.6)`;
    for (let i = 1; i < countries.length; i++) {
      const c = countries[i];
      const on = c.id === hover.country || c.id === selId;
      if (!on && c.rank > limit) continue;
      const [x, y, d] = screenOf(c.xyz, b, s);
      if (d < 0.35) continue;
      const w = width('c' + c.id, c.name) + 6;
      if (!fits(x - w / 2, y - 8, w, 16)) continue;
      const k = (on ? 1 : alpha) * clamp((d - 0.35) * 4, 0, 1);
      g2.globalAlpha = k;
      g2.strokeText(c.name, x, y);
      g2.fillStyle = on ? `rgb(${SIGNAL})` : `rgba(${INK},.62)`;
      g2.fillText(c.name, x, y);
    }

    // 省州名只写台最多的那些，再放大才写更多，免得满屏都是字
    if (regionMode()) {
      g2.font = `400 11px ${SANS}`;
      const extra = [selR, hover.region].filter(Boolean).map((id) => regions[id]);
      let left = view.zoom < 2.8 ? 10 : view.zoom < 4 ? 22 : 40;
      for (const r of [...extra, ...regionOrder]) {
        if (left <= 0) break;
        const on = r.id === selR || r.id === hover.region;
        const [x, y0, d] = screenOf(r.xyz, b, s);
        if (d < 0.4) continue;
        const y = y0 + 12; // 标注点上常有电台光点，名字写在它下方
        const w = width('r' + r.id, r.name) + 6;
        if (!fits(x - w / 2, y - 8, w, 16)) continue;
        g2.globalAlpha = (on ? 1 : alpha * 0.9) * clamp((d - 0.4) * 4, 0, 1);
        g2.strokeText(r.name, x, y);
        g2.fillStyle = on ? `rgb(${SIGNAL})` : `rgba(${INK},.42)`;
        g2.fillText(r.name, x, y);
        left -= 1;
      }
    }
    g2.globalAlpha = 1;
  }

  // 调频弧线：沿大圆弧抬离地面，尾巴渐隐，头部一个发光点
  function drawBeam(now, b, s) {
    if (!beam) return false;
    const t = (now - beam.start) / BEAM_MS;
    if (t > 1.4) { beam = null; return false; }
    const head = ease(clamp(t, 0, 1));
    const fade = t > 1 ? 1 - (t - 1) / 0.4 : 1;
    const lift = 0.05 + 0.2 * Math.min(1, beam.angle / Math.PI);
    const steps = 90;
    let prev = null; let last = null;
    g2.lineCap = 'round'; g2.lineWidth = 1.5;
    for (let k = 0; k <= steps * head; k++) {
      const u = k / steps;
      const v = slerp(beam.from, beam.to, u);
      const h = 1 + lift * Math.sin(Math.PI * u);
      const px = dot3(v, b.U); const py = dot3(v, b.V); const d = dot3(v, b.D);
      const visible = d > 0 || (px * px + py * py) * h * h > 1;
      const pt = visible ? [s.cx + px * s.R * h, s.cy - py * s.R * h] : null;
      if (pt && prev) {
        const tail = clamp(1 - (head - u) / 0.45, 0, 1) * fade;
        if (tail > 0.04) {
          g2.strokeStyle = `rgba(${SIGNAL},${(tail * 0.9).toFixed(3)})`;
          g2.beginPath(); g2.moveTo(prev[0], prev[1]); g2.lineTo(pt[0], pt[1]); g2.stroke();
        }
      }
      prev = pt; if (pt) last = pt;
    }
    if (last && t < 1) {
      const gr = g2.createRadialGradient(last[0], last[1], 0, last[0], last[1], 10);
      gr.addColorStop(0, 'rgba(255,240,228,1)'); gr.addColorStop(0.3, `rgba(${SIGNAL},.6)`); gr.addColorStop(1, `rgba(${SIGNAL},0)`);
      g2.fillStyle = gr; g2.fillRect(last[0] - 10, last[1] - 10, 20, 20);
    }
    return true;
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(50, lastFrame ? now - lastFrame : 16);
    lastFrame = now;
    let busy = false;

    // 布局变化（面板开合、开场收起）时地球平滑让位
    const t = getArea();
    if (!cur) cur = { ...t };
    if (Math.abs(t.cx - cur.cx) + Math.abs(t.cy - cur.cy) + Math.abs(t.size - cur.size) > 0.4) {
      const k = 1 - Math.pow(0.88, dt / 16);
      cur.cx += (t.cx - cur.cx) * k; cur.cy += (t.cy - cur.cy) * k; cur.size += (t.size - cur.size) * k;
      busy = true;
    } else cur = { ...t };

    if (anim) {
      const p = clamp((now - anim.start) / anim.dur, 0, 1);
      const e = ease(p);
      const v = slerp(anim.from, anim.to, e);
      view.lat = Math.asin(clamp(v[2], -1, 1)) / RAD; view.lon = Math.atan2(v[1], v[0]) / RAD;
      const pull = anim.angle > 0.5 ? Math.sin(Math.PI * e) * 0.18 * Math.min(1, anim.angle / 2) : 0;
      view.zoom = view.zoomT = (anim.z0 + (anim.z1 - anim.z0) * e) * (1 - pull);
      if (p >= 1) anim = null; else busy = true;
    } else if (inertia && !drag) {
      view.lon -= inertia.vx * dt; view.lat = clamp(view.lat - inertia.vy * dt, -80, 80);
      const f = Math.pow(0.93, dt / 16);
      inertia.vx *= f; inertia.vy *= f;
      if (Math.abs(inertia.vx) + Math.abs(inertia.vy) < 0.0006) inertia = null; else busy = true;
    } else if (!reduced && !drag && !selected && !marker && now - lastInteract > 8000 && document.visibilityState === 'visible') {
      view.lon -= dt * 0.0016; // 还没调到台时闲置很慢地自转；调到台后指针停住不动
      busy = true;
    }

    const tl = wrapLon(view.lon);
    if (onTune && (!(Math.abs(wrapLon(tl - tuned.lon)) < 0.2) || Math.abs(Math.log(view.zoom / tuned.zoom)) > 0.04)) {
      tuned = { lon: tl, zoom: view.zoom };
      onTune(tl, view.zoom);
    }

    if (!anim && Math.abs(view.zoomT - view.zoom) > 0.0008) {
      view.zoom += (view.zoomT - view.zoom) * (1 - Math.pow(0.8, dt / 16));
      busy = true;
    }
    if (draw(now)) busy = true;
    if (busy) raf = requestAnimationFrame(frame); else lastFrame = 0;
  }

  // ---------- 交互 ----------
  function nearest(x, y, maxPx) {
    const b = basis(); const s = { cx: cur.cx, cy: cur.cy, R: radius() };
    let best = null; let bs = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const [sx, sy, d] = screenOf(p.xyz, b, s);
      if (d < 0.05) continue;
      const dist = Math.hypot(sx - x, sy - y);
      if (dist > Math.max(maxPx, dotRadius(p.n) + 3)) continue;
      const score = dist - Math.min(5, Math.log2(p.n + 1)); // 重叠时偏向台多的那个
      if (score < bs) { bs = score; best = { p, idx: i, x: sx, y: sy }; }
    }
    return best;
  }
  const markAt = (x, y) => { for (const [rx, ry, rw, rh, mi] of markRects) if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return mi; return -1; };
  const under = (x, y) => {
    const ll = invert(x, y);
    return ll ? { country: countryAt(ll[0], ll[1])?.id || 0, region: regionAt(ll[0], ll[1])?.id || 0 } : { country: 0, region: 0 };
  };

  function pickAt(x, y, r) {
    const mi = markAt(x, y);
    if (mi >= 0) return { kind: 'landmark', mark: marks[mi] };
    const v = nearest(x, y, r);
    if (v) return { kind: 'station', ...v };
    const id = under(x, y).country;
    return id ? { kind: 'country', id } : null;
  }

  function clearHover() {
    if (hover.idx >= 0 || hover.mark >= 0 || hover.country) { hover = { idx: -1, mark: -1, country: 0, region: 0, at: performance.now() }; request(); }
    onHover?.(null);
  }
  // kind：'drag' 拖动或点按，'zoom' 滚轮缩放
  function touch(kind = 'drag') { lastInteract = lastMove = performance.now(); anim = null; onInteract?.(kind); clearHover(); }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    touch(); inertia = null;
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinch = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), z: view.zoom }; drag = null;
    } else {
      const now = performance.now();
      drag = { x: e.clientX, y: e.clientY, lat: view.lat, lon: view.lon, t: now, moved: 0, lx: e.clientX, ly: e.clientY, lt: now, vx: 0, vy: 0 };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      view.zoom = view.zoomT = clamp(pinch.z * Math.hypot(p1.x - p2.x, p1.y - p2.y) / pinch.d, MIN_Z, MAX_Z);
      lastMove = performance.now(); request(); return;
    }
    if (drag) {
      const k = 57.3 / radius();
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      view.lon = drag.lon - dx * k; view.lat = clamp(drag.lat + dy * k, -80, 80);
      const now = performance.now(); const dtm = Math.max(1, now - drag.lt);
      drag.vx = ((e.clientX - drag.lx) * k) / dtm; drag.vy = (-(e.clientY - drag.ly) * k) / dtm;
      drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now;
      canvas.classList.toggle('dragging', drag.moved > 4);
      lastInteract = lastMove = now; request(); return;
    }
    if (e.pointerType === 'touch' || !cur) return;
    const p = pickAt(e.clientX, e.clientY, 10);
    const idx = p?.kind === 'station' ? p.idx : -1;
    const mark = p?.kind === 'landmark' ? marks.indexOf(p.mark) : -1;
    const u = p?.kind === 'landmark' ? { country: 0, region: 0 } : under(e.clientX, e.clientY);
    if (idx !== hover.idx || mark !== hover.mark || u.country !== hover.country || u.region !== hover.region) {
      hover = { idx, mark, ...u, at: performance.now() }; request();
    }
    canvas.classList.toggle('pointing', !!p && p.kind !== 'country');
    if (!p) return onHover?.(null);
    const info = { country: countries[u.country] || null, region: regions[u.region] || null, regionMode: regionMode() };
    if (p.kind === 'station') onHover?.({ kind: 'station', x: p.x, y: p.y, n: p.p.n, meta: p.p.meta, ...info });
    else if (p.kind === 'landmark') onHover?.({ kind: 'landmark', x: e.clientX, y: e.clientY, mark: p.mark });
    else onHover?.({ kind: 'country', x: e.clientX, y: e.clientY, ...info });
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    const d = drag; drag = null;
    canvas.classList.remove('dragging');
    if (d.moved < 6 && performance.now() - d.t < 500) {
      const p = pickAt(e.clientX, e.clientY, 14);
      if (p?.kind === 'landmark') return onPick?.({ kind: 'landmark', lat: p.mark.lat, lon: p.mark.lon, n: 1, mark: p.mark });
      if (p?.kind === 'station') return onPick?.({ kind: 'station', lat: p.p.lat, lon: p.p.lon, n: p.p.n, meta: p.p.meta });
      const ll = invert(e.clientX, e.clientY);
      if (ll) onPick?.({ kind: 'ground', lat: ll[0], lon: ll[1], n: 0 });
      return;
    }
    if (performance.now() - d.lt < 80) { inertia = { vx: d.vx, vy: d.vy }; request(); }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag) clearHover(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); touch('zoom');
    view.zoomT = clamp(view.zoomT * Math.exp(-e.deltaY * 0.0018), MIN_Z, MAX_Z);
    request();
  }, { passive: false });

  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', request);
  resize();

  return {
    // list 每项 [纬度, 经度, 电台数, 附加信息?]
    setPoints(list) {
      pts = list.map(([lat, lon, n, meta]) => ({ lat, lon, n, meta: meta || null, xyz: toXYZ(lat, lon) }));
      const buf = new Float32Array(pts.length * 4);
      pts.forEach((p, i) => { buf.set(p.xyz, i * 4); buf[i * 4 + 3] = p.n; });
      gl.setDots(buf);
      bins = new Float32Array(360 / BIN);
      for (const p of pts) bins[clamp(Math.floor((wrapLon(p.lon) + 180) / BIN), 0, bins.length - 1)] += p.n;
      maxBin = Math.max(1, ...bins);
      tuned = { lon: NaN, zoom: 0 }; // 让外面按新数据重算一次经线刻度
      request();
    },
    // 经度 lon 两侧 band 度以内的光点，台多的在前
    meridian(lon, band) {
      return pts.filter((p) => Math.abs(wrapLon(p.lon - lon)) <= band).sort((a, b) => b.n - a.n);
    },
    // 右侧经线刻度上的地点 [{lat, lon, on}]，顺序和 overlays.scale 的子元素一致
    setScale(items) {
      scaleItems = items.map((it) => ({ ...it, xyz: toXYZ(it.lat, it.lon) }));
      request();
    },
    get view() { return { lat: view.lat, lon: wrapLon(view.lon), zoom: view.zoomT }; },
    // 足迹 [{lat, lon}]，按时间先后
    setTrail(list) {
      trail = list.map((p) => toXYZ(p.lat, p.lon));
      request();
    },
    // 键盘转旋钮：往东（正）或往西（负）转 deg 度
    turn(deg) {
      inertia = null; lastInteract = performance.now();
      const base = anim?.toLon ?? view.lon; // 连按时从上一次的目标接着转
      const lon = base + deg;
      const from = toXYZ(view.lat, view.lon); const to = toXYZ(view.lat, lon);
      anim = { start: performance.now(), dur: reduced ? 1 : 260, from, to, angle: angleOf(from, to), z0: view.zoom, z1: view.zoomT, toLon: lon };
      request();
    },
    flyTo(lat, lon, zoom = view.zoomT, dur) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      inertia = null; lastInteract = performance.now();
      const from = toXYZ(view.lat, view.lon); const to = toXYZ(lat, lon);
      const angle = angleOf(from, to);
      const ms = dur ?? clamp(650 + (angle / RAD) * 8, 700, 1900);
      anim = { start: performance.now(), dur: reduced ? 1 : ms, from, to, angle, z0: view.zoom, z1: clamp(zoom, MIN_Z, MAX_Z) };
      request();
    },
    setMarker(lat, lon) {
      const next = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
      if (next && !reduced) {
        const from = marker ? toXYZ(marker.lat, marker.lon) : toXYZ(view.lat, view.lon);
        const to = toXYZ(lat, lon);
        const angle = angleOf(from, to);
        if (angle > 0.01) beam = { start: performance.now(), from, to, angle };
      }
      marker = next;
      request();
    },
    // 选中一个地点：放标记，所在省/州的点阵染成橙色，所在国家略微提亮
    select(lat, lon, regionId = undefined) {
      const ok = Number.isFinite(lat) && Number.isFinite(lon);
      selected = ok ? { lat, lon } : null;
      selId = ok ? countryAt(lat, lon)?.id || 0 : 0;
      selR = ok ? (regionId ?? regionAt(lat, lon)?.id ?? 0) : 0;
      request();
    },
    // counts：Map(省/州编号 → 电台数)
    setRegionCounts(counts) {
      regionOrder = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 600).map(([id]) => regions[id]).filter(Boolean);
      request();
    },
    countryAt,
    regionAt,
    region: (id) => regions[id] || null,
    country: (iso) => byIso.get(iso) || null,
    relayout: request,
    // 缩放按钮/快捷键：和滚轮一样只改目标值，实际缩放平滑追上去
    zoomBy(f) {
      anim = null; inertia = null; lastInteract = performance.now();
      view.zoomT = clamp(view.zoomT * f, MIN_Z, MAX_Z);
      request();
    },
    get zoom() { return view.zoomT; },
  };
}
