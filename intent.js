// 找台意图：把一句话变成 Radio Browser 查询计划。
// 有大模型时由服务端生成计划；没有或失败时用这里的本地关键词理解兜底。
// 计划结构：{ reply, queries: [{ title, reason, countrycode?, tag?, language?, name?, geo?: {lat, lon, km} }], followups }

export const NEAR_RE = /附近|周边|身边|本地|我这[儿里边]|当地|nearby/i;

export const EXAMPLES = [
  '此刻适合听什么',
  '巴黎咖啡馆里的爵士',
  '写代码时的 Lo-fi',
  '东京本地电台',
  '练英语，听新闻',
  '牙买加的雷鬼',
];

const CITIES = [
  ['东京|tokyo', 'JP', 35.68, 139.69], ['大阪|osaka', 'JP', 34.69, 135.5], ['京都|kyoto', 'JP', 35.01, 135.77],
  ['首尔|seoul', 'KR', 37.57, 126.98], ['釜山|busan', 'KR', 35.18, 129.08],
  ['北京|beijing', 'CN', 39.9, 116.4], ['上海|shanghai', 'CN', 31.23, 121.47], ['广州|guangzhou', 'CN', 23.13, 113.26],
  ['深圳|shenzhen', 'CN', 22.54, 114.06], ['成都|chengdu', 'CN', 30.57, 104.07],
  ['香港|hong kong', 'HK', 22.32, 114.17], ['台北|taipei', 'TW', 25.03, 121.56], ['新加坡|singapore', 'SG', 1.35, 103.82],
  ['曼谷|bangkok', 'TH', 13.76, 100.5], ['孟买|mumbai', 'IN', 19.08, 72.88], ['迪拜|dubai', 'AE', 25.2, 55.27],
  ['纽约|new york', 'US', 40.71, -74.01], ['洛杉矶|los angeles', 'US', 34.05, -118.24], ['旧金山|san francisco', 'US', 37.77, -122.42],
  ['芝加哥|chicago', 'US', 41.88, -87.63], ['新奥尔良|new orleans', 'US', 29.95, -90.07], ['纳什维尔|nashville', 'US', 36.16, -86.78],
  ['伦敦|london', 'GB', 51.51, -0.13], ['巴黎|paris', 'FR', 48.86, 2.35], ['柏林|berlin', 'DE', 52.52, 13.4],
  ['罗马|rome', 'IT', 41.9, 12.5], ['米兰|milan', 'IT', 45.46, 9.19], ['马德里|madrid', 'ES', 40.42, -3.7],
  ['巴塞罗那|barcelona', 'ES', 41.39, 2.17], ['里斯本|lisbon', 'PT', 38.72, -9.14], ['阿姆斯特丹|amsterdam', 'NL', 52.37, 4.9],
  ['维也纳|vienna', 'AT', 48.21, 16.37], ['布拉格|prague', 'CZ', 50.08, 14.44], ['斯德哥尔摩|stockholm', 'SE', 59.33, 18.07],
  ['莫斯科|moscow', 'RU', 55.76, 37.62], ['伊斯坦布尔|istanbul', 'TR', 41.01, 28.98], ['开罗|cairo', 'EG', 30.04, 31.24],
  ['悉尼|sydney', 'AU', -33.87, 151.21], ['墨尔本|melbourne', 'AU', -37.81, 144.96], ['多伦多|toronto', 'CA', 43.65, -79.38],
  ['温哥华|vancouver', 'CA', 49.28, -123.12], ['墨西哥城|mexico city', 'MX', 19.43, -99.13], ['里约|rio', 'BR', -22.91, -43.17],
  ['圣保罗|sao paulo', 'BR', -23.55, -46.63], ['布宜诺斯艾利斯|buenos aires', 'AR', -34.6, -58.38], ['哈瓦那|havana', 'CU', 23.11, -82.37],
  ['金斯敦|kingston', 'JM', 18.02, -76.8], ['雷克雅未克|reykjavik', 'IS', 64.15, -21.94],
].map(([names, cc, lat, lon]) => ({ names: names.split('|'), label: names.split('|')[0], cc, lat, lon }));

