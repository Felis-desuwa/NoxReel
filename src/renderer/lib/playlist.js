/**
 * 播放列表（纯函数，桌面和安卓共用）。
 *
 * 模型是「队列 + 已播放区」：
 *  - queue[0] 就是当前项。列表顺序 = 播放顺序 = 传输顺序。
 *  - 开播之前，谁被拖到第一位谁就是当前项；开播之后往当前项上面拖要先确认，
 *    确认后走 playNow：原当前项退到第二位，记下 resumeAt，回头从那儿接着放。
 *  - seq 是「当前项」的序号，每换一次加 1。同步消息带着它，旧片的指令不会落到新片上。
 *  - rev 是整张表的版本，只有房主能改，单调递增。
 *
 * 这里不碰 IO、不碰时间，所有外部信息（谁在操作、他是不是控制者、现在播到哪、新 id）
 * 都由调用方通过 ctx 传进来，所以两端逐字节一致，也好测。
 */

export const MAX_QUEUE = 100;
export const MAX_HISTORY = 30;
export const MAX_NAME = 200;
export const MAX_URL = 2048;
export const MAX_ADDER_NAME = 40;
export const HEAD_READY_BYTES = 8 * 1024 * 1024;

const ITEM_ID_RE = /^[a-f0-9]{8,32}$/;
const FILE_ID_RE = /^[a-f0-9]{32}$/;
// 和 signaling.randomPeerId 的字母表一致：聊天安全版 base64 里有 . 和 -（旧码里还有 _）
const PEER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SLOT = 0xffffffff;

const isSlot = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_SLOT;
const isCount = (v) => Number.isSafeInteger(v) && v >= 1;
const clampText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// RegExp.test 会先把参数转成字符串：['abc'] 和 12345678 都能蒙混过关，所以先查类型
const matches = (re, v) => typeof v === 'string' && re.test(v);

export function createPlaylist() {
  return { rev: 0, seq: 0, queue: [], history: [], started: false, autoplay: true, nextSlot: 1 };
}

export function currentItem(state) {
  return state?.queue?.[0] || null;
}

export function findItem(state, id) {
  const qi = state.queue.findIndex((it) => it.id === id);
  if (qi !== -1) return { where: 'queue', index: qi, item: state.queue[qi] };
  const hi = state.history.findIndex((it) => it.id === id);
  if (hi !== -1) return { where: 'history', index: hi, item: state.history[hi] };
  return null;
}

/** 队列和已播放区里还引用着的 fileId。不在这里面的会话就可以关了。 */
export function referencedFileIds(state) {
  const out = new Set();
  for (const it of [...(state?.queue || []), ...(state?.history || [])]) {
    if (it.kind === 'file' && it.fileId) out.add(it.fileId);
  }
  return out;
}

/** 列表里的文件项，给 swarm.setCatalog 用。 */
export function catalogOf(state) {
  const seen = new Set();
  const out = [];
  for (const it of [...(state?.queue || []), ...(state?.history || [])]) {
    if (it.kind !== 'file' || seen.has(it.slot)) continue;
    seen.add(it.slot);
    out.push({ slot: it.slot, fileId: it.fileId, size: it.size, chunkCount: it.chunkCount, chunkSize: it.chunkSize });
  }
  return out;
}

/* ------------------------------ 条目校验 ------------------------------ */

function normalizeFileFields(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clampText(raw.name, MAX_NAME).trim();
  if (
    !matches(FILE_ID_RE, raw.fileId) ||
    !name ||
    !Number.isSafeInteger(raw.size) ||
    raw.size < 1 ||
    !Number.isSafeInteger(raw.chunkSize) ||
    raw.chunkSize < 1 ||
    !isCount(raw.chunkCount) ||
    raw.chunkCount !== Math.ceil(raw.size / raw.chunkSize)
  ) {
    return null;
  }
  const durationSec = Number(raw.durationSec);
  return {
    kind: 'file',
    fileId: raw.fileId,
    name,
    size: raw.size,
    chunkSize: raw.chunkSize,
    chunkCount: raw.chunkCount,
    durationSec: Number.isFinite(durationSec) && durationSec > 0 && durationSec <= 86400 ? durationSec : 0,
  };
}

