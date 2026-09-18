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
 * 保存设置时检查 TURN 地址写得对不对。
 *
 * expandTurnUrls 对认不出的地址是 `continue` —— 静默丢弃。于是把地址写成
 * `example.com:3478`（漏了 turn: 前缀）的人，会看到设置里「启用 TURN 中继」
 * 勾得好好的，实际上一条中继都没有，而且到连不上那一刻也不会有人告诉他为什么。
 *
 * 漏前缀是最常见的写法错误，所以这里直接补上而不是报错 —— 用户想表达的意思很清楚。
 * 真正认不出的才报出来。
 *
 * @returns {{urls: string[], fixed: string[], invalid: string[]}}
 */
export function normalizeTurnInput(raw) {
  const urls = [];
  const fixed = [];
  const invalid = [];
  for (const url of splitUrls(raw)) {
    if (/^turns?:/i.test(url)) {
      urls.push(url);
      continue;
    }
    // stun: 写进 TURN 框是另一回事 —— 它不是中继，补个前缀也变不成中继
    if (/^\w+:\/\//.test(url) || /^stuns?:/i.test(url)) {
      invalid.push(url);
      continue;
    }
    if (/^[\w.\-[\]:]+(:\d+)?(\?.*)?$/.test(url)) {
      const next = `turn:${url}`;
      urls.push(next);
      fixed.push(next);
      continue;
    }
    invalid.push(url);
  }
  return { urls, fixed, invalid };
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

// a=candidate:<foundation> <component> <proto> <priority> <addr> <port> typ <type> [raddr <ip> rport <port>] ...
// raddr/rport 是这条候选背后的本地基地址。只有 srflx 和 relay 带它，host 没有。
const CANDIDATE_RE =
  /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)(?: raddr (\S+) rport (\d+))?/;

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
    relatedAddress: m[8] || null,
    relatedPort: m[9] === undefined ? null : Number(m[9]),
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
 * 把一条 ICE 候选错误翻译成用户能照着做的话。
 *
 * 这是唯一能把「TURN 密码错」「TURN 地址连不上」「TURN 服务器没开」分开的信息源 ——
 * 光看「配了 TURN 却没拿到 relay 候选」只知道三者之一，不知道是哪一个。
 *
 * 各版本 Chromium 的错误码有出入，所以以码为主、文本兜底，认不出的一律返回 null
 * 让上层退回原来那句笼统的话。**宁可不说，也别硬安一个错误的原因**：
 * 说错方向比不说更费时间。
 *
 * @param {{url?: string, errorCode?: number, errorText?: string}} error
 * @returns {{level: 'bad'|'warn', text: string}|null}
 */
export function describeCandidateError(error) {
  if (!error) return null;
  const url = String(error.url || '');
  const code = Number(error.errorCode) || 0;
  const text = String(error.errorText || '');
  const isTurn = /^turns?:/i.test(url);
  const host = url.replace(/^\w+:/, '').split('?')[0] || url;

  // 401/438 是 STUN 认证握手的正常往返，TURN 每次都会先来一发再带凭据重试。
  // 只有服务器明确拒绝（403）或反复认证失败才是真问题。
  if (code === 438) return null;

  if (isTurn) {
    if (code === 401 || code === 403) {
      return { level: 'bad', text: `TURN 中继 ${host} 拒绝了用户名或密码 —— 请核对设置里的 TURN 凭据。` };
    }
    if (code === 300) {
      return { level: 'warn', text: `TURN 中继 ${host} 要求改用另一个地址，当前这条可能已经迁移。` };
    }
    if (code === 701 || code === 0 || /timeout|unreachable|refused|resolve/i.test(text)) {
      return { level: 'bad', text: `连不上 TURN 中继 ${host} —— 地址或端口可能写错了，也可能被防火墙挡住。` };
    }
    return { level: 'bad', text: `TURN 中继 ${host} 报错（${code}${text ? ` ${text}` : ''}）。` };
  }

  if (/^stuns?:/i.test(url)) {
    return { level: 'warn', text: `STUN 服务器 ${host} 没能应答 —— 换一台，或检查防火墙有没有放行 UDP。` };
  }
  return null;
}

/** 把一份 SDP 里的候选行都解析出来。 */
export function parseSdpCandidates(sdp) {
  const list = [];
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const c = parseCandidateLine(line);
    if (c) list.push(c);
  }
  return list;
}

