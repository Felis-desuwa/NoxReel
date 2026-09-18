'use strict';

/**
 * 安卓原生（Kotlin）侧「从播放位置起连续可读」的回归测试。
 *
 * 背景：可信房间里中途加入的人从房间当前位置 P 起播，`[片头, P)` 整段是空洞。
 * 旧的 `Store.Session.awaitData` 用「从文件头起的连续水位线 contiguousBytes」判断
 * 能不能读，于是 P 处即使有数据也一直阻塞；更糟的是一旦 `complete` 提前为真，
 * 它会返回 -1，ExoPlayer 把 END_OF_INPUT 当成文件到头直接进 ENDED。
 * 现在改成「从 pos 所在分片起连续可读的字节数」（`readableFrom`），与桌面端
 * `swarm.runEndFrom()` 同一算法。
 *
 * 这个仓库的 android/ 目录里没有 gradlew、没有 wrapper jar、没有 src/test 源集，
 * build.gradle 也没有任何测试依赖，JVM 单测跑不起来（详见任务报告）。所以这里
 * 把 Kotlin 里那两段**纯算术 / 纯分支**的函数体按一个很小的子集翻成 JS 直接执行，
 * 断言的是真实行为而不是源码长相：改坏算法（比如退回 contiguousBytes）用例必红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const STORE_KT = 'android/app/src/main/java/com/syncwatch/app/Store.kt';
const GDS_KT = 'android/app/src/main/java/com/syncwatch/app/GrowingDataSource.kt';

const storeSrc = read(STORE_KT);

/* --------------------- Kotlin 子集 → JS 的最小翻译器 --------------------- */

/**
 * 按名字找一个 Kotlin 函数，返回 {params, body}（body 不含最外层花括号）。
 *
 * 签名用正则匹配而不是逐字比对整串：修饰符、参数名、空格、换行怎么排都认得出来。
 * 以前这里写死了 'private fun readableFrom(pos: Long): Long {'，Kotlin 那边
 * 换个格式（比如参数换行）就不是「某条用例红了」，而是整个测试文件加载失败。
 * 参数名也从签名里取，翻译出来的 JS 函数照着它绑形参。
 * 这两个函数体里没有字符串字面量，数花括号就够。
 */
