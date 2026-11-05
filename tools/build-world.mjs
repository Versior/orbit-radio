// 离线生成像素地球的数据（只在更新边界时运行一次）
// 输入：Natural Earth 10m 国界（中国视角版）ne_10m_admin_0_countries_chn.geojson
//       Natural Earth 10m 省/州     ne_10m_admin_1_states_provinces.geojson
// 输出：vendor/world-ids.bin    等距圆柱 2048×1024，每像素 1 字节国家编号（0 = 海洋），deflate 压缩
//       vendor/countries.json   国家编号 → [ISO 两位码, 中文名, 标注经度, 标注纬度, 标注等级]
//       vendor/admin1-ids.bin   同尺寸，每像素 2 字节（小端）省/州编号（0 = 无），deflate 压缩
//       vendor/regions.json     省/州编号 → [ISO 两位码, 中文名, 标注经度, 标注纬度, 标注等级]
//       vendor/region-alias.json 服务端用：[ISO 两位码, 省/州编号, 归一化别名...]
// 运行：node tools/build-world.mjs <国界 geojson> <省州 geojson>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { normName } from '../lib/region-name.mjs';

const W = 2048; const H = 1024;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [srcCountries, srcAdmin1] = process.argv.slice(2);
if (!srcCountries || !srcAdmin1) { console.error('用法：node tools/build-world.mjs <国界 geojson> <省州 geojson>'); process.exit(1); }