/**
 * 判断本机是不是在对称 NAT（或多出口 NAT 网关）后面。
 *
 * 原理：srflx 候选是某台 STUN 服务器看到的「你的公网端点」。锥形 NAT 给同一个本地
 * 端口分配同一个映射，不管对面是谁 —— 所以几台 STUN 报回来的完全一样，Chromium
 * 会把重复的合并掉，最后只留一条。对称 NAT 则按目标分配不同映射，几台 STUN 各看到
 * 一个不同的端点，合并不掉，于是同一个本地基地址下会冒出好几条 srflx。
 *
 * **这个判定只能单向成立。** 因为有上面那个去重，「只有一条 srflx」既可能是锥形
 * NAT，也可能是只有一台 STUN 回了话 —— 两者看起来一模一样。所以拿不准时返回 null，
 * 绝不输出「你不是对称 NAT」。宁可不说，也别给一个会让人往错方向查的结论。
 *
 * 分组键必须带上本地基地址、协议和分量，一条都不能少：
 *  - 不跨基地址比：多网卡、VPN 虚拟网卡、Hyper-V 的 vEthernet 各有各的映射，
 *    混在一起比必然把正常的多宿主机器读成对称 NAT。这是最容易误报的一条。
 *  - 不跨地址族比：v4 和 v6 是两条独立的路。基地址不同，天然隔开。
 *  - 不跨协议／分量比：udp 和 tcp 的映射本来就不是一回事。
 *
 * @param {Array<ReturnType<typeof parseCandidateLine>>} candidates
 * @returns {{kind: 'symmetric'|'multi-exit', mappings: string[]}|null}
 */
export function detectSymmetricNat(candidates) {
  const groups = new Map();
  for (const c of candidates || []) {
    if (!c || c.type !== 'srflx') continue;
    // 没有基地址就没法分组。抹成 0.0.0.0 的同样不能用 —— 那会把所有网卡归成一桶。
    if (!c.relatedAddress || isUselessAddress(c.relatedAddress)) continue;
    const key = `${c.component}|${c.protocol}|${c.relatedAddress}|${c.relatedPort}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(`${c.address}:${c.port}`);
  }

  for (const endpoints of groups.values()) {
    if (endpoints.size < 2) continue;
    const list = [...endpoints];
    const addresses = new Set(list.map((e) => e.slice(0, e.lastIndexOf(':'))));
    // 出口 IP 都随目标变，那是多出口的 NAT 网关（常见于云主机），比对称 NAT 更难打洞
    return { kind: addresses.size > 1 ? 'multi-exit' : 'symmetric', mappings: list };
  }
  return null;
}

/**
 * 把候选统计翻译成一句用户能照着做的话。
 * @param {ReturnType<typeof summarizeCandidates>} stats
 * @param {{turnConfigured?: boolean, symmetric?: ReturnType<typeof detectSymmetricNat>}} ctx
 */
export function diagnoseCandidates(stats, { turnConfigured = false, symmetric = null } = {}) {
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
  // 这一条比下面那句笼统的警告确定得多：不是「可能在严格 NAT 后面」，
  // 而是几台 STUN 各看到一个不同的公网端点，已经量出来了。
  if (symmetric && !stats.relay) {
    return {
      level: 'bad',
      text:
        symmetric.kind === 'multi-exit'
          ? '本机的公网出口地址随目标而变（多出口的 NAT 网关，云主机上常见）—— 这种网络打洞必定失败，只能走 TURN 中继。请在设置里配一个。'
          : '本机在对称 NAT 后面（几台 STUN 服务器各看到一个不同的公网端口）—— 这种网络打洞必定失败，只能走 TURN 中继。请在设置里配一个。',
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

/**
 * 连不上时给一句能照着做的话。这是诊断的总入口。
 *
 * 顺序是有讲究的：**候选错误优先于候选统计**。候选错误是服务器亲口说的
 * （「401，凭据不对」），而统计只能反推（「配了 TURN 却没有 relay，三件事之一错了」）。
 * 有确凿信息就别去推断。
 *
 * 做成纯函数是为了能按行为测这个顺序 —— 在编排层里靠 grep 源码验不出
 * 「这个循环到底有没有在迭代」。
 */
export function adviseConnection({ stats, candidates = [], candidateErrors = [], turnConfigured = false } = {}) {
  for (const error of candidateErrors) {
    const told = describeCandidateError(error);
    if (told) return told;
  }
  return diagnoseCandidates(stats, { turnConfigured, symmetric: detectSymmetricNat(candidates) });
}
