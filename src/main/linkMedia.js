'use strict';

/**
 * 视频链接解析。
 *
 * 这里不下载媒体，也不把解析后的临时 CDN 地址发给其他成员。每台客户端都用
 * 原始页面地址在本机解析并交给 mpv，避免短时效签名 URL 在房间里过期或泄漏。
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const { findBin } = require('./findBin');

const DIRECT_MEDIA_RE = /\.(?:mp4|m4v|mov|mkv|webm|m3u8|mpd)(?:$|[?#])/i;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 60_000;
const SAFE_PLAYBACK_HEADERS = new Set(['accept', 'accept-language', 'origin', 'referer', 'user-agent']);
const YOUTUBE_HOST_RE = /(^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
const MAX_REDIRECT_HOPS = 5;

function bundledYtDlp() {
  if (!process.resourcesPath) return [];
  return [path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')];
}

function findYtDlp() {
  const dev = path.join(__dirname, '..', '..', 'vendor', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const home = os.homedir();
  const candidates = [
    ...bundledYtDlp(),
    dev,
    ...(process.platform === 'win32'
      ? [
          path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
          'C:\\Program Files\\yt-dlp\\yt-dlp.exe',
        ]
      : []),
  ];
  return findBin('yt-dlp', { envVar: 'SYNCWATCH_YTDLP_PATH', candidates });
}

function normalizeHttpUrl(raw) {
  const text = String(raw || '').trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('请输入完整的视频链接，例如 https://example.com/video');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http:// 或 https:// 视频链接');
  }
  if (parsed.username || parsed.password) throw new Error('链接中不能包含用户名或密码');
  return parsed.href;
}

function looksLikeDirectMedia(url) {
  return DIRECT_MEDIA_RE.test(url);
}

function sanitizePlaybackHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName).trim().toLowerCase();
    if (!SAFE_PLAYBACK_HEADERS.has(name) || typeof rawValue !== 'string') continue;
    if (/[\r\n]/.test(rawValue)) continue;
    const text = rawValue.slice(0, 2048);
    if (text) safe[name] = text;
  }
  return safe;
}

function isPrivateIp(address) {
  const v = net.isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = address.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // 解析不出来的一律当私网处理
}

async function hostIsPublic(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && !addrs.some(({ address }) => isPrivateIp(address));
  } catch {
    return false;
  }
}

/** 手动走一遍跳转链，任何一跳指向私网就拒绝。见调用处对局限性的说明。 */
async function assertRedirectChainIsPublic(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    let res;
    try {
      res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'Mozilla/5.0' },
      });
    } catch {
      return; // 探不动就放行，交给 yt-dlp —— 这一层是加固，不是准入门槛
    }
    if (res.status < 300 || res.status >= 400) return;
    const location = res.headers.get('location');
    if (!location) return;

    let next;
    try {
      next = new URL(location, current);
    } catch {
      return;
    }
    if (!/^https?:$/.test(next.protocol) || !(await hostIsPublic(next.hostname))) {
      const error = new Error('这个链接跳转到了内网地址，已拒绝解析。');
      error.code = 'PRIVATE_REDIRECT';
      throw error;
    }
    current = next.toString();
  }
}

/**
 * 从地址里取一个能显示的文件名。
 *
 * decodeURIComponent 遇到不是合法转义的 % 会抛 URIError（比如 .../100%.mp4），
 * 那会把整条 inspectLink 炸掉，用户拿到一句英文的「URI malformed」，
 * 而这个直链本来交给 mpv 就能直接播。解不开就用原文，标题好看与否无关紧要。
 */
function fileNameFromUrl(url) {
  const raw = new URL(url).pathname.split('/').pop() || '在线视频';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 两个来源的字段名不一样，都得认：
 *  - yt-dlp 的 info 里是 http_headers
 *  - 隔离浏览器返回的是 headers（browserMediaResolver 在 onBeforeSendHeaders 里抓的）
 * 只认前者的话，浏览器兜底辛苦抓到的 Referer / User-Agent 会被静默丢掉，
 * 防盗链站点就会对着空请求头返回 403 —— 整条抓请求头的链路等于死代码。
 */
function playbackFromInfo(info, fallbackUrl) {
  const candidate = typeof info?.url === 'string' ? info.url : fallbackUrl;
  let playbackUrl;
  try {
    playbackUrl = normalizeHttpUrl(candidate);
  } catch {
    return null;
  }
  return {
    url: playbackUrl,
    headers: sanitizePlaybackHeaders(info?.http_headers || info?.headers),
    protocol: String(info?.protocol || new URL(playbackUrl).protocol.replace(':', '')).slice(0, 40),
  };
}

function runJson(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('解析视频链接超时，请检查网络或换一个链接重试'));
    }, PARSE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(reject, new Error('链接返回的媒体信息过大，可能是播放列表而不是单个视频'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 16_384) stderr = stderr.slice(-8_192);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
        const error = new Error(`无法解析这个视频链接${detail ? `：${detail}` : ''}`);
        error.code = 'YTDLP_FAILED';
        error.detail = detail;
        finish(reject, error);
        return;
      }
      try {
        finish(resolve, JSON.parse(stdout));
      } catch {
        finish(reject, new Error('视频链接解析器返回了无法识别的数据'));
      }
    });
  });
}

