'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/**
 * 按 Discord 实际使用的 simple-markdown 规则模拟「渲染之后再被复制出来」。
 *
 *   u （下划线）: /^__((?:\\[\s\S]|[^\\])+?)__(?!_)/     无边界要求，任意位置可触发
 *   em（斜体）  : /^\b_((?:__|\\[\s\S]|[^\\_])+?)_\b/    开头的 \b 因为 parser 是对「剩余串」
 *                 做 ^ 锚定匹配而恒成立，真正起约束的是闭合端：'_' 之后必须是非词字符或串尾。
 *
 * 这正是 snake_case 在 Discord 里原样显示、而 __init__ 会变成下划线 init 的原因。
 */
const U_RE = /^__((?:\\[\s\S]|[^\\])+?)__(?!_)/;
const EM_RE = /^\b_((?:__|\\[\s\S]|[^\\_])+?)_\b/;

function discordRender(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '_') {
      out += text[i];
      i += 1;
      continue;
    }
    const rest = text.slice(i);
    const u = U_RE.exec(rest);
    if (u) {
      out += discordRender(u[1]);
      i += u[0].length;
      continue;
    }
    const em = EM_RE.exec(rest);
    if (em) {
      out += discordRender(em[1]);
      i += em[0].length;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

test('Discord 模拟器本身对得上已知行为', () => {
  assert.equal(discordRender('abc_def_ghi'), 'abc_def_ghi', 'snake_case 在 Discord 里原样显示');
  assert.equal(discordRender('abc__def__ghi'), 'abcdefghi', '__init__ 会被渲染成下划线的 init');
  assert.equal(discordRender('ab_cd_-ef'), 'abcd-ef', '闭合下划线后接 - 构成词边界');
  assert.equal(discordRender('-_xy_'), '-xy', '闭合下划线落在串尾');
  assert.equal(discordRender('a_b'), 'a_b', '孤立下划线保留');
});

const hex = (n) => [...crypto.randomBytes(n)].map((b) => b.toString(16).padStart(2, '0').toUpperCase());
const rnd = (n) => crypto.randomInt(n);

/** 造一条候选数可调的真实 SDP。候选越多码越长，被 markdown 改坏的概率越高。 */
function fakeSdp(nCandidates) {
  const cands = Array.from(
    { length: nCandidates },
    (_, i) =>
      `a=candidate:${rnd(4294967295)} 1 udp 2113937151 ${rnd(256)}.${rnd(256)}.${rnd(256)}.${rnd(256)} ${
        49152 + rnd(16000)
      } typ ${i % 4 === 3 ? 'srflx' : 'host'} generation 0 ufrag ${hex(2).join('')}\r\n`
  ).join('');
  return (
    `v=0\r\no=- ${rnd(4294967295)} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n` +
    'a=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
    cands +
    `a=ice-ufrag:${hex(2).join('')}\r\na=ice-pwd:${hex(12).join('')}\r\n` +
    `a=fingerprint:sha-256 ${hex(32).join(':')}\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n`
  );
}

const offerFor = (encodeCode, n) =>
  encodeCode({
    k: 'offer',
    from: hex(6).join(''),
    name: '观众-482',
    sdp: { type: 'offer', sdp: fakeSdp(n) },
    file: ['某部电影.mkv', 8123456789, 'f'],
    securityMode: 'trusted',
  });

/**
 * 这条守的是一个真实故障：邀请码贴进 Discord 后对方用不了。
 *
 * 旧的 base64url 字母表含 '_'，而邀请码是 gzip 后的均匀随机字节，100% 会含它。
 * 实测被改坏的比例随码长从 9%（单网卡）升到 75%（多网卡 + TURN），常见家用机约 15%。
 * 收码的人只会看到「邀请码损坏」，而他复制得一个字符都没错。
 */
impl('邀请码贴进 Discord 不会被 markdown 改掉字符', async (dir) => {
  const { encodeCode, inviteLink } = await import(dir + 'signaling.js');
  for (const n of [3, 8, 20, 40]) {
    for (let i = 0; i < 25; i++) {
      const code = await offerFor(encodeCode, n);
      const link = inviteLink(code, 'join');
      assert.equal(discordRender(code), code, `裸码被改坏（候选数 ${n}）：${code.slice(0, 60)}…`);
      assert.equal(discordRender(link), link, `链接被改坏（候选数 ${n}）`);
    }
  }
});

impl('邀请码只用字母数字加 - 和 . —— 不碰任何 markdown 敏感字符', async (dir) => {
  const { encodeCode, inviteLink } = await import(dir + 'signaling.js');
  for (let i = 0; i < 30; i++) {
    const code = await offerFor(encodeCode, 20);
    assert.match(code, /^NR3-[A-Za-z0-9.-]+$/, `码里出现了预期之外的字符：${code.slice(0, 60)}…`);
    // '_' 被 __下划线__ 占用，'~' 被 ~~删除线~~ 占用，其余几个是各家 markdown 的通用标记
    assert.doesNotMatch(code, /[_~*|`\\]/);
    assert.doesNotMatch(inviteLink(code, 'join'), /[_~*|`\\]/);
  }
});

impl('旧版本发出来的 base64url 邀请码照常能解', async (dir) => {
  const { encodeCode, decodeCode } = await import(dir + 'signaling.js');
  for (let i = 0; i < 10; i++) {
    const code = await offerFor(encodeCode, 12);
    // 把 '.' 换回 '_' 就等价于旧版本的输出：两套字母表只差第 64 个字符
    const legacy = code.replace(/\./g, '_');
    if (legacy === code) continue; // 这一条恰好没用到第 64 个字符
    const fresh = await decodeCode(code);
    const old = await decodeCode(legacy);
    assert.deepEqual(old, fresh, '新旧两种字符写法必须解出完全相同的载荷');
  }
});

/**
 * 以前这里是「整条输入必须正好是一个码」的锚定判断，于是聊天里最自然的贴法全军覆没。
 * 尤其阴险的是只在尾部多一个字符时前缀检查能过，错误落到后面变成「复制的时候可能漏了一截」
 * —— 明明是多了东西，却让人去重新要一份码。
 */
impl('聊天里的各种贴法都能认出邀请码', async (dir) => {
  const { encodeCode, decodeCode, inviteLink } = await import(dir + 'signaling.js');
  const code = await offerFor(encodeCode, 6);
  const link = inviteLink(code, 'join');
  const want = await decodeCode(code);

  const cases = [
    ['裸码', code],
    ['邀请链接', link],
    ['反引号行内代码', '`' + code + '`'],
    ['三重代码块', '```\n' + code + '\n```'],
    ['Discord 抑制预览的 <>', `<${link}>`],
    ['markdown 链接', `[点我加入](${link})`],
    ['中文引号', `“${code}”`],
    ['书名号', `《${code}》`],
    ['带说明前缀', `邀请码：${code}`],
    ['前后都有闲话', `快来看片 ${link} 我在等你`],
    ['句尾中文句号', `${code}。`],
    ['句尾英文句号', `${code}.`],
    ['邮件引用前缀', `> ${code}`],
    ['邮件 78 列折行', code.replace(/(.{78})/g, '$1\n')],
    ['首尾零宽字符', `​${code}﻿`],
    ['码中混入软连字符', code.slice(0, 40) + '­' + code.slice(40)],
    ['多行 + 引用 + 反引号', '> 房主发的：\n> `' + code + '`'],
  ];

  for (const [label, input] of cases) {
    const got = await decodeCode(input).catch((e) => {
      assert.fail(`${label} 解不开：${e.message}`);
    });
    assert.deepEqual(got, want, `${label} 解出来的内容不对`);
  }
});

impl('认不出来的输入仍然失败，且报错指对方向', async (dir) => {
  const { encodeCode, decodeCode } = await import(dir + 'signaling.js');
  const code = await offerFor(encodeCode, 6);

  await assert.rejects(() => decodeCode('你好啊'), /这不像是一个 NoxReel 邀请码/);
  await assert.rejects(() => decodeCode(''), /这不像是一个 NoxReel 邀请码/);
  // 中间被截断是真的少了一截，这时候「复制漏了」才是对的方向
  await assert.rejects(() => decodeCode(code.slice(0, code.length - 60)), /邀请码损坏或不完整/);
});

impl('解不开时的提示要提到聊天软件，别只让人重新复制', async (dir) => {
  const { encodeCode, decodeCode } = await import(dir + 'signaling.js');
  const code = await offerFor(encodeCode, 6);
  await assert.rejects(
    () => decodeCode(code.slice(0, code.length - 60)),
    (e) => {
      assert.match(e.message, /聊天软件/, '要点出聊天软件这个可能原因');
      assert.match(e.message, /反引号/, '要给出一个能自救的具体动作');
      return true;
    }
  );
});

test('两端的字母表与提取逻辑保持同源', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (dir) => fs.readFileSync(path.resolve(__dirname, dir + 'signaling.js'), 'utf8');
  const [desktop, android] = IMPLS.map((i) => read(i.dir));
  for (const marker of [
    "replace(/\\+/g, '-').replace(/\\//g, '.')", // 编码用 '.' 而不是 '_'
    "replace(/-/g, '+').replace(/[._]/g, '/')", // 解码同时认 '.' 和 '_'
    'const INVISIBLE_RE',
    'const BODY_CHARS',
  ]) {
    assert.ok(desktop.includes(marker), `桌面端缺少 ${marker}`);
    assert.ok(android.includes(marker), `安卓端缺少 ${marker}`);
  }
  // 旧字母表不能残留在任何一端，否则等于只修了一半
  for (const [name, src] of [['桌面端', desktop], ['安卓端', android]]) {
    assert.doesNotMatch(src, /\breplace\(\/\\\/\/g, '_'\)/, `${name} 还在往外发 '_'`);
  }
});
