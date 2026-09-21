/**
 * Discord 状态显示：把房间状态拼成要给 Discord 看的那几行字。
 *
 * 纯函数，不碰 DOM、不碰 IPC —— app.js 负责取状态、比对有没有变、交给主进程。
 * 主进程还会再校验一遍（src/main/discordPresence.js 的 sanitizeActivity）。
 *
 * 隐私默认值是保守的：总开关默认关；片名默认不显示（所有 Discord 好友都看得到）；
 * 「加入放映」按钮只在有房间链接（谁点谁进）时出现 —— 一对一邀请本来就只能给一个人。
 */

const STORAGE_KEY = 'sw.discord';
export const RELEASES_URL = 'https://github.com/Felis-desuwa/NoxReel/releases/latest';

export const PRESENCE_DEFAULTS = Object.freeze({ enabled: false, showTitle: false, showJoin: true });

/** 读设置。坏值、读不到（隐私模式、存储被清）都退回默认 —— 默认就是「不显示」。 */
export function loadPresenceSettings(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
    return {
      enabled: raw.enabled === true,
      showTitle: raw.showTitle === true,
      showJoin: raw.showJoin !== false,
    };
  } catch {
    return { ...PRESENCE_DEFAULTS };
  }
}

export function savePresenceSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ enabled: !!settings.enabled, showTitle: !!settings.showTitle, showJoin: settings.showJoin !== false })
    );
  } catch {}
}

/** 片名去掉常见的视频扩展名：状态里写「Movie.2019.mkv」不如写「Movie.2019」。 */
function tidyTitle(title) {
  return String(title || '')
    .trim()
    .replace(/\.(mkv|mp4|m4v|mov|avi|ts|webm|wmv|flv)$/i, '');
}

/**
 * @param {object} st  房间状态
 * @param {string} [st.title]      当前片名（用户内容，原样显示、不翻译）
 * @param {boolean} st.paused
 * @param {boolean} st.started     这一部开播过没有（没开播时是「等待开播」，不是「已暂停」）
 * @param {number} [st.position]   秒
 * @param {number} [st.duration]   秒
 * @param {number} st.members      含自己
 * @param {number} st.capacity
 * @param {string} [st.roomLink]   房间链接（https 跳转页），只有房间链接模式才有
 * @param {string} st.partyId      这个房间的随机标识（不含任何可以拿来进房的东西）
 * @param {number} [st.now]        毫秒，测试注入
 * @param {object} settings        loadPresenceSettings() 的结果
 * @param {(s: string) => string} t 翻译函数
 * @returns {object|null} 交给 window.sw.discord.setActivity 的内容；null 表示不该显示
 */
export function buildActivity(st, settings, t = (s) => s) {
  if (!settings?.enabled || !st) return null;
  const title = tidyTitle(st.title);
  const details = settings.showTitle && title ? t(`在看《${title}》`) : t('和朋友一起看片');

  const members = Math.max(1, Math.round(Number(st.members) || 1));
  const capacity = Math.max(members, Math.round(Number(st.capacity) || members));
  const room = t(`房间 ${members}/${capacity} 人`);
  const phase = !st.started ? t('等待开播') : st.paused ? t('已暂停') : '';
  const state = phase ? `${phase} · ${room}` : room;

  const activity = { details, state, largeText: 'NoxReel', partyId: st.partyId, partySize: [members, capacity] };

  // 播放中才给时间：Discord 按它显示进度条。暂停时给了它会自己往前走，反而是错的
  const now = st.now ?? Date.now();
  const pos = Number(st.position);
  const dur = Number(st.duration);
  if (st.started && !st.paused && Number.isFinite(pos) && pos >= 0) {
    activity.startMs = Math.round(now - pos * 1000);
    if (Number.isFinite(dur) && dur > pos) activity.endMs = Math.round(activity.startMs + dur * 1000);
  }

  const buttons = [];
  if (settings.showJoin && st.roomLink) buttons.push({ label: t('加入放映'), url: st.roomLink });
  buttons.push({ label: t('下载 NoxReel'), url: RELEASES_URL });
  activity.buttons = buttons;
  return activity;
}

/**
 * 判断「值不值得再发一次」的键：进度按 10 秒粗化 —— 播放中每个 tick 位置都在变，
 * 不粗化的话每秒都算「变了」。主进程那边还有 15 秒限频兜底。
 */
export function activityKey(activity) {
  if (!activity) return 'off';
  const start = activity.startMs ? Math.round(activity.startMs / 10000) : 0;
  return JSON.stringify([activity.details, activity.state, start, activity.partySize, activity.buttons.map((b) => b.url)]);
}
