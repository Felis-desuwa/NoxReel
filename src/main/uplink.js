'use strict';

/**
 * 上行带宽预估。
 *
 * 房主选片的那一刻还没有任何成员连上，测不到 P2P 实际能跑多快，只能先往最近的公网
 * 节点传一段数据看看。用的是 Cloudflare 测速页背后的上传接口：只发随机字节，不涉及
 * 任何片子内容，也不带任何身份信息（对方能看到的只有出口 IP，和打开任何网页一样）。
 *
 * 家宽的瓶颈几乎总在「最后一公里」的上行，所以这个数和给成员供片时的上限大体一致。
 * 它测不到的是 P2P 路径本身的损耗（跨区、走 TURN 中继都会更慢），所以界面上只叫
 * 「预估」；真正连上之后，房主面板改看实测的上传速度。
 */

const https = require('https');
const crypto = require('crypto');

const ENDPOINT = new URL('https://speed.cloudflare.com/__up');
const CACHE_MS = 10 * 60 * 1000;
// 从小往大试：小包测不准（TCP 慢启动还没爬上去），大包在慢线路上又太耗时。
// 一次请求传满 MIN_SAMPLE_MS 就认为这个数可信，不再往上加。
const STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 12 * 1024 * 1024];
const MIN_SAMPLE_MS = 1200;
const REQUEST_TIMEOUT_MS = 8000;
// 上面那个只是「多久没动静」的空闲超时：对面每隔几秒回一个字节就能一直拖下去，
// 而 estimate() 的并发合并意味着一次拖住，之后所有测速请求都跟着挂住。所以每个请求再加一道
// 从发起算起的硬上限。按 STEPS 的放大规则，正常线路上单次上传不会超过五六秒。
const REQUEST_DEADLINE_MS = 30_000;
// 测速节点回的响应体只有几十字节，用不着读完一个无底洞
const MAX_RESPONSE_BYTES = 64 * 1024;
const TOTAL_BUDGET_MS = 12_000;
// 太短的样本里连接开销占大头，只在没有更好的样本时才用。
const TRUSTED_SAMPLE_MS = 400;

let cached = null;
let running = null;

/**
 * 从若干次上传样本里挑一个代表值。
 *
 * 取「足够长的样本里最快的那次」：短样本被握手和慢启动拖低，拿它会系统性低估；
 * 同样够长的样本之间取最快，是因为线路抖动只会让某次变慢，不会让它凭空变快。
 * 一个够长的样本都没有时，退回用最大的那次。
 *
 * @param {Array<{bytes:number, ms:number}>} samples
 * @returns {number} 字节/秒；没有可用样本时为 0
 */
function pickThroughput(samples) {
  const valid = (samples || []).filter((s) => s && s.bytes > 0 && s.ms > 0);
  if (!valid.length) return 0;
  const trusted = valid.filter((s) => s.ms >= TRUSTED_SAMPLE_MS);
  if (trusted.length) return Math.max(...trusted.map((s) => (s.bytes * 1000) / s.ms));
  const largest = valid.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  return (largest.bytes * 1000) / largest.ms;
}

function uploadOnce(agent, bytes, { request = https.request, deadlineMs = REQUEST_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const body = crypto.randomBytes(bytes);
    let deadline = null;
    const done = (fn, value) => {
      clearTimeout(deadline);
      fn(value);
    };
    const req = request(
      {
        protocol: ENDPOINT.protocol,
        hostname: ENDPOINT.hostname,
        path: ENDPOINT.pathname,
        method: 'POST',
        agent,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
      },
      (res) => {
        const ms = Date.now() - started;
        let received = 0;
        // 响应体不需要，但要读完，连接才能复用。读多少有上限
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) req.destroy(new Error('测速节点的响应过大'));
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) done(resolve, { bytes: body.length, ms });
          else done(reject, new Error(`测速节点返回 HTTP ${res.statusCode}`));
        });
        res.on('error', (error) => done(reject, error));
      }
    );
    deadline = setTimeout(() => req.destroy(new Error('测速请求超时')), deadlineMs);
    req.on('timeout', () => req.destroy(new Error('测速请求超时')));
    req.on('error', (error) => done(reject, error));
    const started = Date.now();
    req.end(body);
  });
}

async function measure() {
  // keepAlive：先用一个小包把 TCP/TLS 握手做掉，后面的样本就只剩真正的上传时间。
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const samples = [];
  try {
    await uploadOnce(agent, 16 * 1024);
    for (const size of STEPS) {
      if (Date.now() > deadline) break;
      const sample = await uploadOnce(agent, size);
      samples.push(sample);
      if (sample.ms >= MIN_SAMPLE_MS) break;
    }
  } catch (error) {
    if (!samples.length) throw error;
  } finally {
    agent.destroy();
  }
  const bytesPerSec = pickThroughput(samples);
  if (!(bytesPerSec > 0)) throw new Error('没有拿到有效的测速样本');
  return bytesPerSec;
}

/**
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{ok: true, bytesPerSec: number, measuredAt: number, cached: boolean} | {ok: false, reason: string}>}
 */
async function estimate({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.measuredAt < CACHE_MS) {
    return { ok: true, bytesPerSec: cached.bytesPerSec, measuredAt: cached.measuredAt, cached: true };
  }
  // 同时点了两次（比如选片后马上换片）就共用一次测速，别并发往外传两份。
  if (!running) {
    running = measure()
      .then((bytesPerSec) => {
        cached = { bytesPerSec, measuredAt: Date.now() };
        return { ok: true, bytesPerSec, measuredAt: cached.measuredAt, cached: false };
      })
      .catch((error) => ({ ok: false, reason: error.message || String(error) }))
      .finally(() => {
        running = null;
      });
  }
  return running;
}

module.exports = { estimate, pickThroughput, uploadOnce, ENDPOINT: ENDPOINT.href, MAX_RESPONSE_BYTES };