function normalizeLinkFields(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || raw.url.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.href.length > MAX_URL) return null;
  const durationSec = Number(raw.durationSec);
  return {
    kind: 'link',
    url: url.href,
    title: clampText(raw.title, MAX_NAME).trim(),
    durationSec: Number.isFinite(durationSec) && durationSec > 0 && durationSec <= 86400 ? durationSec : 0,
  };
}

/** 快照里的一项。结构不对就返回 null。 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || !matches(ITEM_ID_RE, raw.id)) return null;
  const base = raw.kind === 'file' ? normalizeFileFields(raw) : raw.kind === 'link' ? normalizeLinkFields(raw) : null;
  if (!base) return null;
  if (base.kind === 'file' && !isSlot(raw.slot)) return null;
  const resumeAt = Number(raw.resumeAt);
  return {
    id: raw.id,
    ...base,
    ...(base.kind === 'file' ? { slot: raw.slot } : {}),
    addedBy: matches(PEER_ID_RE, raw.addedBy) ? raw.addedBy : '',
    addedByName: clampText(raw.addedByName, MAX_ADDER_NAME),
    sourceId: matches(PEER_ID_RE, raw.sourceId) ? raw.sourceId : '',
    sourceGone: raw.sourceGone === true,
    resumeAt: Number.isFinite(resumeAt) && resumeAt > 0 && resumeAt <= 86400 ? resumeAt : 0,
  };
}

/**
 * 收到的列表快照。只接受结构完整的；任何一项不对就整张不要 ——
 * 少一项的列表比没有列表更糟，播放顺序会悄悄错位。
 */
export function validateSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { rev, seq, nextSlot } = raw;
  if (!Number.isSafeInteger(rev) || rev < 0 || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (!isSlot(nextSlot)) return null;
  if (!Array.isArray(raw.queue) || raw.queue.length > MAX_QUEUE) return null;
  if (!Array.isArray(raw.history) || raw.history.length > MAX_HISTORY) return null;
  const queue = raw.queue.map(normalizeItem);
  const history = raw.history.map(normalizeItem);
  if (queue.includes(null) || history.includes(null)) return null;
  const ids = new Set();
  const slotOfFile = new Map();
  const fileOfSlot = new Map();
  for (const it of [...queue, ...history]) {
    if (ids.has(it.id)) return null;
    ids.add(it.id);
    if (it.kind !== 'file') continue;
    // 一个 fileId 只对应一个槽位，反过来也一样，否则两端会把位图套到别的片上
    if (slotOfFile.has(it.fileId) && slotOfFile.get(it.fileId) !== it.slot) return null;
    if (fileOfSlot.has(it.slot) && fileOfSlot.get(it.slot) !== it.fileId) return null;
    if (it.slot >= nextSlot) return null;
    slotOfFile.set(it.fileId, it.slot);
    fileOfSlot.set(it.slot, it.fileId);
  }
  return {
    rev,
    seq,
    queue,
    history,
    started: raw.started === true && queue.length > 0,
    autoplay: raw.autoplay !== false,
    nextSlot,
  };
}

/* ------------------------------ 操作 ------------------------------ */

const fail = (state, reason) => ({ ok: false, state, reason });

function clone(state) {
  return { ...state, queue: state.queue.slice(), history: state.history.slice() };
}

/** 当前项变了：seq 加一，开播标志清零。 */
function advanceSeq(next) {
  next.seq += 1;
  next.started = false;
}

function pushHistory(next, item) {
  const { resumeAt, ...rest } = item;
  next.history.unshift({ ...rest, resumeAt: 0 });
  if (next.history.length > MAX_HISTORY) next.history.length = MAX_HISTORY;
}

