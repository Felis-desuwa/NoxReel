/**
 * ICE 配置与 SDP 候选处理。
 *
 * 这里的三件事都只服务于一个目标：**让直连真的能建起来**，尤其是跨运营商、
 * 跨国境的家用宽带之间（北美的用户经常一个在美国、一个在加拿大，中间隔着两层
 * CGNAT 和一段跨境骨干）。
 *
 *  1. STUN 冗余 —— 只配一台服务器时，它一旦不通就拿不到公网映射地址，
 *     跨 NAT 必然失败，而用户看到的只是「连不上」。
 *  2. 候选精简 —— 冗余带来重复候选，重复候选会撑长极简模式的邀请码。
 *     去重之后码反而比原来更短。
 *  3. 候选诊断 —— 连不上的时候能说清是「没拿到公网地址」还是「拿到了但打不通」，
 *     这两种情况用户要做的事完全不同。
 *
 * 全是纯函数，桌面端与 Android 端共用同一份逻辑。
 */

export const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

/**
 * 兜底 STUN。用户只填一台时自动补上这几台。
 *
 * 同一个 NAT 映射会被不同服务器报成同一个地址（家用路由几乎都是
 * endpoint-independent mapping），所以冗余出来的候选是重复的，
 * 会被 pruneSdpCandidates() 去掉 —— 加服务器不会让邀请码变长。
 */
export const FALLBACK_STUN = Object.freeze([
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]);

