// 省/州名字归一化：离线构建脚本和服务端共用，保证两边算出来的键完全一样。
// Radio Browser 的 state 字段是用户自己填的，写法很乱：大小写、重音、括号、「Province」后缀、
// 邮政式拼写（Kiangsu）、中文带「省」「市」都有。这里统一成小写、无重音、无后缀的形式。

const SUFFIX = /\s+(province|provincia|provinz|state|estado|region|regione|county|oblast|krai|kray|okrug|republic|autonomous region|autonomous community|comunidad autonoma|prefecture|department|departement|district|governorate|voivodeship|wojewodztwo|land|sheng|shi|zizhiqu|ken|to|fu|do|municipality|direct administered municipality|special administrative region|sar)$/;
const PREFIX = /^(state of|province of|provincia de|provincia di|estado de|region de|canton of|kanton)\s+/;
const ZH_SUFFIX = /(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市|州|县|府|道)$/;

export function normName(s) {
  let t = String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  t = t.replace(/\(.*?\)|（.*?）/g, ' ').replace(/[-_.,'’`/]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) {
    const next = t.replace(PREFIX, '').replace(SUFFIX, '').trim();
    if (!next || next === t) break;
    t = next;
  }
  if (/[\u4e00-\u9fa5]/.test(t)) { const z = t.replace(/\s/g, '').replace(ZH_SUFFIX, ''); if (z) t = z; }
  return t;
}