function slotFor(next, fileId) {
  for (const it of [...next.queue, ...next.history]) {
    if (it.kind === 'file' && it.fileId === fileId) return it.slot;
  }
  const slot = next.nextSlot;
  next.nextSlot += 1;
  return slot;
}

/** 队列里是不是已经有同一个链接。 */
function linkQueued(next, item) {
  return item.kind === 'link' && next.queue.some((it) => it.kind === 'link' && it.url === item.url);
}

/**
 * 在房主那里执行一条操作。
 *
 * @param {object} state 当前列表
 * @param {object} op    {type, ...}
 * @param {object} ctx   {actor, actorName, isController(actor)->bool, newId()->string,
 *                        position: 房间此刻播到的秒数（playNow 记 resumeAt 用）}
 * @returns {{ok:boolean, state:object, reason?:string, effects?:string[]}}
 */
export function applyOp(state, op, ctx) {
  if (!op || typeof op !== 'object' || typeof op.type !== 'string') return fail(state, '无效的操作');
  // 权限在执行的这一刻重新判断：操作在路上的时候，这个人可能已经被降级了
  if (!ctx?.isController?.(ctx.actor)) return fail(state, '你没有编辑播放列表的权限');
  const next = clone(state);
  const cur = currentItem(state);

  switch (op.type) {
    case 'add': {
      if (next.queue.length >= MAX_QUEUE) return fail(state, `列表最多 ${MAX_QUEUE} 项`);
      const raw = op.item;
      const fields = raw?.kind === 'file' ? normalizeFileFields(raw) : raw?.kind === 'link' ? normalizeLinkFields(raw) : null;
      if (!fields) return fail(state, '无效的列表条目');
      if (fields.kind === 'file' && next.queue.some((it) => it.kind === 'file' && it.fileId === fields.fileId)) {
        return fail(state, '列表里已经有这部片了');
      }
      if (fields.kind === 'link' && next.queue.some((it) => it.kind === 'link' && it.url === fields.url)) {
        return fail(state, '列表里已经有这个链接了');
      }
      const id = ctx.newId();
      const item = {
        id,
        ...fields,
        ...(fields.kind === 'file' ? { slot: slotFor(next, fields.fileId) } : {}),
        addedBy: ctx.actor,
        addedByName: clampText(ctx.actorName, MAX_ADDER_NAME),
        // 本地文件由添加者供片；链接谁都不用供
        sourceId: fields.kind === 'file' ? (matches(PEER_ID_RE, op.sourceId) ? op.sourceId : ctx.actor) : '',
        sourceGone: false,
        resumeAt: 0,
      };
      // 已播放区里有同一部片的旧条目，就让它退出已播放区，免得同一部片出现两次
      next.history = next.history.filter((it) => !(it.kind === 'file' && it.fileId === item.fileId));
      next.queue.push(item);
      if (next.queue.length === 1) advanceSeq(next);
      next.rev += 1;
      return { ok: true, state: next, id };
    }

    case 'move': {
      const from = next.queue.findIndex((it) => it.id === op.id);
      if (from === -1) return fail(state, '列表里没有这一项');
      if (op.beforeId === op.id) return { ok: true, state, unchanged: true };
      const [item] = next.queue.splice(from, 1);
      let to = next.queue.length;
      if (op.beforeId !== null && op.beforeId !== undefined) {
        to = next.queue.findIndex((it) => it.id === op.beforeId);
        if (to === -1) return fail(state, '列表里没有目标位置');
      }
      next.queue.splice(to, 0, item);
      const newCur = next.queue[0];
      if (newCur.id !== cur.id) {
        // 开播之后换当前项必须经过确认（走 playNow），不能被一次拖动悄悄换掉
        if (state.started) return fail(state, 'needs-confirm');
        advanceSeq(next);
      }
      if (next.queue.every((it, i) => it.id === state.queue[i].id)) return { ok: true, state, unchanged: true };
      next.rev += 1;
      return { ok: true, state: next };
    }

    case 'remove': {
      const found = findItem(next, op.id);
      if (!found) return fail(state, '列表里没有这一项');
      if (found.where === 'history') {
        next.history.splice(found.index, 1);
      } else {
        next.queue.splice(found.index, 1);
        if (found.index === 0) advanceSeq(next);
      }
      next.rev += 1;
      return { ok: true, state: next };
    }

    case 'playNow': {
      const found = findItem(next, op.id);
      if (!found) return fail(state, '列表里没有这一项');
      if (found.where === 'queue' && found.index === 0) return { ok: true, state, unchanged: true };
      let item;
      if (found.where === 'history') {
        if (next.queue.length >= MAX_QUEUE) return fail(state, `列表最多 ${MAX_QUEUE} 项`);
        if (linkQueued(next, found.item)) return fail(state, '列表里已经有这个链接了');
        [item] = next.history.splice(found.index, 1);
      } else {
        [item] = next.queue.splice(found.index, 1);
      }
      if (next.queue.length && state.started) {
        // 被顶下去的当前项记住播到哪了，回头从那儿接着放
        const position = Number(ctx.position);
        const old = next.queue[0];
        next.queue[0] = { ...old, resumeAt: Number.isFinite(position) && position > 0 ? Math.min(position, 86400) : old.resumeAt };
      }
      next.queue.unshift(item);
      advanceSeq(next);
      next.rev += 1;
      return { ok: true, state: next };
    }

    case 'requeue': {
      const hi = next.history.findIndex((it) => it.id === op.id);
      if (hi === -1) return fail(state, '已播放区里没有这一项');
      if (next.queue.length >= MAX_QUEUE) return fail(state, `列表最多 ${MAX_QUEUE} 项`);
      if (linkQueued(next, next.history[hi])) return fail(state, '列表里已经有这个链接了');
      const [item] = next.history.splice(hi, 1);
      next.queue.push({ ...item, resumeAt: 0 });
      if (next.queue.length === 1) advanceSeq(next);
      next.rev += 1;
      return { ok: true, state: next };
    }

    case 'ended': {
      // 只认当前这一场的「放完了」，晚到的旧消息不能把下一部也跳过去
      if (op.seq !== state.seq || !cur) return { ok: true, state, unchanged: true };
      const [done] = next.queue.splice(0, 1);
      pushHistory(next, done);
      advanceSeq(next);
      next.rev += 1;
      return { ok: true, state: next, effects: next.queue.length ? ['advanced'] : ['finished'] };
    }

    case 'forceStart': {
      if (op.seq !== state.seq || !cur) return { ok: true, state, unchanged: true };
      return { ok: true, state, unchanged: true, effects: ['start'] };
    }

    case 'setAutoplay': {
      if (typeof op.on !== 'boolean') return fail(state, '无效的操作');
      if (next.autoplay === op.on) return { ok: true, state, unchanged: true };
      next.autoplay = op.on;
      next.rev += 1;
      return { ok: true, state: next };
    }

    default:
      return fail(state, '不认识的操作');
  }
}