function kotlinFun(src, name) {
  const re = new RegExp(`\\bfun\\s+${name}\\s*\\(([^)]*)\\)\\s*(?::\\s*[\\w.<>?]+\\s*)?\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const params = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(':')[0].trim());
  const start = m.index + m[0].length - 1; // 指向签名末尾那个 '{'
  let depth = 0;
  for (let p = start; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') {
      depth--;
      if (depth === 0) return { params, body: src.slice(start + 1, p) };
    }
  }
  return null;
}

/** Kotlin 的整数除法 / 类型转换 / minOf / val|var，翻成等价的 JS。 */
function kotlinToJs(body) {
  return body
    .replace(/\(([^()]*)\)\.toInt\(\)/g, 'Math.trunc($1)')
    .replace(/\.toLong\(\)/g, '')
    .replace(/\bminOf\(/g, 'Math.min(')
    .replace(/\b(?:val|var)\s+/g, 'let ');
}

/** 现场把 Kotlin 翻成可执行的 JS。只翻一次，翻不动就抛（由第一条用例报出来）。 */
let translated = null;
function kotlin() {
  if (translated) return translated;
  const readable = kotlinFun(storeSrc, 'readableFrom');
  assert.ok(
    readable,
    'Store.kt 里没有 readableFrom(pos)：安卓中途加入会一直阻塞在旧的水位线判据上'
  );
  assert.equal(readable.params.length, 1, `readableFrom 的参数变了：${readable.params.join(',')}`);
  // eslint-disable-next-line no-new-func
  const readableFromJs = new Function(
    readable.params[0],
    'have',
    'chunkSize',
    'chunkCount',
    'size',
    kotlinToJs(readable.body)
  );

  const await_ = kotlinFun(storeSrc, 'awaitData');
  assert.ok(await_, 'Store.kt 里没有 awaitData');
  assert.equal(await_.params.length, 2, `awaitData 的参数变了：${await_.params.join(',')}`);
  // eslint-disable-next-line no-new-func
  const awaitDataJs = new Function(
    await_.params[0],
    await_.params[1],
    'st',
    await_.body
      .replace(/lock\.withLock\s*\{/, '{')
      .replace(/progress\.await\([^)]*\)/g, 'st.wait()')
      .replace(/\b(?:val|var)\s+/g, 'let ')
      .replace(/\breadableFrom\(/g, 'st.readableFrom(')
      // 旧实现用的判据；留着翻译规则，好让「退回 contiguousBytes」这种改法也能跑起来变红
      .replace(/\bcontiguousBytes\(/g, 'st.contiguousBytes(')
      .replace(/\bclosed\b/g, 'st.closed')
      .replace(/\bcomplete\b/g, 'st.complete')
      .replace(/\bsize\b/g, 'st.size')
  );

  translated = { readableFromJs, awaitDataJs, awaitBody: await_.body };
  return translated;
}

/** 按 Kotlin 源码现场翻译执行，参数与 Session 的字段一一对应。 */
function readableFrom(pos, { have, chunkSize, size }) {
  return kotlin().readableFromJs(pos, have, chunkSize, have.length, size);
}

const STILL_WAITING = Symbol('still-waiting');

/**
 * 跑一遍 awaitData。`onWait` 每次被唤醒时调用（可以顺手补分片）；
 * 等待次数超过 maxWaits 就抛 STILL_WAITING —— 「一直在等」本身就是我们要断言的行为。
 */
function awaitData(pos, session, { onWait = () => {}, maxWaits = 4 } = {}) {
  let waits = 0;
  const st = {
    get closed() { return session.closed === true; },
    get complete() { return session.have.every(Boolean); },
    get size() { return session.size; },
    readableFrom: (p) => readableFrom(p, session),
    contiguousBytes() {
      let i = 0;
      while (i < session.have.length && session.have[i]) i++;
      return Math.min(i * session.chunkSize, session.size);
    },
    wait() {
      waits++;
      if (waits > maxWaits) throw STILL_WAITING;
      onWait(waits, session);
    },
  };
  try {
    return kotlin().awaitDataJs(pos, 1000, st);
  } catch (e) {
    if (e === STILL_WAITING) return STILL_WAITING;
    throw e;
  }
}

/* ------------------------------ 翻译器本身 ------------------------------ */

test('Kotlin 重新排版不会让整份测试失效（只认函数名，不认那一串签名）', () => {
  // 参数换行、加修饰符、返回类型前后多空格 —— 这些都不该影响取出函数体
  const reformatted = `
class X {
    @JvmOverloads
    internal fun readableFrom(
        position: Long
    ) : Long {
        if (position >= size) return 0
        return 42
    }
}`;
  const fn = kotlinFun(reformatted, 'readableFrom');
  assert.ok(fn, '换个排版就取不出函数体了：一改格式整个文件都加载不起来');
  assert.deepEqual(fn.params, ['position'], '形参名要从签名里取，翻出来的 JS 才绑得上');
  assert.match(fn.body, /return 42/);
  assert.equal(kotlinFun(reformatted, '压根没有这个函数'), null);
});

/* ------------------------------ readableFrom ------------------------------ */

// chunkSize=4、3 片、size=10：末片只有 2 字节，专门用来卡边界
const tiny = (bits) => ({ have: bits.map(Boolean), chunkSize: 4, size: 10 });

test('readableFrom：落在连续区里就报到这段连续片的末尾', () => {
  const s = tiny([1, 1, 0]);
  assert.equal(readableFrom(0, s), 8, '前两片都在，从 0 起能读 8 字节');
  assert.equal(readableFrom(3, s), 5, '从片内任意位置起算，不是按片对齐');
  assert.equal(readableFrom(7, s), 1, '连续区最后一个字节仍可读');
});

test('readableFrom：pos 所在片缺失时返回 0，而不是拿后面的连续区凑数', () => {
  const s = tiny([1, 0, 1]);
  assert.equal(readableFrom(4, s), 0, '第 1 片是洞');
  assert.equal(readableFrom(5, s), 0, '洞里的非片首位置也必须是 0，不能算出负数');
  assert.equal(readableFrom(0, s), 4, '洞前只能读到洞口');
  assert.equal(readableFrom(8, s), 2, '洞后那段自己算自己的');
});

test('readableFrom：末片不足 chunkSize 时按文件大小封顶', () => {
  const s = tiny([1, 1, 1]);
  assert.equal(readableFrom(0, s), 10, '不能报成 3*4=12');
  assert.equal(readableFrom(9, s), 1);
});

test('readableFrom：pos 到了文件尾或越界返回 0', () => {
  const s = tiny([1, 1, 1]);
  assert.equal(readableFrom(10, s), 0);
  assert.equal(readableFrom(99, s), 0);
  assert.equal(readableFrom(-1, s), 0, '负的 pos 不能算出一个正的可读长度');
});

test('readableFrom：中途加入的真实布局 —— 片头 8MB + 播放位置附近 20MB', () => {
  const CHUNK = 2 * 1024 * 1024;
  const COUNT = 200; // 400MB
  const size = COUNT * CHUNK;
  const have = new Array(COUNT).fill(false);
  for (let i = 0; i < 4; i++) have[i] = true; // 片头 8MB
  const p = 100 * CHUNK; // 房间播放位置 200MB 处
  for (let i = 100; i < 110; i++) have[i] = true; // [P, P+20MB]
  const s = { have, chunkSize: CHUNK, size };

  assert.equal(readableFrom(p, s), 20 * 1024 * 1024, '从 P 起有整整 20MB 可读');
  assert.equal(readableFrom(0, s), 8 * 1024 * 1024, '片头这段照旧');
  assert.equal(readableFrom(50 * CHUNK, s), 0, '中间的空洞报 0');
  assert.equal(readableFrom(110 * CHUNK, s), 0, '连续区尽头之外报 0');
});

/* -------------------------------- awaitData ------------------------------- */

test('awaitData：pos 处有数据就立刻返回可读长度（中途加入的核心用例）', () => {
  const CHUNK = 4;
  const have = [true, false, false, true, true, false];
  const s = { have, chunkSize: CHUNK, size: 6 * CHUNK };
  assert.equal(awaitData(12, s), 8, 'P=12 处有两片连续，必须马上能读');
});

test('awaitData：pos 所在片还没到时继续等，绝不能返回 -1', () => {
  const s = { have: [true, false, false], chunkSize: 4, size: 12 };
  const r = awaitData(4, s);
  assert.equal(
    r,
    STILL_WAITING,
    '返回 -1 会让 ExoPlayer 把 END_OF_INPUT 当成文件到头，直接进 ENDED'
  );
});

test('awaitData：等待期间分片补上就醒过来往下读', () => {
  const s = { have: [true, false, false], chunkSize: 4, size: 12 };
  const r = awaitData(4, s, {
    onWait: (n, sess) => { if (n === 2) sess.have[1] = true; },
  });
  assert.equal(r, 4, '补上第 1 片后从 pos=4 起可读 4 字节');
});

test('awaitData：真 EOF（pos >= size）返回 -1', () => {
  const s = { have: [true, true, true], chunkSize: 4, size: 10 };
  assert.equal(awaitData(10, s), -1);
  assert.equal(awaitData(11, s), -1, '越界同样按 EOF 处理，不能无限等');
  // 文件还没收齐时越界读也必须立刻 -1，不能因为「没 complete」就一直等下去
  const partial = { have: [true, false, false], chunkSize: 4, size: 12 };
  assert.equal(awaitData(12, partial), -1, '缺了 pos >= size 的守卫就会死等');
});

test('awaitData：全部收齐时行为不变 —— 报到文件尾的剩余长度', () => {
  const s = { have: [true, true, true], chunkSize: 4, size: 10 };
  assert.equal(awaitData(0, s), 10);
  assert.equal(awaitData(9, s), 1, '末片不足 chunkSize 也不能报出文件尾以外');
});

test('awaitData：会话关闭返回 -1', () => {
  const s = { have: [true, true, true], chunkSize: 4, size: 10, closed: true };
  assert.equal(awaitData(0, s), -1);
});

test('awaitData 不再用从文件头起的连续水位线做判据', () => {
  assert.ok(
    !/contiguousBytes\(\)/.test(kotlin().awaitBody),
    'awaitData 里又出现了 contiguousBytes()：中途加入会退回「永远读不出数据」'
  );
  assert.match(
    storeSrc,
    /fun contiguousBytes\(\)/,
    'contiguousBytes 仍要保留 —— 它是完整度，只是不再当播放判据'
  );
});

/* --------------------------- GrowingDataSource --------------------------- */

test('GrowingDataSource 的注释说清了阻塞判据是当前连续区而不是水位线', () => {
  const src = read(GDS_KT);
  assert.ok(
    !/读到连续水位线以外就阻塞/.test(src),
    '注释还在说「读到连续水位线以外就阻塞」，与 awaitData 的实际判据不符'
  );
  assert.match(src, /连续已收数据的末尾/, '没写清真正的阻塞边界');
  assert.match(src, /ENDED/, '没提「被误判成文件到头」这个后果');
  // 逻辑本身不变：负数仍然是 END_OF_INPUT，其余按 min(length, bytesRemaining, available) 读
  assert.match(src, /if \(available < 0\) return C\.RESULT_END_OF_INPUT/);
  assert.match(src, /minOf\(length\.toLong\(\), bytesRemaining, available\)/);
});

/* -------------------------------- 文档同步 -------------------------------- */

test('CLAUDE.md 把两条水位线讲清楚了', () => {
  const md = read('CLAUDE.md');
  assert.match(md, /两条水位线：完整度 `contiguousBytes` 与可播长度 `runBytes`/);
  assert.match(md, /readableFrom\(\)/, '没写安卓侧的对应算法在哪');
  assert.match(md, /中途加入房间时它们相差整整一部片/);
  assert.ok(
    !/每人算 `contiguousBytes - 播放字节位置`/.test(md),
    '「全员暂停」那条还在用旧判据描述'
  );
  assert.match(md, /每人算 `runBytes`/);
  assert.match(md, /文件头 8 MB/, '没写调度器的片头保留区');
  assert.match(md, /文件尾 4 MB/, '没写文件尾的索引保留区');
  assert.match(md, /只有按内容确认过是 faststart MP4/, '没写文件尾保留区的判据是反着的（扩展名不作数）');
  assert.match(md, /排在 `_evaluateStall` \*\*前面\*\*/, '没写 eof 守卫和卡顿评估的先后');
  assert.match(md, /让播放器重新解复用一次/, '没写 eof 卡顿的恢复路径');
  assert.match(md, /要看房间播到第几秒，不是看换算出来的字节位置/, '没写「码率未知时门槛会静默失效」这条');
  assert.match(md, /- \*\*中途加入（可信房间）\*\*/, '关键约定里缺中途加入这条');
  assert.match(md, /绝不能返回 -1/, '没把安卓侧那条最容易踩的不变量写下来');
});

test('android/README.md 不再说数据源「只读到连续水位线」', () => {
  const md = read('android/README.md');
  assert.ok(!/只读到连续水位线为止/.test(md), '安卓说明还在用旧判据描述数据源');
  assert.match(md, /当前播放位置所在那段连续已收数据/);
  assert.match(md, /绝不能返回 -1/);
});

test('README 两份都同步了两条水位线的说法', () => {
  const zh = read('README.md');
  const en = read('README.en.md');
  assert.match(zh, /两条水位线/);
  assert.match(zh, /从当前播放位置起连续已收的字节代表还能安全播放多久/);
  assert.ok(!/连续水位达到约 8 MB 后提前播放/.test(zh), '旧说法还在');
  assert.match(en, /two watermarks/);
  assert.match(en, /from the current playback position/);
  assert.ok(!/a contiguous playback watermark\./.test(en), '英文旧说法还在');
});
