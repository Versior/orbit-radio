// 足迹：近 12 小时听过的地方按先后连成虚线画在地球上；足迹面板顶部写走过几个地方、一共多远
import { S } from './state.js';
import { fmt } from './util.js';
import { globe } from './map.js';

const WINDOW = 12 * 3600e3;
const RAD = Math.PI / 180;

function trailPoints() {
  const since = Date.now() - WINDOW;
  return S.recents
    .filter((s) => s.at > since && s.lat != null && s.lon != null)
    .sort((a, b) => a.at - b.at)
    // 同一个地方连着听了几个台，只算一个点
    .filter((s, i, a) => !i || Math.abs(s.lat - a[i - 1].lat) + Math.abs(s.lon - a[i - 1].lon) > 0.05);
}

// 两点之间的大圆距离（公里）
function km(a, b) {
  const h = Math.sin((b.lat - a.lat) * RAD / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin((b.lon - a.lon) * RAD / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function renderTrail() { globe?.setTrail(trailPoints()); }

function trailSummary() {
  const pts = trailPoints();
  if (pts.length < 2) return '';
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += km(pts[i - 1], pts[i]);
  return `近 12 小时走过 ${pts.length} 个地方，约 ${fmt(Math.round(total))} 公里`;
}

export { renderTrail, trailSummary };
