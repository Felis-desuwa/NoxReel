'use strict';

const path = require('path');
const net = require('net');
const dns = require('dns/promises');
const { CHUNK_SIZE, MAX_FILE_SIZE } = require('./fileStore');
const { validateManifestName } = require('./mediaGuard');

const MAX_TEXT = 4096;
const HASH_RE = /^[a-f0-9]{64}$/i;
const FILE_ID_RE = /^[a-f0-9]{32}$/i;
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
  const size = integer(data.size, '文件大小', { min: 1, max: MAX_FILE_SIZE });
  const chunkSize = integer(data.chunkSize, '分片大小', { min: CHUNK_SIZE, max: CHUNK_SIZE });
  const chunkCount = integer(data.chunkCount, '分片数量', { min: 1, max: Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE) });
  if (chunkCount !== Math.ceil(size / chunkSize)) fail('分片数量');
  if (!FILE_ID_RE.test(string(data.fileId, '文件标识', { max: 32 }))) fail('文件标识');
  validateManifestName(string(data.name, '文件名', { max: 200 }));
  if (!Array.isArray(data.hashes) || data.hashes.length !== chunkCount) fail('分片哈希');
  for (const hash of data.hashes) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) fail('分片哈希');
  }
  if (data.roomRevision !== undefined) integer(data.roomRevision, '房间版本', { min: 0 });
  // 时长是可选的诊断信息（房主的 ffprobe 给的）。接收端靠它在起播之前就能算出
  // 「这个片子需要多少码率」，从而判断当前速度追不追得上。缺了不影响传输。
  if (data.durationSec !== undefined) finiteNumber(data.durationSec, '媒体时长', { min: 0, max: 86400 });
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

function binary(value, max = CHUNK_SIZE) {
  const isArrayBuffer = value instanceof ArrayBuffer;
  const isView = ArrayBuffer.isView(value);
  if (!isArrayBuffer && !isView) fail('分片数据');
  const bytes = isArrayBuffer ? value.byteLength : value.byteLength;
  if (bytes < 0 || bytes > max) fail('分片数据');
  return value;
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
  absolutePath,
  binary,
  externalUrl,
  finiteNumber,
  httpUrl,
  integer,
  manifest,
  mediaHeaders,
  plainObject,
  publicHttpUrl,
  sessionId,
  slimOptions,
  string,
};
