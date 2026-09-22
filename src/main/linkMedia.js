'use strict';

/**
 * 视频链接解析。
 *
 * 这里不下载媒体，也不把解析后的临时 CDN 地址发给其他成员。每台客户端都用
 * 原始页面地址在本机解析并交给 mpv，避免短时效签名 URL 在房间里过期或泄漏。
 */

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const net = require('net');
const { findBin } = require('./findBin');
const { isPublicIp, resolvePublic, publicLookup } = require('./ipGuard');

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

// 私网判定统一用 ipGuard：这里原来自己写了一份，认不出 WHATWG URL 规范化之后的
// [::ffff:7f00:1] 这种十六进制映射地址，也漏了 fe90–febf 那一段链路本地地址。
async function hostIsPublic(hostname) {
  try {
    await resolvePublic(hostname);
    return true;
  } catch {
    return false;
  }
}

/**
 * 发一个 HEAD，不跟随跳转，返回 { status, location }。
 *
 * 不用 fetch：它自己解析 DNS，而上一步 hostIsPublic 判定时解析的是另一次 ——
 * 两次之间换个答案（DNS 重绑定），这一发 HEAD 就打到内网去了。这里改成连接那一刻才解析、
 * 才判定（publicLookup），IP 字面量 Node 不会走 lookup，先自己判一遍。
 */
function headOnce(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isPublicIp(host)) {
      const error = new Error('拒绝访问非公网地址');
      error.code = 'ENOTPUBLIC';
      return reject(error);
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'HEAD',
      lookup: publicLookup,
      agent: false,
      timeout: timeoutMs,
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const timer = setTimeout(() => req.destroy(new Error('跳转预检超时')), timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location || '' });
      req.destroy();
    });
    req.on('timeout', () => req.destroy(new Error('跳转预检超时')));
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

/** 手动走一遍跳转链，任何一跳指向私网就拒绝。见调用处对局限性的说明。 */
async function assertRedirectChainIsPublic(startUrl, { head = headOnce } = {}) {
  let current = startUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    let res;
    try {
      res = await head(current);
    } catch {
      return; // 探不动就放行，交给 yt-dlp —— 这一层是加固，不是准入门槛
    }
    if (res.status < 300 || res.status >= 400) return;
    const location = res.location;
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

/** 子进程环境去掉 no_proxy：命中它的主机会绕过 --proxy，私网过滤也就跟着失效了。 */
function childEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'no_proxy') delete env[key];
  }
  return env;
}

function runJson(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    const chunks = [];
    let stdoutBytes = 0;
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

    // 按字节累计：原来每来一块都把整段已收的字符串重新量一遍长度，8MB 的输出要白扫上百遍
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(reject, new Error('链接返回的媒体信息过大，可能是播放列表而不是单个视频'));
        return;
      }
      chunks.push(chunk);
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
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(reject, new Error('视频链接解析器返回了无法识别的数据'));
      }
    });
  });
}

function ytDlpArgs(url, extractorArgs = null, proxy = null) {
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
  // 本机过滤代理（publicProxy.js）：yt-dlp 的每个请求、每一跳跳转都在代理那里按「连接那一刻」
  // 解析出的 IP 判定，私网一律 403。这才是真正堵住 SSRF 的那一道，下面的跳转链预检只是提前报错。
  if (proxy) args.push('--proxy', proxy);
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

async function inspectLink(rawUrl, { browserFallback, proxy = null } = {}) {
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
  // 跳转目标（按 User-Agent 或请求次数区分），预检就被绕过了。真正堵死它的是
  // 本机过滤代理（proxy，见 publicProxy.js）：yt-dlp 的每个请求都经过它，
  // 在连接那一刻按解析出的 IP 判定。这里保留预检，只是为了在常见情况下
  // 给出一句「跳转到了内网地址」，而不是 yt-dlp 那句笼统的 HTTP 403。
  await assertRedirectChainIsPublic(url);

  const attempts = isYouTubeUrl(url)
    // YouTube 当前逐步要求 PO Token。android_vr 客户端仍可匿名返回普通公开
    // 视频的音画合一格式，失败时再保留默认客户端作为兼容回退。
    ? ['youtube:player_client=android_vr', null]
    : [null, 'generic:impersonate'];
  let lastError;
  for (const extractorArgs of attempts) {
    try {
      return resultFromInfo(await runJson(ytDlp, ytDlpArgs(url, extractorArgs, proxy)), url);
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
  hostIsPublic,
  headOnce,
  childEnv,
};
