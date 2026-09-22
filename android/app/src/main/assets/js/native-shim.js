/**
 * 原生能力垫片。对应 PC 端 preload.js 暴露的 window.sw。
 *
 * swarm.js 会直接调用 window.sw.store.readChunk / writeChunk —— 这里把它们接到
 * Kotlin 的 NativeBridge 上，让复用的协议代码一个字不用改。
 *
 * 分片是二进制，过桥只能走字符串，所以 base64 编解码。一片 2MB，编解码几毫秒，
 * 吞吐本来就是网络瓶颈，可接受。
 */

const CHUNK = 0x8000; // String.fromCharCode.apply 一次别喂太多，免得爆栈

export function abToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToAb(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// window.sw.store —— swarm.js 直接用这几个方法，签名必须对上 PC 端。
window.sw = window.sw || {};
window.sw.store = {
  // 供 swarm._serveOne：返回 ArrayBuffer
  async readChunk(sessionId, index) {
    const b64 = Native.readChunk(sessionId, index);
    if (b64 == null || b64 === '') throw new Error('readChunk(' + index + ') 失败');
    return b64ToAb(b64);
  },
  // 供 swarm._commitChunk：接收 ArrayBuffer，返回 {ok,duplicate,haveCount,contiguousBytes,complete,reason}
  async writeChunk(sessionId, index, arrayBuffer) {
    const b64 = abToB64(arrayBuffer);
    return JSON.parse(Native.writeChunk(sessionId, index, b64));
  },
  // 手机专用：按清单开一个接收会话
  openLeech(manifest) {
    const id = Native.openLeech(
      manifest.fileId,
      manifest.name,
      String(manifest.size),
      manifest.chunkSize,
      manifest.chunkCount,
      JSON.stringify(manifest.hashes)
    );
    // 原生层失败时返回 "!原因"（见 NativeBridge.openLeech），把原因原样抛出去给界面显示。
    if (!id || id.startsWith('!')) throw new Error(id ? id.slice(1) : 'openLeech 失败');
    return id;
  },
  sessionState(sessionId) {
    return JSON.parse(Native.sessionState(sessionId));
  },
  contiguousBytes(sessionId) {
    return Number(Native.contiguousBytes(sessionId));
  },
  close(sessionId) {
    Native.closeSession(sessionId);
  },
};

// 播放器控制。同步引擎通过它驱动原生 ExoPlayer（对应 PC 端驱动 mpv）。
//
// load / loadUrl / release 都只是把活投递到主线程，同步返回时播放器还没换完。
// 它们返回的是这次换片的「代号」（0 表示失败），快照里也带着同一个代号：
// 对不上就说明手里这条读数还是上一部片的，必须整条丢掉 —— 否则换片瞬间会把
// 上一部的位置当成「有人拖动了」广播给全房。
window.swPlayer = {
  load(sessionId) {
    return Number(Native.playerLoad(sessionId)) || 0;
  },
  loadUrl(url, headers = {}) {
    return Number(Native.playerLoadUrl(url, JSON.stringify(headers))) || 0;
  },
  setPause(paused) {
    Native.playerSetPause(!!paused);
  },
  seek(seconds) {
    Native.playerSeek(Number(seconds) || 0);
  },
  snapshot() {
    return JSON.parse(Native.playerSnapshot());
  },
  release() {
    return Number(Native.playerRelease()) || 0;
  },
};

// 离开房间：原生那边释放播放器、关掉所有接收会话（缓存跟着删）。调用方随后整页重载。
window.sw.leaveRoom = () => {
  try {
    Native.leaveRoom();
  } catch (e) {}
};

// 安装包版本号（build.gradle 的 versionName）。拿不到就是空串。
window.sw.appVersion = () => {
  try {
    return String(Native.appVersion?.() ?? '');
  } catch (e) {
    return '';
  }
};

// 把 console 也送一份到 logcat，方便 adb logcat 里看。
// logcat 单条本来就只显示 4KB 左右：超长的先在这边截掉，别拖着几 MB 的字符串过桥。
const MAX_NATIVE_LOG_CHARS = 4000;
const _log = console.log.bind(console);
console.log = (...args) => {
  try {
    const line = args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    Native.log(line.length > MAX_NATIVE_LOG_CHARS ? line.slice(0, MAX_NATIVE_LOG_CHARS) + '…' : line);
  } catch (e) {}
  _log(...args);
};
