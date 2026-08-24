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

const MEDIA_URL_RE = /\.(?:m3u8|mpd|mp4|m4v|mov|mkv|webm)(?:$|[?#])/i;
const SEGMENT_RE = /\.(?:m4s|ts|aac)(?:$|[?#])/i;
const MEDIA_TYPES = /^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const DEFAULT_TIMEOUT_MS = 35_000;

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
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') ||
    /^fe[89ab]/.test(host) || host.startsWith('ff');
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

async function resolveInBrowser(rawUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
    if (isBlockedLiteral(url)) return;
    const score = candidateScore(url, contentType);
    if (!score) return;
    const previous = candidates.get(url);
    if (!previous || score > previous.score) {
      candidates.set(url, { url, score, contentType, headers: requestHeaders.get(url) || {} });
    }
  };

  const isPublicRequest = async (url) => {
    if (isBlockedLiteral(url)) return false;
    const parsed = new URL(url);
    const key = `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
    if (!publicHosts.has(key)) {
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
    const headers = sanitizePlaybackHeaders(details.requestHeaders);
    requestHeaders.set(details.url, headers);
    const existing = candidates.get(details.url);
    if (existing) candidates.set(details.url, { ...existing, headers });
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
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  isolated.on('will-download', (event) => event.preventDefault());

  let timer;
  let poll;
  try {
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
            return { title: document.title || '', duration: Number(media?.duration) || 0, urls: [...urls].slice(-500) };
          })()`, true);
          title = state?.title || title;
          duration = Number(state?.duration) || duration;
          for (const url of state?.urls || []) remember(url);
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

module.exports = { candidateScore, isBlockedLiteral, resolveInBrowser };