// 官方中文名太长的，换成常用简称
const SHORT = {
  CN: '中国', GB: '英国', KP: '朝鲜', KR: '韩国', US: '美国', RU: '俄罗斯', LA: '老挝', VN: '越南',
  IR: '伊朗', SY: '叙利亚', VE: '委内瑞拉', BO: '玻利维亚', TZ: '坦桑尼亚', CD: '刚果（金）', CG: '刚果（布）',
  CF: '中非', DO: '多米尼加', CZ: '捷克', MK: '北马其顿', MD: '摩尔多瓦', BA: '波黑', AE: '阿联酋',
};
// 分得太细、电台又少的地区，整体当成一个
const MERGE = { HK: ['香港', 114.17, 22.32], MO: ['澳门', 113.54, 22.19] };
// 法国、意大利、西班牙的 admin-1 是省/省份一级，而电台一般填大区名，按 Natural Earth 的 region 字段合并成大区
const MERGE_BY_REGION = {
  FR: {
    'Guyane française': '法属圭亚那', 'Hauts-de-France': '上法兰西', 'Grand Est': '大东部', "Provence-Alpes-Côte-d'Azur": '普罗旺斯-阿尔卑斯-蓝色海岸',
    'Auvergne-Rhône-Alpes': '奥弗涅-罗讷-阿尔卑斯', 'Nouvelle-Aquitaine': '新阿基坦', Occitanie: '奥克西塔尼', 'Bourgogne-Franche-Comté': '勃艮第-弗朗什-孔泰',
    'Pays de la Loire': '卢瓦尔河地区', Bretagne: '布列塔尼', Normandie: '诺曼底', Martinique: '马提尼克', Guadeloupe: '瓜德罗普', 'Réunion': '留尼汪',
    Mayotte: '马约特', Corse: '科西嘉', 'Centre-Val de Loire': '中央-卢瓦尔河谷', 'Île-de-France': '法兰西岛',
  },
  IT: {
    "Valle d'Aosta": '瓦莱达奥斯塔', Piemonte: '皮埃蒙特', Lombardia: '伦巴第', 'Trentino-Alto Adige': '特伦蒂诺-上阿迪杰', Liguria: '利古里亚',
    'Emilia-Romagna': '艾米利亚-罗马涅', Marche: '马尔凯', Veneto: '威尼托', 'Friuli-Venezia Giulia': '弗留利-威尼斯朱利亚', Abruzzo: '阿布鲁佐',
    Molise: '莫利塞', Apulia: '普利亚', Basilicata: '巴西利卡塔', Calabria: '卡拉布里亚', Campania: '坎帕尼亚', Lazio: '拉齐奥', Toscana: '托斯卡纳',
    Sicily: '西西里', Sardegna: '撒丁', Umbria: '翁布里亚',
  },
  ES: {
    Ceuta: '休达', Melilla: '梅利利亚', 'Foral de Navarra': '纳瓦拉', 'País Vasco': '巴斯克', 'Aragón': '阿拉贡', 'Cataluña': '加泰罗尼亚',
    Extremadura: '埃斯特雷马杜拉', 'Andalucía': '安达卢西亚', Galicia: '加利西亚', 'Castilla y León': '卡斯蒂利亚-莱昂', Valenciana: '瓦伦西亚',
    Murcia: '穆尔西亚', Asturias: '阿斯图里亚斯', Cantabria: '坎塔布里亚', 'Canary Is.': '加那利群岛', 'Islas Baleares': '巴利阿里群岛',
    'La Rioja': '拉里奥哈', 'Castilla-La Mancha': '卡斯蒂利亚-拉曼恰', Madrid: '马德里',
  },
};
// Radio Browser 里常见的其它写法（旧式拼写、英文名、简称、城市名），按省/州归组。
// 组里任意一个名字能对上 Natural Earth 的别名，整组就归到那个省/州；多词地名用下划线连接。
const EXTRA = Object.fromEntries(Object.entries({
  CN: [
    'beijing peking', 'tianjin tientsin', 'shanghai', 'chongqing chungking', 'hebei hopei shijiazhuang', 'shanxi shansi taiyuan',
    'inner_mongol inner_mongolia nei_mongol neimenggu hohhot', 'liaoning dalian shenyang', 'jilin kirin changchun',
    'heilongjiang heilungkiang amur_river harbin', 'jiangsu kiangsu nanjing suzhou', 'zhejiang chekiang hangzhou',
    'anhui anhwei hefei', 'fujian fukien fuzhou xiamen', 'jiangxi kiangsi nanchang', 'shandong shantung jinan qingdao',
    'henan honan zhengzhou', 'hubei hupei wuhan', 'hunan changsha', 'guangdong kwangtung guangzhou canton shenzhen 广州 深圳',
    'guangxi kwangsi nanning', 'hainan haikou', 'sichuan szechuan szechwan chengdu 成都', 'guizhou kweichow guiyang',
    'yunnan kunming', 'xizang tibet lhasa', 'shaanxi shensi xian', 'gansu kansu lanzhou', 'qinghai tsinghai xining',
    'ningxia ningsia yinchuan', 'xinjiang sinkiang urumqi',
  ],
  DE: [
    'nordrhein_westfalen nrw north_rhine_westphalia cologne koln dusseldorf dortmund essen bochum', 'bayern bavaria munchen munich nurnberg nuremberg wurzburg',
    'baden_wurttemberg bw baden_wuertemberg baden_wuerttemberg stuttgart mannheim karlsruhe', 'berlin berlin_brandenburg', 'sachsen saxony leipzig dresden',
    'thuringen thuringia jena erfurt weimar', 'hessen hesse frankfurt', 'niedersachsen lower_saxony hannover hanover', 'schleswig_holstein schleswig_holtstein kiel',
    'sachsen_anhalt saxony_anhalt magdeburg halle', 'mecklenburg_vorpommern mv rostock', 'rheinland_pfalz rhineland_palatinate mainz', 'hamburg', 'bremen',
  ],
  FR: ['ile_de_france paris', 'auvergne_rhone_alpes lyon grenoble', 'occitanie toulouse montpellier', 'hauts_de_france lille', 'bretagne breizh brittany rennes', 'pays_de_la_loire nantes', "provence_alpes_cote_d_azur paca marseille nice cannes"],
  IT: ['sicily sicilia', 'apulia puglia', 'sardegna sardinia', 'toscana tuscany firenze florence', 'lombardia lombardy milano milan', 'piemonte piedmont torino turin', 'lazio roma rome', 'campania napoli naples'],
  ES: ['cataluna catalonia catalunya barcelona', 'valenciana valencia comunidad_valenciana comunitat_valenciana', 'pais_vasco euskadi basque_country', 'andalucia andalusia sevilla', 'islas_baleares illes_balears balearic_islands ibiza mallorca palma_de_mallorca menorca', 'canary_is canarias canary_islands islas_canarias canaries tenerife las_palmas_de_gran_canaria', 'madrid comunidad_de_madrid', 'foral_de_navarra navarra navarre'],
}).map(([cc, groups]) => [cc, groups.map((g) => g.split(' ').map((w) => w.replace(/_/g, ' ')))]));

function fill(ids, geometry, value) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  // 扫描线填充：同一要素的所有环一起做奇偶规则，内环自然成为洞
  const rows = new Map();
  for (const poly of polys) {
    for (const ring of poly) {
      for (let k = 0; k < ring.length - 1; k++) {
        const x0 = (ring[k][0] + 180) / 360 * W; const y0 = (90 - ring[k][1]) / 180 * H;
        const x1 = (ring[k + 1][0] + 180) / 360 * W; const y1 = (90 - ring[k + 1][1]) / 180 * H;
        if (y0 === y1) continue;
        const lo = Math.min(y0, y1); const hi = Math.max(y0, y1);
        for (let r = Math.ceil(lo - 0.5); r + 0.5 < hi; r++) {
          const yc = r + 0.5;
          if (yc < lo || r < 0 || r >= H) continue;
          if (!rows.has(r)) rows.set(r, []);
          rows.get(r).push(x0 + (yc - y0) / (y1 - y0) * (x1 - x0));
        }
      }
    }
  }
  for (const [r, xs] of rows) {
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)); const b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = a; c <= b; c++) ids[r * W + c] = value;
    }
  }
}

const iso2 = (...v) => v.find((x) => /^[A-Z]{2}$/.test(x || '')) || '';
const write = (name, data) => fs.writeFileSync(path.join(ROOT, 'vendor', name), data);
fs.mkdirSync(path.join(ROOT, 'vendor'), { recursive: true });

