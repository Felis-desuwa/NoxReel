'use strict';

const crypto = require('crypto');
const path = require('path');
const net = require('net');
const dns = require('dns/promises');
const { CHUNK_SIZE } = require('./fileStore');
const { validateManifestName } = require('./mediaGuard');
// 弹幕的各种上限由覆盖层那一侧定义（它还要按同一个数截断播放器里发回来的文本），
// 这里只负责把关。两边各写一份就迟早会对不上。
const {
  MAX_DANMAKU_ITEMS,
  MAX_DANMAKU_TEXT,
  MAX_OVERLAY_COORD,
  MIN_OVERLAY_SIZE,
  MAX_OVERLAY_SIZE,
} = require('./mpv');

const MAX_TEXT = 4096;
// 只认小写：buildManifest 产出的就是小写，共享库的 manifestShapeOk 也只认小写
const HASH_RE = /^[a-f0-9]{64}$/;
const FILE_ID_RE = /^[a-f0-9]{32}$/;
const TASK_ID_RE = /^[a-z0-9]{6,32}$/;
const SAFE_MEDIA_HEADERS = new Set(['accept', 'accept-language', 'origin', 'referer', 'user-agent']);

function fail(label) {
  throw new TypeError(`无效的 ${label}`);
}

function string(value, label, { max = MAX_TEXT, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) fail(label);
  return value;
}

function absolutePath(value, label = '文件路径') {
  const result = string(value, label, { max: 32_768 });
  if (!path.isAbsolute(result) || result.includes('\0')) fail(label);
  return result;
}

function httpUrl(value, label = '链接') {
  const raw = string(value, label, { max: 16_384 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(label);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(label);
  return parsed.href;
}

function isPrivateAddress(address) {
  const ip = String(address || '').toLowerCase().split('%')[0];
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b, c] = parts;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && c === 0) || b === 168 || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    if (
      ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip) ||
      ip.startsWith('ff') || ip.startsWith('2001:db8:')
    ) return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = ip.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    return false;
  }
  return true;
}

async function publicHttpUrl(value, label = '链接') {
  const safe = httpUrl(value, label);
  const parsed = new URL(safe);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) fail(label);
  const literal = net.isIP(hostname);
  if (literal && isPrivateAddress(hostname)) fail(label);
  if (!literal) {
    let addresses;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      fail(label);
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) fail(label);
  }
  return safe;
}

// 清单里媒体时长的上限（秒）。渲染进程那边 lib/swarm.js 的 MAX_DURATION_SEC、
// lib/playlist.js 用的是同一个数，改一处就要三处一起改。
const MAX_DURATION_SEC = 24 * 60 * 60;

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label);
  return value;
}

function integer(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const result = finiteNumber(value, label, { min, max });
  if (!Number.isSafeInteger(result)) fail(label);
  return result;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
  return value;
}

function manifest(value) {
  const data = plainObject(value, '媒体清单');
  // 不再限制文件大小，只要求是能精确表示的整数（超过 2^53 连字节偏移都算不准）。
  const size = integer(data.size, '文件大小', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const chunkSize = integer(data.chunkSize, '分片大小', { min: CHUNK_SIZE, max: CHUNK_SIZE });
  const chunkCount = integer(data.chunkCount, '分片数量', { min: 1, max: Math.ceil(Number.MAX_SAFE_INTEGER / CHUNK_SIZE) });
  if (chunkCount !== Math.ceil(size / chunkSize)) fail('分片数量');
  if (!FILE_ID_RE.test(string(data.fileId, '文件标识', { max: 32 }))) fail('文件标识');
  validateManifestName(string(data.name, '文件名', { max: 200 }));
  if (!Array.isArray(data.hashes) || data.hashes.length !== chunkCount) fail('分片哈希');
  for (const hash of data.hashes) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) fail('分片哈希');
  }
  // fileId 由全部分片哈希推导（见 fileStore.buildManifest）。对不上说明清单被改过：
  // 拿一个别人的 fileId 配上自己的哈希，就能让缓存和进度记到别的片子头上。
  const digest = crypto.createHash('sha256').update(data.hashes.join('')).digest('hex').slice(0, 32);
  if (digest !== data.fileId) fail('文件标识');
  if (data.roomRevision !== undefined) integer(data.roomRevision, '房间版本', { min: 0 });
  // 时长是可选的诊断信息（房主的 ffprobe 给的）。接收端靠它在起播之前就能算出
  // 「这个片子需要多少码率」，从而判断当前速度追不追得上。缺了不影响传输。
  if (data.durationSec !== undefined) finiteNumber(data.durationSec, '媒体时长', { min: 0, max: MAX_DURATION_SEC });
  // 片源选片时测得的上行带宽（字节/秒），同样只是诊断信息：成员据此显示「片源上行」，
  // 知道自己分到的速度上限在哪。上限给到 1Tbps，挡住畸形值。
  // 0.7 起加片的不一定是房主，字段也改名了；旧名字不再认，免得未经校验的值混进来。
  if (data.sourceUplinkBps !== undefined) finiteNumber(data.sourceUplinkBps, '片源上行带宽', { min: 0, max: 125_000_000_000 });
  if (data.uplinkBps !== undefined) fail('媒体清单');
  return data;
}

