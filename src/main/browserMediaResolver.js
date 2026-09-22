'use strict';

/**
 * 对必须执行 JavaScript／Cloudflare 挑战的公开页面做隔离解析。
 * 页面运行在一次性的无持久化 Session 中，禁用权限、弹窗和下载；主窗口永远
 * 不加载第三方页面。这里只捕获 HTTP(S) 媒体请求，不读取或转发站点 Cookie。
 */

const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const net = require('net');
const { sanitizePlaybackHeaders } = require('./linkMedia');
const validate = require('./security');
const { isPublicIp } = require('./ipGuard');

const MEDIA_URL_RE = /\.(?:m3u8|mpd|mp4|m4v|mov|mkv|webm)(?:$|[?#])/i;
const SEGMENT_RE = /\.(?:m4s|ts|aac)(?:$|[?#])/i;
const MEDIA_TYPES = /^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const DEFAULT_TIMEOUT_MS = 35_000;

// 页面是第三方的，它能在 35 秒里发起任意多个请求、用任意长的地址。下面这几张表要是不设上限，
// 一个循环 fetch 的页面就能把主进程的内存撑爆。媒体地址不会长到 8KB，也不会有几百个候选。
const MAX_TRACKED_URL = 8 * 1024;
const MAX_CANDIDATES = 200;
const MAX_HEADER_ENTRIES = 1000;
const MAX_HOSTS = 256;

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function isBlockedLiteral(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return true; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!net.isIP(host)) return false;
  // 和过滤代理、publicHttpUrl 用同一份判据（ipGuard），别再各写一份各漏一块
  return !isPublicIp(host);
}

/**
 * 隔离会话的所有请求都走本机过滤代理（publicProxy.js）。onBeforeRequest 那道检查解析的是
 * 另一次 DNS，挡不住重绑定；代理在连接那一刻才解析、才判定，是真正把关的那一道。
 *
 * `<-loopback>` 不能省：Chromium 默认让 localhost / 127.0.0.1 / [::1] 绕过代理直连。
 */
async function routeThroughProxy(isolated, browser, proxy) {
  const port = Number(proxy && proxy.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error('本机过滤代理没有启动，已拒绝打开第三方页面');
  await isolated.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
  // Chromium 不认代理地址里的凭据，要在 407 之后的 login 事件里交。只答我们自己那个代理的质询，
  // 网站自己的 401 仍按默认处理（取消），凭据绝不交给第三方。
  browser.webContents.on('login', (event, _details, authInfo, callback) => {
    if (!authInfo || !authInfo.isProxy || authInfo.host !== '127.0.0.1' || Number(authInfo.port) !== port) return;
    event.preventDefault();
    callback(proxy.username, proxy.password);
  });
  // WebRTC 走 UDP，不经过 HTTP 代理：页面随手写一个 stun:192.168.1.1 就能往局域网发包
  if (typeof browser.webContents.setWebRTCIPHandlingPolicy === 'function') {
    browser.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  }
}

function candidateScore(url, contentType = '') {
  if (SEGMENT_RE.test(url)) return 0;
  if (/\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(contentType)) return 100;
  if (/\.mpd(?:$|[?#])/i.test(url) || /dash\+xml/i.test(contentType)) return 90;
  if (/\.(?:mp4|m4v|mov|mkv|webm)(?:$|[?#])/i.test(url)) return 80;
  if (/^video\//i.test(contentType)) return 70;
  if (/^audio\//i.test(contentType)) return 40;
  return 0;
}

async function resolveInBrowser(rawUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, proxy = null } = {}) {
  const partition = `noxreel-resolver-${crypto.randomUUID()}`;
  const isolated = session.fromPartition(partition, { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);

  const candidates = new Map();
  const requestHeaders = new Map();
  const publicHosts = new Map();
  let title = '';
  let duration = 0;
  const remember = (url, contentType = '') => {
    if (typeof url !== 'string' || url.length > MAX_TRACKED_URL || isBlockedLiteral(url)) return;
    const score = candidateScore(url, contentType);
    if (!score) return;
    const previous = candidates.get(url);
    if (!previous && candidates.size >= MAX_CANDIDATES) return;
    if (!previous || score > previous.score) {
      candidates.set(url, { url, score, contentType, headers: requestHeaders.get(url) || {} });
    }
  };

  const isPublicRequest = async (url) => {
    if (isBlockedLiteral(url)) return false;
    const parsed = new URL(url);
    const key = `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
    if (!publicHosts.has(key)) {
      // 一个页面用不到几百个不同的主机；随机子域名刷出来的，每个都会触发一次 DNS 查询
      if (publicHosts.size >= MAX_HOSTS) return false;
      publicHosts.set(key, validate.publicHttpUrl(`${parsed.protocol}//${parsed.host}/`, '隔离浏览器请求').then(() => true, () => false));
    }
    return publicHosts.get(key);
  };

  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    isPublicRequest(details.url).then((allowed) => {
      if (allowed && MEDIA_URL_RE.test(details.url)) remember(details.url);
      callback({ cancel: !allowed });
    }, () => callback({ cancel: true }));
  });
  isolated.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    // 每个请求都要记：没有媒体扩展名、靠响应的 Content-Type 才认出来的 HLS 也得带上它的 Referer。
    // 但只留最近的一批 —— 页面循环发请求的话，不设上限这张表会无限长
    const url = details.url;
    if (url.length <= MAX_TRACKED_URL) {
      const headers = sanitizePlaybackHeaders(details.requestHeaders);
      requestHeaders.delete(url);
      if (requestHeaders.size >= MAX_HEADER_ENTRIES) requestHeaders.delete(requestHeaders.keys().next().value);
      requestHeaders.set(url, headers);
      const existing = candidates.get(url);
      if (existing) candidates.set(url, { ...existing, headers });
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  isolated.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const type = String(headerValue(details.responseHeaders, 'content-type') || '');
    if (MEDIA_TYPES.test(type)) remember(details.url, type);
    callback({ responseHeaders: details.responseHeaders });
  });

  const browser = new BrowserWindow({
    show: false,
    width: 960,
    height: 640,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  // 这个窗口 show:false，用户看不见也关不掉，但它的音频照样走系统输出 ——
  // 而轮询脚本每 700ms 就对页面上所有 video/audio 调一次 play()，
  // 于是解析一个带贴片广告的播放页时，会有一段最长 35 秒、来路不明的声音。
  browser.webContents.setAudioMuted(true);
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  isolated.on('will-download', (event) => event.preventDefault());

  let timer;
  let poll;
  try {
    // 必须在 loadURL 之前：第一个请求就得经过代理
    if (proxy) await routeThroughProxy(isolated, browser, proxy);
    await browser.loadURL(rawUrl, { userAgent: browser.webContents.getUserAgent() }).catch((error) => {
      // Cloudflare 的挑战页本身可能以 403 提交，但 Chromium 仍然已经加载了可
      // 执行的响应页面。只有完全没有导航出去时才把它当作立即失败。
      if (!browser.webContents.getURL() || browser.webContents.getURL() === 'about:blank') throw error;
    });
    const result = await new Promise((resolve, reject) => {
      const inspect = async () => {
        if (browser.isDestroyed()) return;
        try {
          const state = await browser.webContents.executeJavaScript(`(() => {
            const urls = new Set(performance.getEntriesByType('resource').map((entry) => entry.name));
            for (const node of document.querySelectorAll('video,audio,source,iframe')) {
              if (node.currentSrc) urls.add(node.currentSrc);
              if (node.src) urls.add(node.src);
            }
            for (const media of document.querySelectorAll('video,audio')) media.play().catch(() => {});
            for (const button of document.querySelectorAll('button,[role="button"],.play,.player')) {
              const label = (button.textContent || button.getAttribute('aria-label') || '').toLowerCase();
              if (/play|播放/.test(label)) button.click();
            }
            const media = document.querySelector('video,audio');
            const short = [...urls].filter((u) => typeof u === 'string' && u.length <= ${MAX_TRACKED_URL});
            return { title: String(document.title || '').slice(0, 512), duration: Number(media?.duration) || 0, urls: short.slice(-500) };
          })()`, true);
          title = String(state?.title || title).slice(0, 512);
          duration = Number(state?.duration) || duration;
          // 页面能改写 Set / Array 的原型，返回值不能当成我们脚本写的那个形状来信
          for (const url of Array.isArray(state?.urls) ? state.urls.slice(-500) : []) remember(url);
        } catch {}
        const best = [...candidates.values()].sort((a, b) => b.score - a.score)[0];
        if (best?.score >= 80) resolve(best);
      };
      poll = setInterval(inspect, 700);
      inspect();
      timer = setTimeout(() => reject(new Error('页面已打开，但在限定时间内没有发现 HLS、DASH 或 MP4 媒体请求')), timeoutMs);
    });
    return {
      title,
      duration,
      playback: {
        url: result.url,
        headers: result.headers,
        protocol: /\.m3u8(?:$|[?#])/i.test(result.url) ? 'm3u8_native' :
          /\.mpd(?:$|[?#])/i.test(result.url) ? 'http_dash_segments' : 'https',
      },
    };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    if (!browser.isDestroyed()) browser.destroy();
    await isolated.clearStorageData().catch(() => {});
    await isolated.clearCache().catch(() => {});
  }
}

module.exports = { candidateScore, isBlockedLiteral, resolveInBrowser, routeThroughProxy, MAX_TRACKED_URL };
