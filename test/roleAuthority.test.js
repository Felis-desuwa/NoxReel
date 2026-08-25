'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * hostId 是「谁是房主」的信任锚点。「首认为准」那条分支只该给**还不知道房主是谁**的
 * 加入者用（安卓信令模式手里没有邀请码）—— 房主自己绝不能走进去，否则任何成员把
 * hostId 填成自己发一条 ROLE，就能把房主挤下去、夺走角色权威。
 */
test('房主不接受任何人发来的角色表', async () => {
  const { SyncEngine } = await import('../src/renderer/lib/syncEngine.js');
  const host = new SyncEngine({ peerId: 'host', name: '房主', isSeeder: true, hostId: 'host' });
  assert.equal(host.myRole(), 'host');

  host.onCtrl({ t: 'role', hostId: 'evil', roles: [['evil', 'admin'], ['host', 'guest']] }, { peerId: 'evil' });

  assert.equal(host.hostId, 'host', '房主身份不能被别人的 ROLE 改写');
  assert.equal(host.myRole(), 'host');
  assert.equal(host.canIControl(), true);
  assert.equal(host.roleOf('evil'), 'guest', '冒名者不能把自己提成管理员');
});

test('已知房主的加入者只认房主发来的角色表', async () => {
  const { SyncEngine } = await import('../src/renderer/lib/syncEngine.js');
  const guest = new SyncEngine({ peerId: 'me', name: '我', isSeeder: false, hostId: 'host' });

  guest.onCtrl({ t: 'role', hostId: 'evil', roles: [['me', 'guest'], ['evil', 'admin']] }, { peerId: 'evil' });
  assert.equal(guest.hostId, 'host');
  assert.equal(guest.roleOf('evil'), 'guest');

  guest.onCtrl({ t: 'role', hostId: 'host', roles: [['me', 'admin']] }, { peerId: 'host' });
  assert.equal(guest.myRole(), 'admin', '房主的角色表要生效');
});

/** 安卓信令模式直接填房间号进来，手里没有邀请码，只能「首认为准」再钉死。 */
test('还不知道房主是谁时首认为准，之后不再改', async () => {
  const { SyncEngine } = await import('../src/renderer/lib/syncEngine.js');
  const guest = new SyncEngine({ peerId: 'me', name: '我', isSeeder: false, hostId: null });

  guest.onCtrl({ t: 'role', hostId: 'host', roles: [['me', 'guest']] }, { peerId: 'host' });
  assert.equal(guest.hostId, 'host');

  guest.onCtrl({ t: 'role', hostId: 'evil', roles: [['me', 'admin']] }, { peerId: 'evil' });
  assert.equal(guest.hostId, 'host', '房主身份钉死后不再改');
  assert.equal(guest.myRole(), 'guest');
});