// ---------- 国家 ----------
const g0 = JSON.parse(fs.readFileSync(srcCountries, 'utf8'));
const cids = new Uint8Array(W * H);
const countries = [];
g0.features.forEach((f, i) => {
  const p = f.properties;
  if (i + 1 > 255) throw new Error('国家数超过 255');
  const iso = iso2(p.ISO_A2, p.ISO_A2_EH);
  const zh = SHORT[iso] || (p.NAME_ZH || p.NAME || '').replace(/^.*?(?=[\u4e00-\u9fa5])/, '');
  countries.push([iso, zh, +(+p.LABEL_X).toFixed(2), +(+p.LABEL_Y).toFixed(2), p.LABELRANK ?? 9]);
  fill(cids, f.geometry, i + 1);
});
const cbin = zlib.deflateSync(cids, { level: 9 });
write('world-ids.bin', cbin);
write('countries.json', JSON.stringify({ w: W, h: H, list: countries }));

// ---------- 省/州 ----------
const g1 = JSON.parse(fs.readFileSync(srcAdmin1, 'utf8'));
const aids = new Uint16Array(W * H);
const regions = []; const alias = []; const merged = new Map();
// 合并后的大区：标注点取成员标注点的平均值
const mergedPts = new Map();
for (const f of g1.features) {
  const p = f.properties;
  const iso = iso2(p.iso_a2);
  if (!iso) continue;
  let id;
  const big = MERGE_BY_REGION[iso]?.[p.region];
  if (MERGE[iso]) {
    if (!merged.has(iso)) {
      const [zh, lon, lat] = MERGE[iso];
      regions.push([iso, zh, lon, lat, 2]);
      merged.set(iso, regions.length);
      alias.push([iso, regions.length, normName(zh), normName(p.admin), normName(p.geonunit)]);
    }
    id = merged.get(iso);
  } else if (big) {
    const key = iso + '|' + p.region;
    if (!merged.has(key)) {
      regions.push([iso, big, 0, 0, 4]);
      merged.set(key, regions.length);
      alias.push([iso, regions.length, normName(p.region), normName(big)]);
      mergedPts.set(regions.length, []);
    }
    id = merged.get(key);
    mergedPts.get(id).push([+p.longitude, +p.latitude]);
  } else {
    let zh = (p.name_zh || p.name || '').trim();
    if (iso === 'CN' || iso === 'TW') zh = zh.replace(/(维吾尔自治区|壮族自治区|回族自治区|自治区|省)$/, '').replace(/^(北京|天津|上海|重庆)市$/, '$1');
    regions.push([iso, zh, +(+p.longitude).toFixed(2), +(+p.latitude).toFixed(2), p.labelrank ?? 9]);
    id = regions.length;
  }
  if (id > 65535) throw new Error('省/州数超过 65535');
  const names = [p.name, p.name_en, p.name_local, p.woe_name, p.gn_name, p.gns_name, p.name_zh, p.name_zht, ...(p.name_alt || '').split('|')];
  if (['US', 'CA', 'AU', 'BR', 'MX', 'IN'].includes(iso)) names.push(p.postal); // 这些国家常直接填州缩写
  if (big) names.push(p.region, big); // 合并的大区，大区名也参与下面的别名归组
  const set = new Set(names.filter(Boolean).map(normName).filter((x) => x.length >= 2));
  for (const group of EXTRA[iso] || []) if (group.some((w) => set.has(normName(w)))) group.forEach((w) => set.add(normName(w)));
  const row = alias.find((a) => a[1] === id);
  if (row) set.forEach((x) => { if (!row.includes(x)) row.push(x); });
  else alias.push([iso, id, ...set]);
  fill(aids, f.geometry, id);
}
for (const [id, pts] of mergedPts) {
  regions[id - 1][2] = +(pts.reduce((s, q) => s + q[0], 0) / pts.length).toFixed(2);
  regions[id - 1][3] = +(pts.reduce((s, q) => s + q[1], 0) / pts.length).toFixed(2);
}
const abin = zlib.deflateSync(Buffer.from(aids.buffer), { level: 9 });
write('admin1-ids.bin', abin);
write('regions.json', JSON.stringify({ w: W, h: H, list: regions }));
write('region-alias.json', JSON.stringify(alias));

const land = cids.reduce((n, v) => n + (v ? 1 : 0), 0);
console.log(`国家 ${countries.length} 个，陆地 ${(land / cids.length * 100).toFixed(1)}%，world-ids.bin ${(cbin.length / 1024).toFixed(0)} KB`);
console.log(`省/州 ${regions.length} 个，admin1-ids.bin ${(abin.length / 1024).toFixed(0)} KB，regions.json ${(JSON.stringify(regions).length / 1024).toFixed(0)} KB`);
console.log('中国：', regions.filter((r) => r[0] === 'CN').map((r) => r[1]).join('、'));
