'use strict';

/**
 * 安卓原生（Kotlin）侧 0.7 改动的回归测试：快照代号、空间预算、输入法模式、版本号。
 *
 * 为什么是源码级的：仓库里没有 gradlew、`android/gradle/wrapper` 是空的、
 * build.gradle 里也没有任何测试依赖，所以跑不了 JVM 单测。这里沿用
 * `androidStoreKt.test.js` 的办法 —— 把 Kotlin 里那些**纯函数**的函数体现场翻成一个
 * 很小的 JS 子集直接执行，断言真实行为而不是源码长相；只有确实无法执行的部分
 * （投递到主线程的顺序）才退回结构断言，并且断言的是「分配代号在 post 之前」
 * 这种一改就失效的位置关系，而不是某一行文本。
 *
 * 三条被测的不变量：
 * ① 换片/释放都先同步拿到一个递增的代号，代号只在主线程真正换完播放器时才写进快照；
 * ② 快照带着自己的代号一起发给 JS，代号对不上的整条丢弃（否则连播换片时，
 *    第一条快照还是上一部片的位置，同步引擎会当成「有人拖动了」广播出去）；
 * ③ 原生和 JS 侧的空间预算读同一个数（Store.usableSpace）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const KT = 'android/app/src/main/java/com/syncwatch/app';
const PLAYER_KT = `${KT}/SyncPlayer.kt`;
const BRIDGE_KT = `${KT}/NativeBridge.kt`;
const STORE_KT = `${KT}/Store.kt`;
const MANIFEST_XML = 'android/app/src/main/AndroidManifest.xml';
const GRADLE = 'android/app/build.gradle';

const playerSrc = read(PLAYER_KT);
const bridgeSrc = read(BRIDGE_KT);
const storeSrc = read(STORE_KT);

/* --------------------- Kotlin 子集 → JS 的最小翻译器 --------------------- */

