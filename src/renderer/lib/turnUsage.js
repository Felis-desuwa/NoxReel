/**
 * Cloudflare TURN 的本机用量计量（只在桌面端用）。
 *
 * Cloudflare 按「从 Cloudflare 出去的流量」计费，而且没有「超量自动停」，只会发邮件提醒。
 * 所以由 NoxReel 在本机数：每条连接定期 getStats()，把本地候选是 Cloudflare 中继的候选对上
 * 收发的字节都算进去 —— 进出方向怎么算钱界定不清，保守起见两个方向都记。
 *
 * 计数器是按连接、按候选对累计的，所以只能记增量：每条连接记住上次读到的值。
 * 连接用 RTCPeerConnection 对象本身当键 —— 重连、换 Peer 都是一个新的 pc，计数从零开始，
 * 不会把旧连接的字节再算一遍；极简模式换 peerId（renamePeer）pc 不变，也不会重算。
 *
 * 不只看「选中的」那一对，而是把所有经 Cloudflare 中继的候选对都算上：两次采样之间选中的候选对
 * 可能换过，只看采样那一刻选中的那一对，前一对上最后那段字节就漏了。没选中的候选对上只有连通性检查，
 * 而 bytesSent / bytesReceived 本来就不含连通性检查，多算的几乎是零。
 */

export const CLOUDFLARE_TURN_HOST = 'turn.cloudflare.com';

/** 这条 turn: / turns: 地址指向 Cloudflare 的 TURN 吗。 */
export function isCloudflareTurnUrl(url) {
  const m = /^turns?:([^?:/[\]]+)/i.exec(String(url || '').trim());
  return Boolean(m && m[1].toLowerCase() === CLOUDFLARE_TURN_HOST);
}

/**
 * 这条连接配置里的中继是不是全都是 Cloudflare 的。
 * 候选的 url 字段偶尔拿不到，那时只能看配置：配置里只有 Cloudflare 一家中继，中继候选就只能是它的。
 */
export function onlyCloudflareRelays(iceServers) {
  const turn = [];
  for (const server of Array.isArray(iceServers) ? iceServers : []) {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    for (const url of urls) if (/^turns?:/i.test(String(url || ''))) turn.push(url);
  }
  return turn.length > 0 && turn.every(isCloudflareTurnUrl);
}

/**
 * 从一份 getStats() 报告里挑出经 Cloudflare 中继的候选对：[{ id, bytes }]，bytes 是收发合计。
 * report 是 RTCStatsReport（或同样有 forEach 的 Map）。
 * assumeCloudflare：本地中继候选没带 url 时，是否当成 Cloudflare 的（见 onlyCloudflareRelays）。
 */
export function cloudflareRelayPairs(report, { assumeCloudflare = false } = {}) {
  const out = [];
  if (!report || typeof report.forEach !== 'function') return out;
  const byId = new Map();
  report.forEach((stat) => {
    if (stat && typeof stat === 'object' && stat.id) byId.set(stat.id, stat);
  });
  for (const stat of byId.values()) {
    if (stat.type !== 'candidate-pair') continue;
    const local = byId.get(stat.localCandidateId);
    if (!local || local.candidateType !== 'relay') continue;
    const url = String(local.url || '');
    if (url ? !isCloudflareTurnUrl(url) : !assumeCloudflare) continue;
    const sent = Number(stat.bytesSent);
    const received = Number(stat.bytesReceived);
    const bytes = (Number.isFinite(sent) && sent > 0 ? sent : 0) + (Number.isFinite(received) && received > 0 ? received : 0);
    out.push({ id: String(stat.id), bytes: Math.floor(bytes) });
  }
  return out;
}

/**
 * 每条连接上次读到的值，只累加增量。
 * key 用 RTCPeerConnection 本身（WeakMap：连接没了，记录跟着回收）。
 */
export class RelayUsageMeter {
  constructor() {
    this._seen = new WeakMap();
  }

  /** 这条连接这次比上次多出来的字节数。 */
  take(key, pairs) {
    if (!key || (typeof key !== 'object' && typeof key !== 'function')) return 0;
    let last = this._seen.get(key);
    if (!last) {
      last = new Map();
      this._seen.set(key, last);
    }
    let delta = 0;
    for (const { id, bytes } of pairs || []) {
      const value = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
      const prev = last.get(id) || 0;
      // 计数器只会涨；真往回走了（不该发生）就当它从零重来，宁可多算不少算
      delta += value >= prev ? value - prev : value;
      last.set(id, value);
    }
    return delta;
  }
}
