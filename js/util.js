// 通用小工具：DOM 选择、转义、本地存储、地区名、提示条

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem('air:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('air:' + k, JSON.stringify(v)); } catch { /* 隐私模式下忽略 */ } },
};
const regionName = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch { /* 旧浏览器 */ }
  return (cc) => { if (!cc) return ''; try { return dn ? dn.of(cc) : cc; } catch { return cc; } };
})();
const hashOf = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const letterOf = (name) => (Array.from(name.replace(/^[\s\p{P}\p{S}]+/u, ''))[0] || '♪').toUpperCase();
const shuffled = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const canLoad = (url) => !!url && (url.startsWith('https://') || (url.startsWith('http://') && location.protocol === 'http:'));
// 手机，以及竖着拿的平板，都用上下排的布局；和 style.css 里的媒体查询保持一致
const MOBILE_Q = matchMedia('(max-width: 759px), (max-width: 1023px) and (orientation: portrait)');
const isMobile = () => MOBILE_Q.matches;

const fmt = (n) => n.toLocaleString('zh-CN');

function guessRegion() {
  const m = (navigator.language || '').match(/-([A-Za-z]{2})\b/);
  return m ? m[1].toUpperCase() : '';
}

let toastTimer = 0;
function toast(msg, action, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); fn(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2600);
}

export { $, shuffled, canLoad, store, $$, regionName, toast, esc, hashOf, letterOf, guessRegion, isMobile, fmt };