const COUNTRIES = [
  ['中国|china', 'CN'], ['日本|japan', 'JP'], ['韩国|korea', 'KR'], ['美国|usa|america', 'US'], ['英国|uk|britain', 'GB'],
  ['法国|france', 'FR'], ['德国|germany', 'DE'], ['意大利|italy', 'IT'], ['西班牙|spain', 'ES'], ['葡萄牙|portugal', 'PT'],
  ['荷兰|netherlands', 'NL'], ['瑞典|sweden', 'SE'], ['挪威|norway', 'NO'], ['芬兰|finland', 'FI'], ['丹麦|denmark', 'DK'],
  ['瑞士|switzerland', 'CH'], ['奥地利|austria', 'AT'], ['希腊|greece', 'GR'], ['土耳其|turkey', 'TR'], ['俄罗斯|russia', 'RU'],
  ['爱尔兰|ireland', 'IE'], ['冰岛|iceland', 'IS'], ['巴西|brazil', 'BR'], ['墨西哥|mexico', 'MX'], ['阿根廷|argentina', 'AR'],
  ['古巴|cuba', 'CU'], ['牙买加|jamaica', 'JM'], ['加拿大|canada', 'CA'], ['印度|india', 'IN'], ['泰国|thailand', 'TH'],
  ['越南|vietnam', 'VN'], ['印尼|印度尼西亚|indonesia', 'ID'], ['菲律宾|philippines', 'PH'], ['马来西亚|malaysia', 'MY'],
  ['澳大利亚|澳洲|australia', 'AU'], ['新西兰|new zealand', 'NZ'], ['埃及|egypt', 'EG'], ['南非|south africa', 'ZA'],
  ['尼日利亚|nigeria', 'NG'], ['澳门|macau', 'MO'],
].map(([names, cc]) => ({ names: names.split('|'), label: names.split('|')[0], cc }));
const RICH = new Set(['US', 'GB', 'FR', 'DE', 'IT', 'ES', 'NL', 'BR', 'MX', 'AR', 'JP', 'CA', 'AU', 'GR', 'PT', 'CH', 'AT', 'SE', 'RU', 'TR']);

const GENRES = [
  ['爵士|jazz', 'jazz', '爵士'], ['蓝调|布鲁斯|blues', 'blues', '蓝调'], ['灵魂乐|soul', 'soul', '灵魂乐'], ['放克|funk', 'funk', '放克'],
  ['古典|交响|歌剧|classical', 'classical', '古典'], ['钢琴|piano', 'piano', '钢琴'], ['摇滚|rock', 'rock', '摇滚'],
  ['金属|metal', 'metal', '金属'], ['朋克|punk', 'punk', '朋克'], ['独立|indie', 'indie', '独立'], ['流行|pop', 'pop', '流行'],
  ['电子|edm|electronic', 'electronic', '电子'], ['浩室|house', 'house', 'House'], ['techno', 'techno', 'Techno'],
  ['嘻哈|说唱|hip hop|hiphop|rap', 'hip hop', '嘻哈'], ['r&b|rnb', 'rnb', 'R&B'], ['雷鬼|reggae', 'reggae', '雷鬼'],
  ['拉丁|萨尔萨|latin|salsa', 'latin', '拉丁'], ['波萨|bossa', 'bossa nova', '波萨诺瓦'], ['乡村音乐|country music', 'country', '乡村'],
  ['民谣|folk', 'folk', '民谣'], ['氛围|冥想|白噪音|ambient', 'ambient', '氛围'],
  ['安静|放松|舒缓|助眠|睡|chill', 'chillout', '放松'], ['lofi|lo-fi|学习|写代码|写作业|专注|工作', 'lofi', 'Lo-fi'],
  ['咖啡|cafe|lounge', 'lounge', '咖啡馆'], ['热闹|嗨|派对|蹦迪|运动|健身|跑步|dance', 'dance', '舞曲'],
  ['怀旧|老歌|oldies', 'oldies', '老歌'], ['60年代|60s', '60s', '60 年代'], ['70年代|70s', '70s', '70 年代'],
  ['80年代|80s', '80s', '80 年代'], ['90年代|90s', '90s', '90 年代'], ['新闻|时事|news', 'news', '新闻'],
  ['谈话|聊天|访谈|脱口秀|talk', 'talk', '谈话'], ['体育|球赛|足球|sports', 'sports', '体育'], ['动漫|二次元|anime', 'anime', '动漫'],
  ['k-pop|kpop|韩流', 'kpop', 'K-Pop'], ['j-pop|jpop', 'jpop', 'J-Pop'], ['粤语歌|cantopop', 'cantopop', '粤语歌'],
  ['世界音乐|world music', 'world music', '世界音乐'], ['儿童|孩子|宝宝|kids', 'kids', '儿童'],
].map(([words, tag, label]) => ({ words: words.split('|'), tag, label }));

const LANGS = [
  ['英语|英文|english', 'english', '英语'], ['日语|japanese', 'japanese', '日语'], ['法语|french', 'french', '法语'],
  ['西班牙语|spanish', 'spanish', '西班牙语'], ['德语|german', 'german', '德语'], ['韩语|korean', 'korean', '韩语'],
  ['粤语|cantonese', 'cantonese', '粤语'], ['普通话|国语|中文|华语|mandarin', 'chinese', '中文'], ['俄语|russian', 'russian', '俄语'],
  ['意大利语|italian', 'italian', '意大利语'], ['葡萄牙语|portuguese', 'portuguese', '葡萄牙语'],
].map(([words, lang, label]) => ({ words: words.split('|'), lang, label }));

const LABEL_OF_TAG = Object.fromEntries(GENRES.map((g) => [g.tag, g.label]));

