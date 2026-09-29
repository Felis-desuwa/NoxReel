/**
 * 每部片上次看到哪（只存在本机，localStorage 的 sw.watchProgress）。
 *
 * 房主下次放同一部片时问一句「从 23:14 接着看？」—— 一部长片分几晚看、追剧时用。
 * 本地片子按 fileId 认（同样的内容在哪台机器上都是同一个 id），在线视频按网址认。
 * 谁开房都能用上：每台电脑都记自己看过的，问的只是房主。
 */

export const WATCH_PROGRESS_KEY = 'sw.watchProgress';

/** 最多记多少部，超出的按最久没看的删掉。 */
export const MAX_ENTRIES = 300;
/** 看了不到这么多秒不算「看过」，不问。 */
export const MIN_RESUME_SECONDS = 60;
/** 离片尾不到这么多秒、或看过了这个比例，算看完了，不问。 */
export const END_MARGIN_SECONDS = 120;
export const END_FRACTION = 0.95;
/** 接着看时往回退几秒，让人记起刚才演到哪。 */
export const REWIND_SECONDS = 5;

const MAX_KEY = 2200;
const MAX_TITLE = 200;

/** 列表里一项对应的记录键；认不出来的返回 null。 */
export function progressKey(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.kind === 'file' && typeof item.fileId === 'string' && item.fileId) return `f:${item.fileId}`;
  if (item.kind === 'link' && typeof item.url === 'string' && item.url) {
    const key = `l:${item.url}`;
    return key.length <= MAX_KEY ? key : null;
  }
  return null;
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pos = Number(raw.pos);
  const dur = Number(raw.dur);
  const at = Number(raw.at);
  if (!Number.isFinite(pos) || pos < 0 || pos > 86400) return null;
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    pos,
    dur: Number.isFinite(dur) && dur > 0 && dur <= 86400 ? dur : 0,
    title: typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : '',
    at,
  };
}

/**
 * 从这条记录算出该从哪接着放；不该问的（没看多少、已经看完了）返回 0。
 * 片长以现在知道的为准（记下时可能还不知道片长）。
 */
export function resumePoint(entry, durationSec = 0) {
  if (!entry) return 0;
  const pos = entry.pos;
  if (!(pos >= MIN_RESUME_SECONDS)) return 0;
  const dur = durationSec > 0 ? durationSec : entry.dur;
  if (dur > 0 && (pos >= dur - END_MARGIN_SECONDS || pos >= dur * END_FRACTION)) return 0;
  return Math.max(0, Math.floor(pos - REWIND_SECONDS));
}

export class WatchProgress {
  /**
   * @param {object} opts
   * @param {Storage} [opts.storage]  localStorage；拿不到时只记在内存里
   * @param {() => number} [opts.now]
   * @param {number} [opts.max]
   */
  constructor({ storage = null, now = () => Date.now(), max = MAX_ENTRIES } = {}) {
    this.storage = storage;
    this.now = now;
    this.max = max;
    this.entries = new Map();
    this.dirty = false;
    this._load();
  }

  _load() {
    let raw = null;
    try {
      raw = JSON.parse(this.storage?.getItem(WATCH_PROGRESS_KEY) || 'null');
    } catch {
      raw = null;
    }
    const items = raw && typeof raw === 'object' && raw.v === 1 && raw.items && typeof raw.items === 'object' ? raw.items : {};
    for (const [key, value] of Object.entries(items)) {
      if (typeof key !== 'string' || key.length > MAX_KEY || !/^[fl]:/.test(key)) continue;
      const entry = cleanEntry(value);
      if (entry) this.entries.set(key, entry);
    }
    this._trim();
  }

  _trim() {
    if (this.entries.size <= this.max) return;
    const sorted = [...this.entries.entries()].sort((a, b) => b[1].at - a[1].at);
    this.entries = new Map(sorted.slice(0, this.max));
  }

  get(key) {
    return key ? this.entries.get(key) || null : null;
  }

  /** 该从哪接着放（秒）；0 = 不用问。 */
  resumeFor(key, durationSec = 0) {
    return resumePoint(this.get(key), durationSec);
  }

  /** 记下这一部看到哪了。只改内存，flush() 才落盘（调用方隔一会儿落一次）。 */
  record(key, { pos, dur = 0, title = '' } = {}) {
    if (!key || !Number.isFinite(pos) || pos < 0) return;
    const entry = cleanEntry({ pos, dur, title, at: this.now() });
    if (!entry) return;
    // 删掉再放回去：Map 的顺序就是最近看过的顺序
    this.entries.delete(key);
    this.entries.set(key, entry);
    this._trim();
    this.dirty = true;
  }

  forget(key) {
    if (key && this.entries.delete(key)) this.dirty = true;
  }

  clear() {
    if (!this.entries.size) return;
    this.entries.clear();
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const items = {};
    for (const [key, entry] of this.entries) items[key] = entry;
    try {
      this.storage?.setItem(WATCH_PROGRESS_KEY, JSON.stringify({ v: 1, items }));
    } catch {
      // 存不下（配额满了）就算了，只是下次不问
    }
  }
}
