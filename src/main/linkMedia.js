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
const { findBin } = require('./findBin');

const DIRECT_MEDIA_RE = /\.(?:mp4|m4v|mov|mkv|webm|m3u8|mpd)(?:$|[?#])/i;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 60_000;
const SAFE_PLAYBACK_HEADERS = new Set(['accept', 'accept-language', 'origin', 'referer', 'user-agent']);
const YOUTUBE_HOST_RE = /(^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

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
    headers: sanitizePlaybackHeaders(info?.http_headers),
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
      title: decodeURIComponent(new URL(url).pathname.split('/').pop() || '在线视频'),
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