/** 按顶层逗号切分（形参类型里可能还有 ()、<>）。 */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '<' || c === '[') depth++;
    else if (c === ')' || c === '>' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 按名字取一个 Kotlin 函数，返回 {params, body, kind}。
 *
 * 两种函数体都认：`fun f(...) { ... }`（kind='block'）和 `fun f(...) = 表达式`
 * （kind='expr'，表达式可以换到下一行）。形参按括号配对取，所以 `patch: (Snap) -> Snap`
 * 这种带括号的类型也不会把签名截断。只认函数名不认整串签名：Kotlin 那边重新排版
 * 不该让整份测试加载失败，而该是某条用例红。
 */
function kotlinFun(src, name) {
  const head = new RegExp(`\\bfun\\s+${name}\\s*\\(`).exec(src);
  if (!head) return null;
  const paramStart = head.index + head[0].length;
  let i = paramStart;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  const params = splitTop(src.slice(paramStart, i - 1)).map((s) => s.split(':')[0].trim());

  // 跳过返回类型，找到 '=' 或 '{'（类型里不会出现这两个字符）
  while (i < src.length && src[i] !== '=' && src[i] !== '{') i++;
  if (i >= src.length) return null;

  if (src[i] === '{') {
    let d = 0;
    for (let p = i; p < src.length; p++) {
      if (src[p] === '{') d++;
      else if (src[p] === '}') {
        d--;
        if (d === 0) return { params, body: src.slice(i + 1, p), kind: 'block' };
      }
    }
    return null;
  }

  // 表达式体：跳过 '=' 后的空白/换行，取到括号配平后的行尾
  let p = i + 1;
  while (p < src.length && /\s/.test(src[p])) p++;
  let d = 0;
  let q = p;
  for (; q < src.length; q++) {
    const c = src[q];
    if (c === '(' || c === '{') d++;
    else if (c === ')' || c === '}') d--;
    else if (c === '\n' && d === 0) break;
  }
  return { params, body: src.slice(p, q).trim(), kind: 'expr' };
}

// ExoPlayer 的播放状态常量。取值本身不重要（真实值来自 Player 接口），
// 用例只依赖「四个值互不相同」。
const PLAYER_STATE = {
  STATE_IDLE: 1,
  STATE_BUFFERING: 2,
  STATE_READY: 3,
  STATE_ENDED: 4,
};

/** Kotlin → JS：状态常量、Long 字面量、minOf/maxOf、val/var、JSONObject 链。 */
function kotlinToJs(text) {
  return text
    .replace(/Player\.STATE_(\w+)/g, (m, s) => {
      const v = PLAYER_STATE[`STATE_${s}`];
      if (v === undefined) throw new Error(`翻译不了的播放状态常量：${m}`);
      return String(v);
    })
    .replace(/(\d)L\b/g, '$1')
    .replace(/(\d)_(?=\d)/g, '$1')
    .replace(/\bmaxOf\(/g, 'Math.max(')
    .replace(/\bminOf\(/g, 'Math.min(')
    .replace(/\b(?:val|var)\s+/g, 'let ')
    .replace(/JSONObject\(\)/g, 'J()');
}

/** org.json.JSONObject 的最小替身：put 可链式，toString 出 JSON。 */
function J() {
  const obj = {};
  const api = {
    put(k, v) {
      obj[k] = v;
      return api;
    },
    toString: () => JSON.stringify(obj),
  };
  return api;
}

/** data class Snap 的替身：位置参数一一对应，copy 同名。 */
function Snap(generation, posMs, durMs, playWhenReady, state) {
  const self = {
    generation,
    posMs,
    durMs,
    playWhenReady,
    state,
    copy(patch) {
      return Snap(
        patch.generation ?? generation,
        patch.posMs ?? posMs,
        patch.durMs ?? durMs,
        patch.playWhenReady ?? playWhenReady,
        patch.state ?? state
      );
    },
  };
  return self;
}

/** 现场把 SyncPlayer.kt 里的纯函数翻成可执行的 JS（只翻一次）。 */
let player = null;
function kotlinPlayer() {
  if (player) return player;

  const reset = kotlinFun(playerSrc, 'resetSnap');
  assert.ok(reset, 'SyncPlayer.kt 里没有 resetSnap(generation)：换片后快照就没有代号可带了');
  assert.deepEqual(reset.params, ['generation'], 'resetSnap 的形参变了');
  // eslint-disable-next-line no-new-func
  const resetSnap = new Function(
    reset.params[0],
    'Snap',
    `${reset.kind === 'expr' ? 'return ' : ''}${kotlinToJs(reset.body)}`
  );

  const snapJson = kotlinFun(playerSrc, 'snapJson');
  assert.ok(snapJson, 'SyncPlayer.kt 里没有 snapJson(s)：快照拼装不再是可验证的纯函数');
  assert.equal(snapJson.params.length, 1, `snapJson 的形参变了：${snapJson.params.join(',')}`);
  // eslint-disable-next-line no-new-func
  const snapJsonJs = new Function(
    snapJson.params[0],
    'J',
    `${snapJson.kind === 'expr' ? 'return ' : ''}${kotlinToJs(snapJson.body)}`
  );

  const update = kotlinFun(playerSrc, 'updateSnap');
  assert.ok(update, 'SyncPlayer.kt 里没有 updateSnap：旧播放器的迟到回调就没人挡了');
  assert.equal(update.params.length, 2, `updateSnap 的形参变了：${update.params.join(',')}`);
  // eslint-disable-next-line no-new-func
  const updateSnapJs = new Function(
    update.params[0],
    update.params[1],
    'host',
    kotlinToJs(update.body).replace(/\bsnap\b/g, 'host.snap')
  );

  player = {
    resetSnap: (generation) => resetSnap(generation, Snap),
    snapshot: (snap) => JSON.parse(snapJsonJs(snap, J)),
    updateSnap: (generation, patch, host) => updateSnapJs(generation, patch, host),
  };
  return player;
}

/* ------------------------------ 翻译器自检 ------------------------------ */

test('取函数体既认表达式体，也认带括号类型的形参', () => {
  const sample = `
class X {
    private fun resetSnap(generation: Int): Snap =
        Snap(generation, 0L, 0L, false, Player.STATE_IDLE)

    private fun updateSnap(generation: Int, patch: (Snap) -> Snap) {
        return 1
    }
}`;
  const expr = kotlinFun(sample, 'resetSnap');
  assert.equal(expr.kind, 'expr');
  assert.deepEqual(expr.params, ['generation']);
  assert.equal(expr.body, 'Snap(generation, 0L, 0L, false, Player.STATE_IDLE)');

  const block = kotlinFun(sample, 'updateSnap');
  assert.equal(block.kind, 'block');
  assert.deepEqual(block.params, ['generation', 'patch'], '带括号的函数类型把签名截断了');
  assert.equal(kotlinFun(sample, '压根没有这个函数'), null);
});

/* --------------------------- 快照：纯函数部分 --------------------------- */

test('快照 JSON 带上代号，位置和暂停与它出自同一组读数', () => {
  const kt = kotlinPlayer();
  const snap = kt.snapshot(Snap(7, 12345, 60000, true, PLAYER_STATE.STATE_READY));
  assert.equal(snap.generation, 7, '快照没有 generation：JS 分不出这条属于哪个播放器');
  assert.equal(snap.position, 12.345, '毫秒要换算成秒');
  assert.equal(snap.duration, 60);
  assert.equal(snap.paused, false);
  assert.equal(snap.idle, false);
  assert.equal(snap.eof, false);
});

test('paused 取「是否真的在推进」：缓冲中不算在播，免得被当成拖动', () => {
  const kt = kotlinPlayer();
  const buffering = kt.snapshot(Snap(2, 5000, 60000, true, PLAYER_STATE.STATE_BUFFERING));
  assert.equal(buffering.paused, true, '缓冲中还报 paused=false，同步引擎会拿个不动的位置去判跳变');
  const ready = kt.snapshot(Snap(2, 5000, 60000, false, PLAYER_STATE.STATE_READY));
  assert.equal(ready.paused, true, '没让它播就是暂停');
  const ended = kt.snapshot(Snap(2, 60000, 60000, true, PLAYER_STATE.STATE_ENDED));
  assert.equal(ended.eof, true);
  assert.equal(ended.paused, true);
  const idle = kt.snapshot(Snap(2, 0, 0, false, PLAYER_STATE.STATE_IDLE));
  assert.equal(idle.idle, true);
});

test('resetSnap：新代号的初始快照是 0:00、暂停、idle', () => {
  const kt = kotlinPlayer();
  const s = kt.resetSnap(9);
  assert.equal(s.generation, 9);
  assert.equal(s.posMs, 0);
  assert.equal(s.durMs, 0);
  assert.equal(s.playWhenReady, false);
  assert.equal(s.state, PLAYER_STATE.STATE_IDLE);
  const json = kt.snapshot(s);
  assert.deepEqual(json, {
    generation: 9,
    position: 0,
    duration: 0,
    paused: true,
    idle: true,
    eof: false,
  });
});

test('updateSnap：代号对不上的更新写不进去（旧播放器迟到的回调）', () => {
  const kt = kotlinPlayer();
  const host = { snap: kt.resetSnap(5) };
  kt.updateSnap(5, (s) => s.copy({ posMs: 1000 }), host);
  assert.equal(host.snap.posMs, 1000, '当前代号的更新必须写得进去');
  assert.equal(host.snap.generation, 5, '更新不该改动代号');

  kt.updateSnap(4, (s) => s.copy({ posMs: 999999 }), host);
  assert.equal(host.snap.posMs, 1000, '上一个播放器的读数污染了新快照');

  kt.updateSnap(6, (s) => s.copy({ posMs: 7 }), host);
  assert.equal(host.snap.posMs, 1000, '还没轮到的代号也不能提前写');
});

/* ------------------------- 换片竞态：代号的用处 ------------------------- */

/**
 * 用真源码里的 resetSnap/snapJson，加一个假的主线程队列，重演 P2 审查发现的那一幕：
 * load()/release() 只是把活儿 post 出去，同步返回时播放器还没换，这时取快照拿到的
 * 是上一部片的读数。下面那条结构断言保证 Kotlin 里确实是「先分配代号再 post」，
 * 所以这里可以照这个形状建模。
 */
function fakeMainLoop() {
  const queue = [];
  let seq = 0;
  const host = {
    snap: null,
    post: (fn) => queue.push(fn),
    drain() {
      while (queue.length) queue.shift()();
    },
    /** 对应 load / loadRemote / release：同步分配代号，换片的活儿投递到主线程。 */
    swap() {
      const kt = kotlinPlayer();
      const generation = ++seq;
      host.post(() => {
        host.snap = kt.resetSnap(generation);
      });
      return generation;
    },
  };
  return host;
}

test('换片后立刻取到的快照仍是上一部片的，代号让 JS 认得出来', () => {
  const kt = kotlinPlayer();
  const host = fakeMainLoop();

  // 上一部片正放到 1:23:45
  const first = host.swap();
  host.drain();
  kt.updateSnap(first, (s) => s.copy({ posMs: 5025000, durMs: 7200000, playWhenReady: true, state: PLAYER_STATE.STATE_READY }), host);
  assert.equal(kt.snapshot(host.snap).position, 5025);

  // 列表切到下一项：代号立刻拿到手，但主线程还没跑
  const second = host.swap();
  const stale = kt.snapshot(host.snap);
  assert.equal(typeof stale.generation, 'number', '快照里没有代号，这条和下一条就长得一样了');
  assert.equal(stale.generation, first, '换片还没落到主线程，快照本来就该还是旧的');
  assert.notEqual(stale.generation, second, 'JS 正是靠这个不等丢弃它');
  assert.equal(stale.position, 5025, '这就是会被误当成「有人拖到 1:23:45」的那条读数');
  assert.equal(stale.paused, false);

  // 主线程换完片
  host.drain();
  const fresh = kt.snapshot(host.snap);
  assert.equal(fresh.generation, second, '换完之后的快照才带新代号');
  assert.equal(fresh.position, 0, '新片从 0:00 开始');
  assert.equal(fresh.paused, true, '新建的播放器停着，等同步引擎发指令');
});

test('释放也占一个代号：release 落地前的快照不会被当成新播放器的', () => {
  const kt = kotlinPlayer();
  const host = fakeMainLoop();
  const playing = host.swap();
  host.drain();
  kt.updateSnap(playing, (s) => s.copy({ posMs: 30000, playWhenReady: true, state: PLAYER_STATE.STATE_READY }), host);

  const released = host.swap(); // 对应 release()
  assert.notEqual(kt.snapshot(host.snap).generation, released);
  host.drain();
  const after = kt.snapshot(host.snap);
  assert.equal(after.generation, released);
  assert.equal(after.idle, true, '释放后应该回到 idle');
  assert.equal(after.position, 0);
});

/* --------------------- 换片竞态：Kotlin 侧的位置关系 --------------------- */

for (const name of ['load', 'loadRemote', 'release']) {
  test(`${name}() 先同步分配代号再 post，并把代号返回给 JS`, () => {
    const fn = kotlinFun(playerSrc, name);
    assert.ok(fn, `SyncPlayer.kt 里没有 ${name}`);
    const alloc = fn.body.indexOf('generationSeq.incrementAndGet()');
    const post = fn.body.indexOf('main.post');
    assert.ok(alloc >= 0, `${name} 没有分配代号：JS 侧无从知道该等哪一条快照`);
    assert.ok(post >= 0, `${name} 不再投递到主线程了？这条用例的前提要重新确认`);
    assert.ok(
      alloc < post,
      `${name} 把代号分配放进了 main.post 里：同步返回时拿不到代号，JS 没法过滤`
    );
    const lines = fn.body.split('\n').map((s) => s.trim()).filter(Boolean);
    assert.equal(
      lines.at(-1),
      'return generation',
      `${name} 的返回值不是代号本身，JS 收不到要比对的那个数`
    );
    assert.match(
      playerSrc,
      new RegExp(`fun ${name}\\([^)]*\\):\\s*Int`),
      `${name} 的返回类型不是 Int`
    );
  });
}

test('代号只在主线程真正换完播放器时才写进快照', () => {
  const writes = [...playerSrc.matchAll(/snap\s*=\s*resetSnap\(/g)];
  assert.equal(writes.length, 2, '写入新代号的地方应该只有 replacePlayer 和 release 两处');

  const replace = kotlinFun(playerSrc, 'replacePlayer');
  assert.ok(replace, '没有 replacePlayer');
  assert.ok(
    replace.body.indexOf('player?.release()') < replace.body.indexOf('snap = resetSnap('),
    '快照抢在旧播放器释放之前就换了代号：那一瞬间的读数还是旧播放器的'
  );
  assert.ok(
    replace.params.includes('generation'),
    'replacePlayer 不收代号，就只能自己再生成一个，和同步返回给 JS 的那个对不上'
  );

  const release = kotlinFun(playerSrc, 'release');
  assert.ok(
    release.body.indexOf('main.post') < release.body.indexOf('snap = resetSnap('),
    'release 在主线程之外就把快照换了代号，等于提前宣布释放完成'
  );
});

test('轮询和播放器回调都按代号过滤，旧播放器写不进新快照', () => {
  const start = kotlinFun(playerSrc, 'startPolling');
  assert.ok(start, '没有 startPolling');
  assert.ok(start.params.includes('generation'), '轮询不带代号就停不下来');
  assert.match(
    start.body,
    /if \(snap\.generation != generation\) return/,
    '轮询没有在代号变了之后自己停下：旧循环会一直往新快照里写位置'
  );
  const replace = kotlinFun(playerSrc, 'replacePlayer');
  assert.match(
    replace.body,
    /onPlaybackStateChanged[\s\S]*updateSnap\(generation\)/,
    '播放状态回调没走 updateSnap 的代号过滤'
  );
  assert.match(
    replace.body,
    /onPlayWhenReadyChanged[\s\S]*updateSnap\(generation\)/,
    'playWhenReady 回调没走 updateSnap 的代号过滤'
  );
  assert.ok(
    !/@Volatile private var (posMs|durMs|playWhenReady|state)\b/.test(playerSrc),
    '快照又拆回一堆各写各的字段了：读的一方会看到「新代号配旧位置」的撕裂'
  );
});

/* ------------------------------ NativeBridge ------------------------------ */

test('playerLoad 返回代号，会话不存在时返回 0（JS 原来的真假判断照样成立）', () => {
  const fn = kotlinFun(bridgeSrc, 'playerLoad');
  assert.ok(fn, 'NativeBridge.kt 里没有 playerLoad');
  assert.match(bridgeSrc, /fun playerLoad\(sessionId: String\): Int/, 'playerLoad 的返回类型不是 Int');
  // val s = store.get(sessionId) ?: return 0  →  取出来跑一遍
  const body = kotlinToJs(fn.body).replace(
    /^(\s*)let\s+(\w+)\s*=\s*(.+?)\s*\?:\s*return\s+(.+)$/gm,
    '$1let $2 = $3; if ($2 == null) return $4;'
  );
  // eslint-disable-next-line no-new-func
  const playerLoad = new Function('sessionId', 'store', 'player', body);

  const store = { get: (id) => (id === 'leech-1' ? { id } : null) };
  const calls = [];
  const fake = {
    load(s) {
      calls.push(s.id);
      return 42;
    },
  };
  assert.equal(playerLoad('leech-1', store, fake), 42, '应该把 SyncPlayer 分配的代号原样带回 JS');
  assert.deepEqual(calls, ['leech-1']);
  assert.equal(playerLoad('leech-9', store, fake), 0, '会话不存在要返回 0');
  assert.deepEqual(calls, ['leech-1'], '会话不存在时不该去碰播放器');
  assert.ok(0 < 1, '代号从 1 开始，0 才能既当失败又是 JS 里的假值');
});

test('playerLoadUrl / playerRelease 也返回代号，失败给 0', () => {
  assert.match(bridgeSrc, /fun playerLoadUrl\(rawUrl: String, headersJson: String\): Int/);
  const loadUrl = kotlinFun(bridgeSrc, 'playerLoadUrl');
  const lines = loadUrl.body.split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(
    lines.includes('player.loadRemote(url, headers)'),
    'try 块的值不再是 loadRemote 的代号'
  );
  assert.ok(
    !/\b(true|false)\b/.test(loadUrl.body),
    'playerLoadUrl 还在返回布尔值：JS 拿不到代号'
  );
  assert.match(loadUrl.body, /catch[\s\S]*\n\s*0\s*\n/, '失败分支没有返回 0');
  assert.match(bridgeSrc, /fun playerRelease\(\): Int = player\.release\(\)/);
});

test('playerSnapshot 的契约写在注释里（generation 是给 JS 用的，不是装饰）', () => {
  assert.match(bridgeSrc, /\{generation, position, duration, paused, idle, eof\}/);
  assert.match(bridgeSrc, /整条丢弃/, '没写清代号对不上时该怎么做');
});

/* --------------------------- 空间预算 usableSpace --------------------------- */

test('NativeBridge.usableSpace 是暴露给 JS 的，值直接来自 Store', () => {
  assert.match(
    bridgeSrc,
    /@JavascriptInterface\s*\n\s*fun usableSpace\(\): String = store\.usableSpace\(\)\.toString\(\)/,
    'usableSpace 要么没暴露给 JS，要么不是原样取自 Store'
  );
  assert.match(
    read('android/app/src/main/java/com/syncwatch/app/Store.kt'),
    /fun usableSpace\(\): Long/,
    'Store 没有 usableSpace()'
  );
});

test('原生的空间检查和 JS 的空间预算读同一个数', () => {
  const open = kotlinFun(storeSrc, 'openLeech');
  assert.ok(open, 'Store.kt 里没有 openLeech');
  assert.match(
    open.body,
    /val free = usableSpace\(\)/,
    'openLeech 没走 usableSpace()：JS 侧算出来「放得下」，原生这边照样可能 require 失败'
  );
  assert.ok(
    !/mediaDir\(\)\.usableSpace/.test(open.body),
    'openLeech 又自己去读目录了，两处判据会分家'
  );
});

test('空间预算的门槛：留 1% 或 256MB（取大），查不到余量时不拦', () => {
  const open = kotlinFun(storeSrc, 'openLeech');
  const reserveExpr = /val reserve = (.+)/.exec(open.body);
  assert.ok(reserveExpr, '取不到 reserve 的算法');
  const condExpr = /require\(([^)]*free[^)]*)\)/.exec(open.body);
  assert.ok(condExpr, '取不到空间检查的判据');
  // eslint-disable-next-line no-new-func
  const allows = new Function(
    'free',
    'size',
    `let reserve = ${kotlinToJs(reserveExpr[1])}; return !!(${kotlinToJs(condExpr[1])});`
  );

  const GB = 1024 * 1024 * 1024;
  // 尺寸都取 100 的整数倍：Kotlin 那边 size / 100 是整数除法，JS 是浮点除法，
  // 挑整除的数，两边算出来的 reserve 就是同一个，用例断言的才是真门槛。
  const small = 1 * GB; // 1% = 10.24MB < 256MB，按 256MB 留
  assert.equal(allows(small + 256 * 1024 * 1024, small), true, '刚好留够 256MB 应该放行');
  assert.equal(allows(small + 256 * 1024 * 1024 - 1, small), false, '差一个字节就该拦');

  const big = 100 * GB; // 1% = 1GB > 256MB，按 1% 留
  assert.equal(allows(big + 1 * GB, big), true);
  assert.equal(allows(big + 1 * GB - 1, big), false, '大文件要按 1% 留余量');

  assert.equal(allows(0, big), true, '余量查不到（0）时不拦，让真正的写入错误说话');
  assert.equal(allows(-1, big), true, '负数同样按「不知道」处理');
});

/* --------------------------- Manifest / build.gradle --------------------------- */

/** 取 <activity ...> 开标签上的属性。 */
function activityAttrs(xml) {
  const m = /<activity\b([\s\S]*?)>/.exec(xml);
  assert.ok(m, 'AndroidManifest.xml 里没有 activity');
  const attrs = {};
  for (const a of m[1].matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
  return attrs;
}

test('输入法弹出时窗口变矮而不是整体上顶（聊天输入条要贴在键盘上方）', () => {
  const attrs = activityAttrs(read(MANIFEST_XML));
  assert.equal(
    attrs['android:windowSoftInputMode'],
    'adjustResize',
    '没设 adjustResize：默认的 adjustPan 会把窗口顶上去，输入条和聊天记录都跑出屏幕'
  );
  // adjustResize 对全屏窗口不生效 —— 主题里一旦加上 windowFullscreen，上面那条就白设了
  const theme = read('android/app/src/main/res/values/themes.xml');
  assert.ok(
    !/android:windowFullscreen">\s*true/.test(theme),
    '主题成了全屏窗口，adjustResize 会失效'
  );
  // 内容视图要能跟着变矮，WebView 才会收到新的视口高度
  const layout = read('android/app/src/main/res/layout/activity_main.xml');
  assert.match(layout, /android:id="@\+id\/web"[\s\S]*?android:layout_height="match_parent"/);
});

test('版本号升到 0.7.0（协议 v2，和 0.6.x 不互通）', () => {
  const gradle = read(GRADLE);
  const code = Number(/versionCode\s+(\d+)/.exec(gradle)[1]);
  const name = /versionName\s+"([^"]+)"/.exec(gradle)[1];
  assert.ok(code >= 16, `versionCode 要大于 0.6.8 的 15，现在是 ${code}`);
  assert.equal(name, '0.7.0');
  assert.match(read('android/README.md'), /0\.7\.0/, 'README 还写着旧版本号');
});

/* -------------------------------- 文档同步 -------------------------------- */

test('android/README.md 写清了手机端的新能力和那条硬限制', () => {
  const md = read('android/README.md');
  assert.match(md, /不能编辑列表/, '没写「手机不能编辑播放列表」这条用户定下的边界');
  assert.match(md, /弹幕/);
  assert.match(md, /聊天/);
  assert.match(md, /usableSpace/, '没写 JS 侧空间预算要用的原生接口');
  assert.match(md, /generation/, '没写快照代号这条 JS 必须配合的约定');
  assert.match(md, /adjustResize/);
});