/**
 * 把 id 挪到 beforeId 前面（null 表示放到最后）之后的顺序，和 applyOp 的 move 同一套规则。
 * 挪不了（找不到、插到自己前面）返回 null。界面拿它预判「拖完谁是第一位」「是不是拖回了原位」。
 */
export function reorderIds(ids, id, beforeId) {
  const from = ids.indexOf(id);
  if (from === -1 || beforeId === id) return null;
  const next = ids.slice();
  next.splice(from, 1);
  const to = beforeId === null || beforeId === undefined ? next.length : next.indexOf(beforeId);
  if (to === -1) return null;
  next.splice(to, 0, id);
  return next;
}

/** 房主收到当前 seq 的第一条「开始播放」时调用。 */
export function markStarted(state, seq) {
  if (state.started || seq !== state.seq || !state.queue.length) return state;
  return { ...state, started: true, rev: state.rev + 1 };
}

/** 房主按在线成员刷新「来源已离开」标记。只有房主知道添加者还在不在。 */
export function markSources(state, isOnline) {
  let changed = false;
  const mark = (it) => {
    if (it.kind !== 'file' || !it.sourceId) return it;
    const gone = !isOnline(it.sourceId);
    if (gone === it.sourceGone) return it;
    changed = true;
    return { ...it, sourceGone: gone };
  };
  const queue = state.queue.map(mark);
  const history = state.history.map(mark);
  return changed ? { ...state, queue, history, rev: state.rev + 1 } : state;
}

