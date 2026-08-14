'use strict';

const path = require('path');
const { CHUNK_SIZE, MAX_FILE_SIZE } = require('./fileStore');

const MAX_TEXT = 4096;
const HASH_RE = /^[a-f0-9]{64}$/i;
const FILE_ID_RE = /^[a-f0-9]{32}$/i;

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
  string(data.name, '文件名', { max: 1000 });
  if (!Array.isArray(data.hashes) || data.hashes.length !== chunkCount) fail('分片哈希');
  for (const hash of data.hashes) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) fail('分片哈希');
  }
  if (data.roomRevision !== undefined) integer(data.roomRevision, '房间版本', { min: 0 });
  return data;
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

module.exports = {
  absolutePath,
  binary,
  externalUrl,
  finiteNumber,
  httpUrl,
  integer,
  manifest,
  plainObject,
  sessionId,
  string,
};