/**
 * 轨道下标数组。轨道数不会多到哪去，给个宽松上限挡住畸形输入。
 *
 * allowEmpty 区分两种「空」，它们的语义完全不同，不能混：
 *  - null / undefined  = 「没指定，主进程自己算」
 *  - 空数组            = 「明确一条都不要」
 * keepIndexes 一条不留是畸形输入，照旧拒绝；toFlac 一条不转是最常见的正常情况。
 */
function trackIndexes(raw, label, { allowEmpty = false } = {}) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 64) fail(label);
  if (!raw.length) {
    if (!allowEmpty) fail(label);
    return [];
  }
  const list = raw.map((i) => integer(i, '轨道下标', { min: 0, max: 1023 }));
  if (new Set(list).size !== list.length) fail(label);
  return list;
}

/**
 * 无损精简参数：要保留的轨道下标，以及其中哪几条要转成 FLAC。
 * toFlac 必须是 keepIndexes 的子集 —— 去转一条根本没保留的轨，ffmpeg 会直接报错。
 *
 * toFlac 传空数组必须放行：只有源文件恰好带一条够格的未压缩 PCM 轨时它才非空，
 * 也就是说绝大多数片子走精简都是空数组。这里拒了，整个无损精简功能就等于没有。
 */
function slimOptions(value) {
  const data = plainObject(value, '精简参数');
  const keepIndexes = trackIndexes(data.keepIndexes, '精简参数');
  const toFlac = trackIndexes(data.toFlac, '精简参数', { allowEmpty: true });
  if (toFlac && keepIndexes && toFlac.some((i) => !keepIndexes.includes(i))) fail('精简参数');
  return { keepIndexes, toFlac };
}

function sessionId(value) {
  return string(value, '会话标识', { max: 128 });
}

/**
 * 长任务（算哈希 / 转封装 / 精简）的标识，由渲染进程生成，用来取消和区分进度事件。
 * 可选：没给（undefined / null）就返回 null；给了就必须是 6–32 位小写字母数字。
 * 它会当 Map 的键、原样回传给渲染进程，所以字符集收得很窄。
 */
function taskId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !TASK_ID_RE.test(value)) fail('任务标识');
  return value;
}

function binary(value, max = CHUNK_SIZE) {
  const isArrayBuffer = value instanceof ArrayBuffer;
  const isView = ArrayBuffer.isView(value);
  if (!isArrayBuffer && !isView) fail('分片数据');
  const bytes = isArrayBuffer ? value.byteLength : value.byteLength;
  if (bytes < 0 || bytes > max) fail('分片数据');
  return value;
}