function timeMood(hour) {
  if (hour < 6) return { tags: ['ambient', 'jazz'], reason: '夜深了，来点安静的' };
  if (hour < 10) return { tags: ['news', 'pop'], reason: '早上好，听听新闻和轻快的歌' };
  if (hour < 14) return { tags: ['lofi', 'pop'], reason: '上午适合专注一点' };
  if (hour < 18) return { tags: ['chillout', 'indie'], reason: '下午犯困，放松一下' };
  if (hour < 22) return { tags: ['jazz', 'soul'], reason: '傍晚了，爵士和灵魂乐正合适' };
  return { tags: ['lofi', 'ambient'], reason: '睡前慢慢收心' };
}

const has = (text, words) => words.some((w) => text.includes(w));

export function localPlan(prompt, ctx) {
  const text = prompt.toLowerCase();
  const city = CITIES.find((c) => has(text, c.names));
  const randomCountry = /换个国家|别的国家|其[它他]国家|随便.*国/.test(prompt);
  let country = !city && COUNTRIES.find((c) => has(text, c.names));
  if (randomCountry) {
    // 只在电台数量多的国家里随机，避免换过去搜不到
    const pool = COUNTRIES.filter((c) => RICH.has(c.cc) && c.cc !== country?.cc && c.cc !== ctx.current?.cc);
    country = pool[(Math.random() * pool.length) | 0];
  }
  const genres = [...new Set(GENRES.filter((g) => has(text, g.words)).map((g) => g.tag))].slice(0, 3);
  const lang = LANGS.find((l) => has(text, l.words));
  const near = NEAR_RE.test(prompt);

  let place = null;
  if (city && !randomCountry) place = { label: city.label, countrycode: city.cc, geo: { lat: city.lat, lon: city.lon, km: 60 } };
  else if (country) place = { label: country.label, countrycode: country.cc };
  else if (near && ctx.location) place = { label: '你附近', geo: { lat: ctx.location.lat, lon: ctx.location.lon, km: 100 } };
  else if (near && ctx.region) place = { label: ctx.regionLabel || ctx.region, countrycode: ctx.region };

  // 一个关键词都没认出来时，当作电台名称搜索（顺带给一组适合此刻的台）
  const timeOnly = /深夜|半夜|凌晨|睡前|晚上|夜里|早上|早晨|清晨|起床|此刻|现在|这会儿|随便|推荐/.test(prompt);
  if (!city && !country && !genres.length && !lang && !near && !timeOnly && prompt.trim().length <= 24) {
    const name = prompt.trim();
    const tm = timeMood(ctx.hour);
    return {
      reply: `按名称找「${name}」。`,
      queries: [
        { name: name.toLowerCase(), title: `名称里有「${name}」`, reason: '按电台名称搜索' },
        { tag: tm.tags[0], title: LABEL_OF_TAG[tm.tags[0]] || tm.tags[0], reason: tm.reason },
      ],
      followups: ['此刻适合听什么', '来点新闻', '随便来点爵士'],
    };
  }

  let tags = genres;
  let reason = '';
  const wantsTaste = /推荐|猜|老样子|常听|我喜欢/.test(prompt) && ctx.taste.tags.length;
  if (!tags.length && wantsTaste) { tags = ctx.taste.tags.slice(0, 2); reason = '按你常听的风格'; }
  const timeWords = /深夜|半夜|凌晨|睡前|晚上|夜里|早上|早晨|清晨|起床|此刻|现在|这会儿/.test(prompt);
  if (!tags.length && !lang && (!place || timeWords)) {
    let hour = ctx.hour;
    if (/深夜|半夜|凌晨/.test(prompt)) hour = 2;
    else if (/睡前|夜里|晚上/.test(prompt)) hour = 23;
    else if (/早上|早晨|清晨|起床/.test(prompt)) hour = 7;
    const tm = timeMood(hour);
    tags = tm.tags; reason = tm.reason;
  }

  const base = {};
  if (place?.countrycode) base.countrycode = place.countrycode;
  if (place?.geo) base.geo = place.geo;
  if (lang) base.language = lang.lang;
  const prefix = [place?.label, lang?.label].filter(Boolean).join(' · ');

  const queries = tags.length
    ? tags.map((tag) => ({ ...base, tag, title: [prefix, LABEL_OF_TAG[tag] || tag].filter(Boolean).join(' · '), reason: reason || `关键词：${LABEL_OF_TAG[tag] || tag}` }))
    : [{ ...base, title: prefix || '热门电台', reason: place?.geo ? `${place.geo.km} 公里范围内` : '按收听热度' }];

  const keys = [place?.label, lang?.label, ...genres.map((t) => LABEL_OF_TAG[t])].filter(Boolean);
  const reply = keys.length ? `按「${keys.join(' + ')}」帮你找了找。` : `${reason || '先给你挑几个'}。`;
  return { reply, queries, followups: ['更安静一点', '来点新闻', '换个国家', '热闹一些'] };
}

export async function remotePlan(prompt, context, history) {
  let r;
  try {
    r = await fetch('/api/ai/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context, history }),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw Object.assign(new Error('network'), { code: 'network' });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'upstream'), { code: data.error || 'upstream' });
  return data;
}