function ytDlpArgs(url, extractorArgs = null) {
  const args = [
    '--ignore-config',
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-cache-dir',
    '--no-warnings',
    '--socket-timeout',
    '20',
  ];
  if (extractorArgs) args.push('--extractor-args', extractorArgs);
  args.push(
    // Android 端不能像 mpv 一样把独立音视频流现场合并，因此优先选择同时含
    // 音频和视频的 HTTP/HLS 格式。桌面端仍可以把原始页面地址交给 mpv。
    '--format',
    'best[protocol^=http][vcodec!=none][acodec!=none]/best[protocol^=m3u8][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]',
    '--',
    url
  );
  return args;
}

function isYouTubeUrl(url) {
  return YOUTUBE_HOST_RE.test(new URL(url).hostname);
}

function resultFromInfo(info, url) {
  if (info?._type === 'playlist' || Array.isArray(info?.entries)) {
    throw new Error('当前只支持单个视频链接，不支持播放列表或频道页面');
  }

  const playback = playbackFromInfo(info, looksLikeDirectMedia(url) ? url : null);
  return {
    url,
    title: String(info?.title || info?.fulltitle || new URL(url).hostname).slice(0, 240),
    duration: Number.isFinite(Number(info?.duration)) ? Number(info.duration) : 0,
    extractor: String(info?.extractor_key || info?.extractor || 'generic').slice(0, 80),
    direct: looksLikeDirectMedia(url) || info?.extractor === 'generic',
    playback,
    resolvedAt: Date.now(),
  };
}

async function inspectLink(rawUrl, { browserFallback } = {}) {
  const url = normalizeHttpUrl(rawUrl);
  const ytDlp = findYtDlp();

  // 直链即使没有 yt-dlp 也能交给 mpv；页面链接则必须先确认可解析。
  if (!ytDlp && looksLikeDirectMedia(url)) {
    return {
      url,
      title: fileNameFromUrl(url),
      duration: 0,
      extractor: 'direct',
      direct: true,
      playback: { url, headers: {}, protocol: new URL(url).protocol.replace(':', '') },
      resolvedAt: Date.now(),
    };
  }
  if (!ytDlp) {
    const error = new Error('没找到 yt-dlp，无法解析视频网页。请重新安装完整版本，或设置 SYNCWATCH_YTDLP_PATH。');
    error.code = 'YTDLP_NOT_FOUND';
    throw error;
  }

  // 交给 yt-dlp 之前，先自己把这条地址的跳转链走一遍，逐跳拒绝私网地址。
  //
  // 为什么需要：publicHttpUrl 只校验第一跳。yt-dlp 拿到地址后会自己跟随 302，
  // 主进程管不到 —— 房主广播一条公网地址、服务器 302 到 http://192.168.1.1/…，
  // 成员的机器就替攻击者对自己的局域网发了一次请求。
  //
  // **这只是部分缓解，不是根治。** 服务器完全可以对预检和 yt-dlp 返回不同的
  // 跳转目标（按 User-Agent 或请求次数区分），预检就被绕过了。要真正堵死，
  // 得让 yt-dlp 的每个请求都过一遍校验（比如走一个本地校验代理），
  // 那是隔离浏览器路径已经在做的事（见 browserMediaResolver 的 isPublicRequest）。
  // 这一层挡住的是「站点被入侵后无差别 302」这类非针对性的情况。
  await assertRedirectChainIsPublic(url);

  const attempts = isYouTubeUrl(url)
    // YouTube 当前逐步要求 PO Token。android_vr 客户端仍可匿名返回普通公开
    // 视频的音画合一格式，失败时再保留默认客户端作为兼容回退。
    ? ['youtube:player_client=android_vr', null]
    : [null, 'generic:impersonate'];
  let lastError;
  for (const extractorArgs of attempts) {
    try {
      return resultFromInfo(await runJson(ytDlp, ytDlpArgs(url, extractorArgs)), url);
    } catch (error) {
      lastError = error;
    }
  }

  if (typeof browserFallback === 'function' && !isYouTubeUrl(url)) {
    try {
      const browserInfo = await browserFallback(url);
      return {
        url,
        title: String(browserInfo.title || new URL(url).hostname).slice(0, 240),
        duration: Number.isFinite(Number(browserInfo.duration)) ? Number(browserInfo.duration) : 0,
        extractor: 'isolated-browser',
        direct: false,
        playback: playbackFromInfo(browserInfo.playback || browserInfo, null),
        resolvedAt: Date.now(),
      };
    } catch (browserError) {
      const error = new Error(`网站拒绝了自动解析，隔离浏览器也没有捕获到可播放媒体：${browserError.message || browserError}`);
      error.code = 'BROWSER_RESOLVE_FAILED';
      error.cause = lastError;
      throw error;
    }
  }
  throw lastError;
}

function toolStatus() {
  return { ytDlp: findYtDlp() };
}

module.exports = {
  assertRedirectChainIsPublic,
  playbackFromInfo,
  inspectLink,
  findYtDlp,
  normalizeHttpUrl,
  looksLikeDirectMedia,
  sanitizePlaybackHeaders,
  playbackFromInfo,
  isYouTubeUrl,
  ytDlpArgs,
  toolStatus,
};