/** 把设置里的一行拆成若干个 URL。允许用逗号、空格或换行分隔。 */
export function splitUrls(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * TURN 地址展开成 UDP 与 TCP 两条。
 *
 * 酒店、公司和一部分校园网会封掉 UDP，只留 TCP/443 出去。这种网络下
 * 只声明 UDP 的 TURN 等于没配 —— 而用户以为自己已经有兜底了。
 * 自己写死了 ?transport= 的地址原样保留，那是明确的意图。
 */
export function expandTurnUrls(raw) {
  const out = [];
  const push = (u) => {
    if (!out.includes(u)) out.push(u);
  };
  for (const url of splitUrls(raw)) {
    if (!/^turns?:/i.test(url)) continue;
    if (/[?&]transport=/i.test(url)) {
      push(url);
      continue;
    }
    if (/^turns:/i.test(url)) {
      // turns 是 TLS over TCP，没有 UDP 变体
      push(`${url}?transport=tcp`);
    } else {
      push(`${url}?transport=udp`);
      push(`${url}?transport=tcp`);
    }
  }
  return out;
}

/**
 * 组装 RTCConfiguration 的 iceServers。
 *
 * STUN 一栏填了多条就完全按用户写的来（他在自己管这个列表）；
 * 只填一条才补兜底服务器 —— 默认值也算「只填一条」。
 */
export function buildIceServers({
  stun,
  turnEnabled = false,
  turnUrl = '',
  turnUser = '',
  turnPass = '',
} = {}) {
  const configured = splitUrls(stun);
  const urls = configured.length ? [...configured] : [DEFAULT_STUN];
  if (urls.length === 1) {
    for (const fallback of FALLBACK_STUN) {
      if (!urls.includes(fallback)) urls.push(fallback);
    }
  }

  const list = [{ urls }];
  if (turnEnabled) {
    const relays = expandTurnUrls(turnUrl);
    if (relays.length) list.push({ urls: relays, username: turnUser || '', credential: turnPass || '' });
  }
  return list;
}

/** 配置里真的带了可用的 TURN 中继吗。用来决定 ICE 收集要不要多等一会儿。 */
export function hasRelay(iceServers) {
  return (iceServers || []).some((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(String(u || '')))
  );
}

// a=candidate:<foundation> <component> <proto> <priority> <addr> <port> typ <type> ...
const CANDIDATE_RE = /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/;

/** 从一行 SDP 里解析候选，不是候选行返回 null。 */
export function parseCandidateLine(line) {
  const m = CANDIDATE_RE.exec(line);
  if (!m) return null;
  return {
    foundation: m[1],
    component: Number(m[2]),
    protocol: m[3].toLowerCase(),
    priority: Number(m[4]),
    address: m[5],
    port: Number(m[6]),
    type: m[7],
  };
}

/** IPv6 链路本地地址。出不了本网段，带上纯属占字节。 */
function isUselessAddress(address) {
  const a = String(address || '').toLowerCase();
  return a.startsWith('fe80:') || a === '0.0.0.0' || a === '::';
}

/**
 * 精简 SDP 里的 ICE 候选。
 *
 * 只删两类：
 *  - 完全重复的（同分量、同协议、同地址端口、同类型）。多台 STUN 服务器
 *    对同一个 NAT 映射会各报一次，内容一模一样。
 *  - IPv6 链路本地地址（fe80::）。永远连不通，纯占字节。
 *
 * **只对要发出去的那份 SDP 文本动手，绝不改回 setLocalDescription。**
 * 本地 ICE agent 的候选表必须保持完整 —— 删掉的都是重复项，对端少试几次
 * 完全等价，但本地这边动它就会和 agent 状态对不上。
 *
 * @returns {{sdp: string, removed: number}}
 */
export function pruneSdpCandidates(sdp) {
  const text = String(sdp || '');
  if (!text) return { sdp: text, removed: 0 };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  let removed = 0;

  const kept = lines.filter((line) => {
    const c = parseCandidateLine(line);
    if (!c) return true;
    if (isUselessAddress(c.address)) {
      removed++;
      return false;
    }
    const key = `${c.component}|${c.protocol}|${c.address}|${c.port}|${c.type}`;
    if (seen.has(key)) {
      removed++;
      return false;
    }
    seen.add(key);
    return true;
  });

  return { sdp: kept.join(eol), removed };
}

/**
 * 统计一份 SDP 里都有哪几类候选。
 *
 * 连不上的时候这份统计是唯一能指路的东西：
 *  - 没有 srflx  → STUN 不通，本机根本不知道自己的公网地址，换 STUN 或查防火墙
 *  - 有 srflx 没 relay 且配了 TURN → TURN 地址或凭据有问题
 *  - 两者都有还是连不上 → 对称 NAT 对撞，只能走中继
 */
export function summarizeCandidates(sdp) {
  const out = { host: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0, total: 0 };
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const c = parseCandidateLine(line);
    if (!c) continue;
    out.total++;
    if (c.type in out) out[c.type]++;
    if (/\.local$/i.test(c.address)) out.mdns++;
  }
  return out;
}

/**
 * 把候选统计翻译成一句用户能照着做的话。
 * @param {ReturnType<typeof summarizeCandidates>} stats
 * @param {{turnConfigured?: boolean}} ctx
 */
export function diagnoseCandidates(stats, { turnConfigured = false } = {}) {
  if (!stats || !stats.total) {
    return {
      level: 'bad',
      text: '本机一个网络候选地址都没收集到 —— 通常是网络被完全隔离，或者防火墙拦掉了 NoxReel。',
    };
  }
  if (!stats.srflx && !stats.relay) {
    return {
      level: 'bad',
      text: 'STUN 服务器没能告诉本机公网地址，只有局域网候选。除非双方在同一个局域网，否则连不上；请在设置里换一台 STUN 服务器，或检查防火墙有没有放行 UDP。',
    };
  }
  if (turnConfigured && !stats.relay) {
    return {
      level: 'warn',
      text: '配了 TURN 中继却没拿到中继候选 —— 地址、端口或用户名密码大概率有一项不对，这时中继等于没配。',
    };
  }
  if (!stats.relay) {
    return {
      level: 'warn',
      text: '拿到了公网地址，但没有中继兜底。双方都在严格 NAT（对称 NAT、CGNAT、部分手机热点）后面时会连不上，配一个 TURN 中继可以解决。',
    };
  }
  return { level: 'ok', text: '公网地址和中继候选都齐了。' };
}
