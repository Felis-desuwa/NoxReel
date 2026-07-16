'use strict';

/**
 * 地区探测。
 *
 * 定位是「告知」，不是「拦截」—— 探测到所在地区不在设计范围内时，
 * 明确告诉用户这件事，然后让他自己决定要不要继续。
 *
 * 为什么不做硬拦截：客户端代码在用户机器上，改一行就绕过了，断网也能绕过
 * （查不到 = 放行）。它从来就拦不住真想绕的人，只会误伤网络抖动的正常用户。
 * 真正有强制力的只有信令层，而「极简模式」压根不经过信令层。
 * 既然拦不住，就不如把话说清楚：本产品没有针对这些地区做适配，P2P 打洞大概率
 * 会失败，用不好别怪软件。这个判断连同服务条款声明，就是全部的地区策略。
 *
 * 服务器端仍然保留可选的强制拦截（signaling-server/server.js 的 BLOCKED_COUNTRIES），
 * 默认关闭，留给有硬合规要求的部署方自己开。
 */

const https = require('https');

// 明确不面向、也未做适配的地区。命中只提示，不阻止。
// 仅指中国大陆；HK/MO/TW 是独立 ISO 代码，不在此列。
const OUT_OF_SCOPE = new Set(['CN']);

// 多个源互为备份，任一返回即可。查的是「本机出口 IP 在哪个国家」这类元数据，不涉及内容。
const PROVIDERS = [
  { url: 'https://api.country.is/', pick: (j) => j.country },
  { url: 'https://ipapi.co/json/', pick: (j) => j.country_code },
  { url: 'https://ipinfo.io/json', pick: (j) => j.country },
];

function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SyncWatch/0.1' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (body.length > 64 * 1024) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

let cached = null;

/**
 * @returns {Promise<{country:string|null, determined:boolean, inScope:boolean, notice:string|null}>}
 *   inScope=false 时 notice 是要展示给用户的话。任何情况下都不阻止使用。
 */
async function check({ force = false } = {}) {
  if (cached && !force) return cached;

  if (process.env.SYNCWATCH_SKIP_GEO === '1') {
    cached = { country: null, determined: false, inScope: true, notice: null };
    return cached;
  }

  for (const p of PROVIDERS) {
    try {
      const json = await fetchJson(p.url);
      const country = String(p.pick(json) || '').toUpperCase();
      if (!country || country.length !== 2) continue;

      const inScope = !OUT_OF_SCOPE.has(country);
      cached = {
        country,
        determined: true,
        inScope,
        notice: inScope
          ? null
          : '本软件仅针对北美网络环境设计，没有对你所在地区做过适配。P2P 直连很可能打洞失败，' +
            '需要自备 TURN 中继才能用。你可以继续使用，但遇到的连接问题不在支持范围内。',
      };
      return cached;
    } catch {
      // 换下一个源
    }
  }

  // 查不到就当作正常 —— 网络抖动不该变成一句吓人的警告
  cached = { country: null, determined: false, inScope: true, notice: null };
  return cached;
}

module.exports = { check, OUT_OF_SCOPE };
