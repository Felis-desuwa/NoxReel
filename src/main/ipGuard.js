'use strict';

/**
 * 「这个地址是不是公网」的唯一判据。
 *
 * 以前 security.js、linkMedia.js、browserMediaResolver.js 各写一份，写法各不相同，
 * 漏的也各不相同：linkMedia 那份认不出 WHATWG URL 规范化之后的 [::ffff:7f00:1]，
 * 隔离浏览器那份连 192.0.0.0/24 都没挡。于是统一收在这里，过滤代理也用同一份。
 *
 * 判法是「白名单」而不是「黑名单」：
 *  - IPv4：挡掉 IANA 特殊用途地址表里所有「不可全球路由」的段，剩下的才算公网；
 *  - IPv6：只有 2000::/3（全球单播）才可能是公网，再从里面剔掉文档、Teredo、
 *    基准测试这些段；内嵌 IPv4 的几种写法（映射、NAT64、6to4）按内嵌的那个 IPv4 判。
 * 拿不准的一律算「不是公网」。
 *
 * 这个文件不许依赖别的模块：security.js、linkMedia.js、mpv.js 之间有循环引用，
 * 放在任何一个里面都会在某条加载顺序上拿到半截导出。
 */

const net = require('net');
const dns = require('dns');

/** IPv4 转成 32 位无符号整数。调用方保证已经过 net.isIPv4。 */
function v4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

/** [网络号, 前缀长度]。网络号用点分写，读起来比整数直观。 */
const V4_BLOCKED = [
  ['0.0.0.0', 8], // 「本网络」
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档 TEST-NET-1
  ['192.88.99.0', 24], // 6to4 中继（已废弃）
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档 TEST-NET-2
  ['203.0.113.0', 24], // 文档 TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留，含 255.255.255.255 广播
].map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask };
});

function isPublicV4(ip) {
  const n = v4ToInt(ip);
  return !V4_BLOCKED.some(({ net: base, mask }) => ((n & mask) >>> 0) === base);
}

/**
 * IPv6 拆成 8 个 16 位整数。调用方保证已经过 net.isIPv6（格式合法），
 * 这里只负责展开「::」和末尾的点分 IPv4。
 */
function parseV6(ip) {
  let head = ip;
  if (head.includes('.')) {
    const cut = head.lastIndexOf(':');
    const v4 = head.slice(cut + 1);
    if (!net.isIPv4(v4)) return null;
    const p = v4.split('.').map(Number);
    head = `${head.slice(0, cut + 1)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups = left;
  if (right) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array(fill).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

const embeddedV4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function isPublicV6(ip) {
  const g = parseV6(ip);
  if (!g) return false;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d（IPv4 映射）：Windows 双栈套接字会把它直接连到那个 IPv4 上
  if (zeros(0, 5) && g[5] === 0xffff) return isPublicV4(embeddedV4(g[6], g[7]));
  // 64:ff9b::/96（NAT64 公用前缀）：只有 IPv6 的网络里 DNS64 会把 IPv4 站点合成成这种地址，
  // 整段挡掉那种网络就什么都打不开了，所以按内嵌的 IPv4 判
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPublicV4(embeddedV4(g[6], g[7]));
  // 2002::/16（6to4）：第 16–47 位是内嵌的 IPv4
  if (g[0] === 0x2002) return isPublicV4(embeddedV4(g[1], g[2]));
  // 全球单播只有 2000::/3。::1、::、fc00::/7、fe80::/10、ff00::/8、64:ff9b:1::/48、
  // ::a.b.c.d（IPv4 兼容，已废弃）这些全在外面，一句话全挡住
  if ((g[0] & 0xe000) !== 0x2000) return false;
  // 2001::/23：IETF 协议分配（Teredo、基准测试、ORCHID 都在里面）
  if (g[0] === 0x2001 && g[1] < 0x0200) return false;
  // 2001:db8::/32、3fff::/20：文档地址
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if ((g[0] & 0xfff0) === 0x3ff0) return false;
  return true;
}

/**
 * @param {string} address 已解析的 IP（不是主机名）。IPv6 可以带方括号或区域号。
 * @returns {boolean} 只有确定是公网地址才返回 true
 */
function isPublicIp(address) {
  const ip = String(address || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase();
  if (net.isIPv4(ip)) return isPublicV4(ip);
  if (net.isIPv6(ip)) return isPublicV6(ip);
  return false;
}

function notPublic(host) {
  const error = new Error(`拒绝访问非公网地址：${String(host).slice(0, 255)}`);
  error.code = 'ENOTPUBLIC';
  return error;
}

function dnsLookupAll(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });
}

/**
 * 解析主机名，并确认它解析出来的**每一个**地址都是公网。
 *
 * 一个是公网、一个是内网的混合记录也拒：DNS 重绑定最常见的就是这么配的，
 * 放过它就得赌客户端挑哪个地址去连。
 *
 * 返回解析结果，调用方必须直接连这里返回的 IP —— 回头拿主机名再解析一次，
 * 中间这一段就是 DNS 重绑定的窗口。
 *
 * @returns {Promise<Array<{address: string, family: number}>>}
 */
async function resolvePublic(hostname, { lookup = dnsLookupAll } = {}) {
  const host = String(hostname || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!host || host.length > 253) throw notPublic(host);
  if (host === 'localhost' || host.endsWith('.localhost')) throw notPublic(host);
  const literal = net.isIP(host.split('%')[0]);
  if (literal) {
    if (!isPublicIp(host)) throw notPublic(host);
    return [{ address: host.split('%')[0], family: literal }];
  }
  let addresses;
  try {
    addresses = await lookup(host);
  } catch (error) {
    error.code = error.code || 'ENOTFOUND';
    throw error;
  }
  if (!Array.isArray(addresses) || !addresses.length) throw notPublic(host);
  if (addresses.some((entry) => !entry || !isPublicIp(entry.address))) throw notPublic(host);
  return addresses.map(({ address, family }) => ({ address, family: family || net.isIP(address) }));
}

/**
 * 给 http.request / net.connect 的 lookup 选项用：连接那一刻才解析、才判定。
 *
 * 注意 Node 对 IP 字面量是不调 lookup 的 —— 调用方对字面量得自己先过一遍 isPublicIp。
 */
function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const opts = typeof options === 'number' ? { family: options } : options || {};
  resolvePublic(hostname).then(
    (list) => {
      const usable = opts.family === 4 || opts.family === 6 ? list.filter((a) => a.family === opts.family) : list;
      if (!usable.length) return callback(notPublic(hostname));
      if (opts.all) return callback(null, usable);
      return callback(null, usable[0].address, usable[0].family);
    },
    (error) => callback(error)
  );
}

module.exports = { isPublicIp, resolvePublic, publicLookup, notPublic, parseV6 };
