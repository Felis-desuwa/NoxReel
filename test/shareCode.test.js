'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

async function codec() {
  return import('../src/renderer/lib/signaling.js');
}

test('NR3 信令房间码紧凑且可往返', async () => {
  const { encodeCode, decodeCode } = await codec();
  const payload = {
    k: 'room',
    url: 'wss://signal.example.com',
    room: 'AbCd1234',
    from: 'host-peer-id',
    name: '房主名字不会再塞进短码',
    file: { name: '也不再绑定某一部电影.mkv', size: 10 * 1024 ** 3 },
    maxMembers: 6,
    securityMode: 'trusted',
  };
  const code = await encodeCode(payload);
  const decoded = await decodeCode(code);
  assert.match(code, /^NR3-[RG]/);
  assert.ok(code.length < 160, `房间码仍然过长：${code.length}`);
  assert.deepEqual(decoded, {
    k: 'room',
    url: payload.url,
    room: payload.room,
    from: payload.from,
    maxMembers: 6,
    securityMode: 'trusted',
  });
});

test('NR3 零服务器邀请码保留完整 SDP，且兼容 NR2 / SW2 / SW1', async () => {
  const { encodeCode, decodeCode } = await codec();
  const sdp = `v=0\r\n${'a=candidate:1234567890 typ host\r\n'.repeat(500)}END`;
  const payload = { k: 'offer', from: 'host', name: '测试', sdp, maxMembers: 4, securityMode: 'safe' };
  const code = await encodeCode(payload);
  assert.equal((await decodeCode(code)).sdp.sdp.slice(-3), 'END');

  const oldPayload = ['o', 'host', '测试', { type: 'offer', sdp }, 0, 4, 's'];
  const previous = `NR2-R${Buffer.from(JSON.stringify(oldPayload)).toString('base64url')}`;
  assert.equal((await decodeCode(previous)).sdp.sdp, sdp);

  const legacy = `SW1-${zlib.gzipSync(JSON.stringify(payload)).toString('base64url')}`;
  assert.equal((await decodeCode(legacy)).sdp, sdp);
});

test('邀请和应答可包装成可点击的 NoxReel 链接', async () => {
  const { encodeCode, decodeCode, inviteLink, unwrapInviteInput } = await codec();
  const payload = { k: 'answer', from: 'guest', sdp: { type: 'answer', sdp: 'v=0\r\na=setup:active' }, securityMode: 'trusted' };
  const code = await encodeCode(payload);
  const link = inviteLink(code, 'answer');
  assert.match(link, /^noxreel:\/\/a\/[RG]/);
  assert.equal(unwrapInviteInput(link), code);
  assert.equal((await decodeCode(link)).sdp.sdp, payload.sdp.sdp);
});

test('旧邀请码缺少模式字段时只能按安全模式处理', async () => {
  const { decodeCode } = await codec();
  const oldRoom = ['r', 'wss://signal.example.com', 'room-id', 'host-peer', 4];
  const code = `SW2-R${Buffer.from(JSON.stringify(oldRoom)).toString('base64url')}`;
  assert.equal((await decodeCode(code)).securityMode, 'safe');

  const legacy = { k: 'answer', from: 'guest-peer', name: '观众', sdp: { type: 'answer', sdp: 'v=0' } };
  const legacyCode = `SW1-${zlib.gzipSync(JSON.stringify(legacy)).toString('base64url')}`;
  assert.equal((await decodeCode(legacyCode)).securityMode, 'safe');
});

test('Android 观众端与桌面端使用相同的房间模式编码', async () => {
  const desktop = await codec();
  const android = await import('../android/app/src/main/assets/js/signaling.js');
  const payload = {
    k: 'offer', from: 'host-peer', name: '房主', sdp: { type: 'offer', sdp: 'v=0' }, securityMode: 'trusted',
  };
  assert.equal((await android.decodeCode(await desktop.encodeCode(payload))).securityMode, 'trusted');
  assert.equal((await desktop.decodeCode(await android.encodeCode(payload))).securityMode, 'trusted');
});
