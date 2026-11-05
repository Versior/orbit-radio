// 全局状态：面板 S、播放器 P、AI 找台 A。只放数据，不放逻辑
import { store } from './util.js';

const S = {
  panel: null, // 'place' | 'ai' | 'fav' | 'recent'
  place: null, seq: 0,
  favs: store.get('favs', []), recents: store.get('recents', []),
  broken: new Set(),
};

const P = {
  cur: store.get('last', null), queue: [], hls: null, token: 0,
  fallback: false, starting: false, status: 'idle', connectTimer: 0, skips: 0,
  sleepIdx: 0, sleepAt: 0, sleepTimer: 0, sleepTick: 0,
};

const A = { enabled: false, model: '', seq: 0, busy: false, history: [], lastPrompt: '', result: null, location: null, step: '' };

export { S, P, A };
