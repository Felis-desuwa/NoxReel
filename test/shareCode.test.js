'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

async function codec() {
  return import('../src/renderer/lib/signaling.js');
}

test('SW2 信令房间码紧凑且可往返', async () => {
  const { encodeCode, decodeCode } = await codec();
  const payload = {
    k: 'room',
    url: 'wss://signal.example.com',
    room: 'AbCd1234',
    from: 'host-peer-id',
    name: '房主名字不会再塞进短码',
    file: { name: '也不再绑定某一部电影.mkv', size: 10 * 1024 ** 3 },
    maxMembers: 6,
  };
  const code = await encodeCode(payload);
  const decoded = await decodeCode(code);
  assert.match(code, /^SW2-[RG]/);
  assert.ok(code.length < 160, `房间码仍然过长：${code.length}`);
  assert.deepEqual(decoded, {
    k: 'room',
    url: payload.url,
    room: payload.room,
    from: payload.from,
    maxMembers: 6,
  });
});

test('SW2 极简邀请码保留完整 SDP，且兼容 SW1', async () => {
  const { encodeCode, decodeCode } = await codec();
  const sdp = `v=0\r\n${'a=candidate:1234567890 typ host\r\n'.repeat(500)}END`;
  const payload = { k: 'offer', from: 'host', name: '测试', sdp, maxMembers: 4 };
  const code = await encodeCode(payload);
  assert.equal((await decodeCode(code)).sdp.slice(-3), 'END');

  const legacy = `SW1-${zlib.gzipSync(JSON.stringify(payload)).toString('base64url')}`;
  assert.equal((await decodeCode(legacy)).sdp, sdp);
});