/**
 * 传输顺序：按队列顺序，跳过链接、本机已收完的、没人能供的、磁盘放不下的。
 * 结果的第一项就是现在该向别人要的那部。
 *
 * @param {object} ctx {isComplete(item), hasSource(item), diskBlocked(item)}
 */
export function transferOrder(state, ctx) {
  const out = [];
  const seen = new Set();
  for (const it of state?.queue || []) {
    if (it.kind !== 'file' || seen.has(it.fileId)) continue;
    seen.add(it.fileId);
    if (ctx.isComplete(it)) continue;
    if (!ctx.hasSource(it)) continue;
    if (ctx.diskBlocked?.(it)) continue;
    out.push(it);
  }
  return out;
}

/**
 * 某个成员对当前项算不算准备好了。
 *  - 自己是片源：直接就绪。
 *  - 可信房间：两条同时成立 —— 连续片头够 min(8MB, 大小)（容器索引），
 *    并且从起播点起有足够的连续数据。
 *  - 安全模式：必须收完并且扫描通过。
 *  - 链接：允许了站点且解析成功；自己选择跳过也算，不挡别人。
 *
 * 起播点不在片头有两种情况：中途加入房间（从房间位置 P 起播），以及「回头接着放」
 * （从 resumeAt 起播）。后者是本来就有的缺陷 —— 只看片头会让全员就绪之后立刻全员卡死。
 * local.startByte 缺省（或为 0）时与旧版逐位等价，从片头起播的用例一个都不受影响。
 *
 * 「起播点在不在片头」要由 local.midJoin 说了算，不能只看 startByte：字节位置是
 * 「秒数 × 码率」算出来的，码率未知（房主没装 ffmpeg，清单里就没有时长）时它恒为 0，
 * 于是整套门槛静默失效 —— 人以为自己准备好了，一起播就落在空洞上。这种情况下
 * 可信房间不提前起播，等收完再说：宁可多等，也好过起播就撞上连续区尽头。
 */
export function isItemReady(item, local) {
  if (!item) return false;
  if (item.kind === 'link') return local.skipped === true || (local.consented === true && local.resolved === true);
  if (local.isSeeder) return true;
  if (local.mode === 'trusted') {
    const head = Math.min(HEAD_READY_BYTES, item.size || HEAD_READY_BYTES);
    if ((local.contiguousBytes || 0) < head) return false;
    if (!local.midJoin && !(local.startByte > 0)) return true;
    // 中途加入，可是起播点换算不出字节位置（码率未知）：判不了起播点附近有没有数据，
    // 只能等整部收完。
    if (!(local.startByte > 0)) return local.complete === true;
    // runNeeded 由调用方按「恢复阈值 × 码率 + 解复用预读」算好传进来，
    // 这里不碰码率，保持「纯函数不依赖外部信息」的约定。
    return (local.runBytes || 0) >= (local.runNeeded || 0);
  }
  return local.complete === true && local.scanStatus === 'clean';
}

/** 还没准备好的人。ready 是 peerId -> bool（只记当前 seq 的），members 是 [{peerId, name}]。 */
export function waitingFor(members, ready) {
  return members.filter((m) => ready.get(m.peerId) !== true);
}
