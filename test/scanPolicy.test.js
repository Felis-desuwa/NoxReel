'use strict';

// 扫描结果的处置和扫描排队（纯函数）。
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/scanPolicy.js');

test('只有 blocked 才销毁缓存，其余一律保留文件', async () => {
  const { decideScanOutcome } = await load();
  for (const mode of ['safe', 'trusted']) {
    assert.deepEqual(decideScanOutcome({ ok: false, status: 'blocked', message: 'x' }, mode), {
      status: 'blocked',
      destroy: true,
      level: 'bad',
    });
    for (const status of ['unavailable', 'cancelled', 'timeout', 'error', undefined]) {
      assert.equal(decideScanOutcome({ ok: false, status }, mode).destroy, false, `${mode}/${status} 不能删文件`);
    }
  }
});

test('扫描通过要 ok 和 clean 同时成立', async () => {
  const { decideScanOutcome } = await load();
  assert.equal(decideScanOutcome({ ok: true, status: 'clean' }, 'safe').status, 'clean');
  // 缺了 ok 就不算通过：主进程出错时可能只带着状态回来
  assert.notEqual(decideScanOutcome({ ok: false, status: 'clean' }, 'safe').status, 'clean');
  assert.notEqual(decideScanOutcome({ status: 'clean' }, 'trusted').status, 'clean');
  assert.equal(decideScanOutcome(null, 'safe').status, 'scan-timeout');
});

test('扫描器没跑起来：可信房间记成未扫描，安全模式记成没扫完（不放行）', async () => {
  const { decideScanOutcome } = await load();
  assert.deepEqual(decideScanOutcome({ ok: false, status: 'unavailable' }, 'trusted'), {
    status: 'unscanned',
    destroy: false,
    level: 'warn',
  });
  assert.deepEqual(decideScanOutcome({ ok: false, status: 'unavailable' }, 'safe'), {
    status: 'scan-timeout',
    destroy: false,
    level: 'bad',
  });
});

test('被叫停记成已停止，超时和出错记成没扫完', async () => {
  const { decideScanOutcome } = await load();
  assert.equal(decideScanOutcome({ ok: false, status: 'cancelled' }, 'safe').status, 'scan-stopped');
  assert.equal(decideScanOutcome({ ok: false, status: 'timeout' }, 'safe').status, 'scan-timeout');
  assert.equal(decideScanOutcome({ ok: false, status: 'error' }, 'trusted').status, 'scan-timeout');
});

test('重新扫描只放行没扫完的两种，绕不过 blocked', async () => {
  const { needsScan } = await load();
  for (const status of ['clean', 'blocked', 'unscanned', 'scanning']) {
    assert.equal(needsScan(status), false, status);
    assert.equal(needsScan(status, { force: true }), false, `${status} + force`);
  }
  for (const status of ['scan-timeout', 'scan-stopped']) {
    assert.equal(needsScan(status), false, status);
    assert.equal(needsScan(status, { force: true }), true, `${status} + force`);
  }
  for (const status of ['waiting-download', 'trusted-streaming', 'idle']) {
    assert.equal(needsScan(status), true, status);
  }
});

test('排队：当前项优先，其余按列表顺序；没收完、自己是片源、扫过的都不排', async () => {
  const { pickScanTarget } = await load();
  const base = { current: false, status: 'waiting-download', complete: true, isSeeder: false };
  const list = [
    { ...base, key: 'c', order: 3 },
    { ...base, key: 'b', order: 1 },
    { ...base, key: 'cur', order: 0, current: true, complete: false },
    { ...base, key: 'seed', order: 0, isSeeder: true },
    { ...base, key: 'done', order: 0, status: 'clean' },
  ];
  assert.equal(pickScanTarget(list).key, 'b');
  list[2].complete = true;
  assert.equal(pickScanTarget(list).key, 'cur');
  // 当前项扫着的时候不会再被选中，也不会让别的片插队
  list[2].status = 'scanning';
  assert.equal(pickScanTarget(list).key, 'b');
  assert.equal(pickScanTarget([]), null);
  assert.equal(pickScanTarget(null), null);
  assert.equal(pickScanTarget([{ ...base, key: 'x', order: 0, complete: false }]), null);
});

test('抢占：只有当前项能让别的片让路', async () => {
  const { shouldPreempt } = await load();
  const running = { key: 'b', current: false };
  assert.equal(shouldPreempt(running, { key: 'cur', current: true }), true);
  assert.equal(shouldPreempt(running, { key: 'c', current: false }), false);
  assert.equal(shouldPreempt({ key: 'cur', current: true }, { key: 'cur', current: true }), false);
  assert.equal(shouldPreempt(null, { key: 'cur', current: true }), false);
  assert.equal(shouldPreempt(running, null), false);
});