/** 码点数，不是 UTF-16 长度：一个 emoji 占两个 .length，却只算一个字。 */
function codePointCount(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * 一帧弹幕。条数、字数、坐标全部卡死上限。
 *
 * 这道校验比别的都值钱：这一帧每秒来 30 次，正文来自房间里的其他人，
 * 而它的去处是拼进一条 ASS 字符串交给 mpv。松一点就是给别人一把每秒 30 次的锤子。
 * 转义由 mpv.js 的 escapeAss 负责，这里管的是「量」：多少条、多长、画到哪。
 */
function danmakuFrame(value) {
  const data = plainObject(value, '弹幕帧');
  finiteNumber(data.w, '弹幕画布宽', { min: MIN_OVERLAY_SIZE, max: MAX_OVERLAY_SIZE });
  const height = finiteNumber(data.h, '弹幕画布高', { min: MIN_OVERLAY_SIZE, max: MAX_OVERLAY_SIZE });
  // 播放器代号：带了就只画给那一代，见 PlayerManager.setDanmakuFrame
  if (data.gen !== undefined && data.gen !== null) integer(data.gen, '播放器代号', { min: 1 });
  if (!Array.isArray(data.items) || data.items.length > MAX_DANMAKU_ITEMS) fail('弹幕条数');
  for (const raw of data.items) {
    const item = plainObject(raw, '弹幕');
    string(item.text, '弹幕正文', { max: MAX_DANMAKU_TEXT * 2 });
    if (codePointCount(item.text) > MAX_DANMAKU_TEXT) fail('弹幕正文');
    // x 可以是很大的负数（长弹幕整条还在屏幕左边外面）；y 必须落在画布里
    finiteNumber(item.x, '弹幕横坐标', { min: -MAX_OVERLAY_COORD, max: MAX_OVERLAY_COORD });
    finiteNumber(item.y, '弹幕纵坐标', { min: 0, max: height });
    if (item.fontSize !== undefined) finiteNumber(item.fontSize, '弹幕字号', { min: 1, max: 400 });
    if (item.opacity !== undefined) finiteNumber(item.opacity, '弹幕不透明度', { min: 0, max: 1 });
    if (item.outline !== undefined && typeof item.outline !== 'boolean') fail('弹幕描边');
  }
  return data;
}

/**
 * 要塞进 mpv --script-opt 的值（目前只有播放器内输入框的提示语，由界面按语言给）。
 *
 * 逗号是 script-opts 那张表的分隔符，控制字符会把一整行参数劈开，两类都得挡住。
 * 一个反斜杠都不写：这个文件里的正则字符类曾经被工具多转义过一层，改用码点判断就没这风险。
 * 44 = 逗号，0x7f = DEL。
 */
function scriptOptValue(value, label = '脚本参数') {
  const text = string(value, label, { max: 40 });
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || code === 44) fail(label);
  }
  return text;
}

/**
 * 播放器 id。只认调用方递进来的那张登记表 —— 这个字符串最终会变成
 * `new ADAPTERS[id]()`，不比对登记表就等于让渲染进程点名要主进程构造任意对象。
 * 登记表由 PlayerManager 给（它才知道装了哪几个适配器），这一层只负责卡住。
 */
function playerId(value, allowed) {
  const id = string(value, '播放器', { max: 16 });
  if (!Array.isArray(allowed) || !allowed.includes(id)) fail('播放器');
  return id;
}

function externalUrl(value) {
  return httpUrl(value, '外部链接');
}

function mediaHeaders(value) {
  if (value === undefined || value === null) return {};
  const source = plainObject(value, '媒体请求头');
  const result = {};
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = String(rawName).trim().toLowerCase();
    if (!SAFE_MEDIA_HEADERS.has(name) || typeof rawValue !== 'string') fail('媒体请求头');
    if (!rawValue || rawValue.length > 2048 || /[\r\n]/.test(rawValue)) fail('媒体请求头');
    result[name] = rawValue;
  }
  return result;
}

module.exports = {
  MAX_DURATION_SEC,
  absolutePath,
  binary,
  danmakuFrame,
  externalUrl,
  finiteNumber,
  httpUrl,
  integer,
  manifest,
  mediaHeaders,
  plainObject,
  playerId,
  publicHttpUrl,
  scriptOptValue,
  sessionId,
  slimOptions,
  string,
  taskId,
};
