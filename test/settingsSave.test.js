'use strict';

// 设置弹窗（修复批次 11）：
//  - 保存语义统一：字段一律点「保存」才生效；只有本身就是动作的按钮当场生效，旁边标「立即生效」，
//    点「取消」时说清楚哪些已经生效、撤不回。缓存清理方式从「一改就生效」改成随「保存」生效。
//  - 保存失败时报错写在出错那一栏底下，滚过去并聚焦出错的输入框；藏起来的那组 TURN 字段不校验、不提交。
//  - 中继地址逐条用 URL 解析；打开「隐藏我的 IP」却还没有中继时先提醒一次。
//  - 「删除所选」和 Cloudflare 的「清除」要点两次；TURN 密码框遮住；Discord 子选项跟着总开关。
//  - Windows 上整个没有 Defender 也算缺件，提示文案给出走得通的下一步。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

/** 设置弹窗的点击处理器（$('btn-settings').onclick = …）整段源码。 */
function settingsHandler() {
  const start = APP.indexOf("$('btn-settings').onclick = () => {");
  assert.ok(start >= 0, '没找到设置弹窗的处理器');
  return APP.slice(start, APP.indexOf('\n};\n', start) + 3);
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

/* ------------------------------ 假 DOM ------------------------------ */

/** 够设置页用的假元素：value / checked、classList、滚动和聚焦的次数、子节点和属性。 */
function fakeEl(tag, opts = {}, children = []) {
  const classes = new Set(String(opts.className || '').split(/\s+/).filter(Boolean));
  const attrs = { ...(opts.attrs || {}) };
  const el = {
    tag,
    id: opts.id || '',
    value: '',
    checked: false,
    disabled: false,
    textContent: opts.text ?? '',
    scrolled: 0,
    focused: 0,
    style: {},
    children: children.flat(Infinity).filter((c) => c != null && c !== false),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    get className() {
      return [...classes].join(' ');
    },
    getAttribute: (name) => attrs[name],
    scrollIntoView() {
      this.scrolled++;
    },
    focus() {
      this.focused++;
    },
    querySelector(sel) {
      return walk(this).find((n) => matches(n, sel)) || null;
    },
    querySelectorAll(sel) {
      return walk(this).filter((n) => matches(n, sel));
    },
  };
  if (attrs.type) el.type = attrs.type;
  if (opts.props) Object.assign(el, opts.props);
  return el;
}

function walk(node) {
  const out = [];
  for (const child of node.children || []) {
    if (!child || typeof child !== 'object') continue;
    out.push(child, ...walk(child));
  }
  return out;
}

function matches(node, sel) {
  if (sel === 'input') return node.tag === 'input';
  if (sel === 'input[type="checkbox"]') return node.tag === 'input' && node.type === 'checkbox';
  throw new Error(`假 DOM 不认这个选择器：${sel}`);
}

function findId(nodes, id) {
  for (const node of [nodes].flat(Infinity)) {
    if (!node || typeof node !== 'object') continue;
    if (node.id === id) return node;
    const hit = walk(node).find((n) => n.id === id);
    if (hit) return hit;
  }
  return null;
}

/* ------------------------- 设置弹窗的「保存」 ------------------------- */

/**
 * 把设置弹窗的处理器放进沙箱跑：点齿轮 → 拿到 openModal 的参数，直接调 onOk / onCancel（不画界面）。
 * form 里写的是这一次用户在表单上改成的样子：字符串是 value，布尔是 checked。
 */
async function settingsBox({ settings = {}, form = {}, cfTurnState = null, cfTurnUsage = null, setMode = null } = {}) {
  const ice = await load('src/renderer/lib/ice.js');
  const S = {
    settings: {
      language: 'zh-CN',
      securityMode: 'trusted',
      signalUrl: 'ws://localhost:8080',
      relays: '',
      stun: 'stun:stun.l.google.com:19302',
      turnUrl: '',
      turnUser: '',
      turnPass: '',
      turnEnabled: true,
      turnSource: 'manual',
      relayOnly: false,
      downloadWhileWatching: false,
      ...settings,
    },
    name: '我',
    role: null,
    discord: { enabled: false, show: 'none', showJoin: true },
    cfTurn: null,
    cfTurnState,
    cfTurnUsage,
    cachePolicy: { mode: 'auto', keptDir: 'K' },
  };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, fakeEl('input', { id, className: id.endsWith('-err') ? 'field-error settings-err hidden' : '' }));
    return els.get(id);
  };
  const values = {
    'set-turn-url': S.settings.turnUrl,
    'set-turn-user': S.settings.turnUser,
    'set-turn-pass': S.settings.turnPass,
    'set-cf-key': '',
    'set-cf-token': '',
    'set-cf-limit': String(cfTurnUsage?.limitGB || 900),
    'set-relays': S.settings.relays,
    'set-language': 'zh-CN',
    'set-name': '我',
    'set-security-mode': 'trusted',
    'set-signal': S.settings.signalUrl,
    'set-capacity': '4',
    'set-stun': S.settings.stun,
    'set-cache-mode': 'auto',
    'set-discord-show': 'none',
  };
  const checks = {
    'set-turn-source-cf': S.settings.turnSource === 'cloudflare',
    'set-turn-on': S.settings.turnEnabled,
    'set-relay-only': S.settings.relayOnly,
    'set-download': false,
    'set-discord-on': false,
    'set-discord-join': true,
  };
  for (const [id, value] of Object.entries(values)) $(id).value = value;
  for (const [id, value] of Object.entries(checks)) $(id).checked = value;
  for (const [id, value] of Object.entries(form)) {
    if (typeof value === 'boolean') $(id).checked = value;
    else $(id).value = value;
  }
  for (const id of ['set-turn-err', 'set-cf-err', 'set-relays-err', 'set-relay-only-err', 'set-cache-mode-err']) $(id);

  const calls = { modals: [], setLimit: [], setMode: [], retried: 0, ensure: 0, logs: [] };
  const storage = new Map();
  const ctx = {
    console,
    Promise,
    Number,
    Date,
    Set,
    URL,
    S,
    $,
    t: (s) => s,
    roomEntered: false,
    document: {
      querySelectorAll: (sel) => {
        assert.equal(sel, '#modal-body .settings-err');
        return [...els.values()].filter((el) => el.classList.contains('settings-err'));
      },
    },
    normalizeTurnInput: ice.normalizeTurnInput,
    relayServer: ice.relayServer,
    setLocale: (lang) => lang,
    applyMyName: (name) => {
      S.name = name;
    },
    securityModeLocked: () => false,
    normalizeSecurityMode: (mode) => (mode === 'trusted' ? 'trusted' : 'safe'),
    saveCapacitySetting: () => {},
    wantDownload: () => {},
    savePresenceSettings: () => {},
    updatePresence: () => {},
    localStorage: { setItem: (k, v) => storage.set(k, String(v)) },
    scheduleCfTurnRefresh: () => {},
    ensureTurnReady: async () => {
      calls.ensure++;
    },
    cfTurnRetryAt: 0,
    applyCfUsage: () => {},
    log: (text, tone) => calls.logs.push([text, tone]),
    updateDepsPill: () => {},
    retryBlockedInvite: () => {
      calls.retried++;
    },
    openModal: (options) => {
      calls.modals.push(options);
      return { done: Promise.resolve(true), cancel() {} };
    },
    make: fakeEl,
    window: {
      sw: {
        turn: {
          cfSetLimit: async (limit) => {
            calls.setLimit.push(limit);
            return {};
          },
        },
        cache: {
          setMode:
            setMode ||
            (async (mode) => {
              calls.setMode.push(mode);
              return { mode, keptDir: 'K' };
            }),
        },
      },
    },
    location: { reload() {} },
    setTimeout: () => 0,
    settingsApplied: null,
    relayOnlyWarned: false,
  };
  vm.createContext(ctx);
  const helpers = ['clearSettingsErrors', 'settingsFail', 'isRelayUrl', 'relayReadyFor', 'noteSettingsApplied', 'noticeSettingsApplied'];
  vm.runInContext([...helpers.map(fnSource), settingsHandler()].join('\n\n'), ctx, { filename: 'app.js（设置）' });
  ctx.$('btn-settings').onclick();
  const options = calls.modals[0];
  // 打开设置时 body() 会把这两样重置；这里不画界面，照做一遍
  ctx.settingsApplied = new Set();
  ctx.relayOnlyWarned = false;
  const visibleErrors = () => [...els.values()].filter((el) => el.classList.contains('settings-err') && !el.classList.contains('hidden'));
  return { ctx, S, $, calls, storage, options, save: () => options.onOk(), visibleErrors };
}

test('来源是「自己填」：藏着的 Cloudflare 那组填了东西、月上限写坏了都不拦，也不提交月上限', async () => {
  const r = await settingsBox({ form: { 'set-cf-key': 'abcdefgh1234', 'set-cf-limit': '0', 'set-name': '新名字' } });
  assert.equal(await r.save(), true);
  assert.deepEqual(r.visibleErrors(), []);
  assert.deepEqual(r.calls.setLimit, [], '藏着的月上限不该提交');
  assert.equal(r.storage.get('sw.name'), '新名字', '别的设置照常存下');
});

test('来源是 Cloudflare：凭据填了没保存、月上限写坏，报错写在 Cloudflare 那组底下，滚过去并聚焦出错的框', async () => {
  const cf = { settings: { turnSource: 'cloudflare' }, cfTurnUsage: { usedBytes: 0, limitGB: 900 } };
  let r = await settingsBox({ ...cf, form: { 'set-cf-token': 'x'.repeat(20) } });
  assert.equal(await r.save(), false);
  const box = r.$('set-cf-err');
  assert.equal(box.textContent, 'Cloudflare 凭据还没保存：先点「验证并保存」，或者把这两个框清空。');
  assert.deepEqual(r.visibleErrors(), [box]);
  assert.equal(box.scrolled, 1, '报错框要滚进可视区');
  assert.equal(r.$('set-cf-token').focused, 1, '光标放进出错的那个框');
  assert.equal(r.storage.size, 0, '拦下时什么都不存');

  r = await settingsBox({ ...cf, form: { 'set-cf-limit': '0' } });
  assert.equal(await r.save(), false);
  assert.equal(r.$('set-cf-err').textContent, 'Cloudflare TURN 每月上限要填 1 到 1000 之间的整数（GB）。');
  assert.equal(r.$('set-cf-limit').focused, 1);

  // 改成合法的上限：照常提交
  r = await settingsBox({ ...cf, form: { 'set-cf-limit': '500' } });
  assert.equal(await r.save(), true);
  assert.deepEqual(r.calls.setLimit, [500]);
});

test('手填 TURN 写错：报错写在手填那一组底下，聚焦地址框 / 缺的那个凭据框；再点保存时上一次的报错先收起', async () => {
  let r = await settingsBox({ form: { 'set-turn-url': 'https://turn.example.org' } });
  assert.equal(await r.save(), false);
  assert.match(r.$('set-turn-err').textContent, /^这些 TURN 地址认不出来/);
  assert.equal(r.$('set-turn-url').focused, 1);
  assert.equal(r.$('set-turn-err').scrolled, 1);

  r = await settingsBox({ form: { 'set-turn-url': 'turn:turn.example.org:3478', 'set-turn-user': 'u' } });
  assert.equal(await r.save(), false);
  assert.match(r.$('set-turn-err').textContent, /要填用户名和密码/);
  assert.equal(r.$('set-turn-pass').focused, 1, '缺的是密码，就聚焦密码框');

  // 改好了再点：报错框收起来
  r.$('set-turn-pass').value = 'p';
  assert.equal(await r.save(), true);
  assert.deepEqual(r.visibleErrors(), []);
});

test('中继地址：逐条用 URL 解析，逗号隔开的也认（存成一行一个）；认不出的报在中继那一栏底下', async () => {
  let r = await settingsBox({ form: { 'set-relays': 'wss://relay.a.com, wss://b.example.org,wss://c.example.net:4443/path' } });
  assert.equal(await r.save(), true);
  assert.equal(r.S.settings.relays, 'wss://relay.a.com\nwss://b.example.org\nwss://c.example.net:4443/path');
  assert.equal(r.storage.get('sw.relays'), r.S.settings.relays);

  for (const bad of ['ws://relay.a.com', 'foo', 'wss://bad_host!', 'wss://user:pw@relay.a.com', 'https://relay.a.com']) {
    r = await settingsBox({ form: { 'set-relays': `wss://ok.example.org\n${bad}` } });
    assert.equal(await r.save(), false, bad);
    assert.equal(r.$('set-relays-err').textContent, `这些中继地址认不出来：${bad}。地址要形如 wss://relay.example.com`);
    assert.equal(r.$('set-relays').focused, 1);
    assert.equal(r.$('set-relays-err').scrolled, 1);
  }
  r = await settingsBox();
  for (const good of ['wss://relay.damus.io', 'wss://[2001:db8::1]:443', 'wss://127.0.0.1:7777', 'wss://xn--fiqs8s.example']) {
    assert.equal(r.ctx.isRelayUrl(good), true, good);
  }
});

test('打开「隐藏我的 IP」却还没有能用的中继：第一次点保存先提醒并停下，再点一次照存', async () => {
  const r = await settingsBox({ form: { 'set-relay-only': true } });
  assert.equal(await r.save(), false);
  const box = r.$('set-relay-only-err');
  assert.match(box.textContent, /^现在还没有能用的 TURN 中继：「隐藏我的 IP」打开之后，新建的连接会一律被拦下/);
  assert.equal(r.$('set-relay-only').focused, 1);
  assert.equal(r.storage.has('sw.relayOnly'), false);
  assert.equal(await r.save(), true, '再点一次就照存');
  assert.equal(r.storage.get('sw.relayOnly'), '1');
  assert.equal(r.calls.retried, 1, '存完顺手重试被拦下的邀请卡');

  // 手填了完整的中继：不提醒
  const manual = await settingsBox({
    form: { 'set-relay-only': true, 'set-turn-url': 'turn:turn.example.org:3478', 'set-turn-user': 'u', 'set-turn-pass': 'p' },
  });
  assert.equal(await manual.save(), true);

  // Cloudflare 凭据存好了：临时账号建连前现取，当作之后能取到
  const cf = await settingsBox({
    settings: { turnSource: 'cloudflare' },
    form: { 'set-relay-only': true },
    cfTurnState: { configured: true },
    cfTurnUsage: { usedBytes: 0, limitGB: 900 },
  });
  assert.equal(await cf.save(), true);

  // 本月用量到了上限、这次也没调高：没有中继，照样提醒；调高到用量以上就不提醒
  const quota = { settings: { turnSource: 'cloudflare' }, cfTurnState: { configured: true }, cfTurnUsage: { usedBytes: 50e9, limitGB: 50, exceeded: true } };
  const over = await settingsBox({ ...quota, form: { 'set-relay-only': true } });
  assert.equal(await over.save(), false);
  const raised = await settingsBox({ ...quota, form: { 'set-relay-only': true, 'set-cf-limit': '100' } });
  assert.equal(await raised.save(), true);

  // 早就开着、这次没动 TURN（只改个昵称）：不再每次都拦
  const old = await settingsBox({ settings: { relayOnly: true }, form: { 'set-name': '改个名' } });
  assert.equal(await old.save(), true);
});

test('缓存清理方式随「保存」生效：改了才调主进程；主进程改不成就停在弹窗里，报错写在下拉框底下，别的设置也不存', async () => {
  let r = await settingsBox();
  assert.equal(await r.save(), true);
  assert.deepEqual(r.calls.setMode, [], '没改就不调');

  r = await settingsBox({ form: { 'set-cache-mode': 'manual' } });
  assert.equal(await r.save(), true);
  assert.deepEqual(r.calls.setMode, ['manual']);
  assert.equal(r.S.cachePolicy.mode, 'manual');

  r = await settingsBox({
    form: { 'set-cache-mode': 'manual', 'set-name': '新名字' },
    setMode: async () => {
      throw new Error('磁盘不在');
    },
  });
  assert.equal(await r.save(), false);
  assert.equal(r.$('set-cache-mode-err').textContent, '改不了：磁盘不在');
  assert.equal(r.$('set-cache-mode').focused, 1);
  assert.equal(r.storage.has('sw.name'), false, '缓存方式没改成，别的设置也先不存');
  assert.equal(r.S.cachePolicy.mode, 'auto');

  // 下拉框本身不再「一改就生效」
  assert.doesNotMatch(fnSource('cachePolicyFields'), /setMode/);
});

test('点「取消」：这次有动作已经当场生效就列出来（撤不回）；没有就什么都不弹', async () => {
  let r = await settingsBox();
  r.options.onCancel();
  assert.equal(r.calls.modals.length, 1, '什么都没当场生效，不该再弹');

  r = await settingsBox();
  r.ctx.noteSettingsApplied('换了缓存位置');
  r.ctx.noteSettingsApplied('保存了 Cloudflare 凭据');
  r.ctx.noteSettingsApplied('换了缓存位置');
  r.options.onCancel();
  assert.equal(r.calls.modals.length, 2);
  const notice = r.calls.modals[1];
  assert.equal(notice.title, '这些改动已经生效');
  assert.equal(notice.okText, '知道了');
  const body = notice.body();
  const items = walk({ children: body }).filter((n) => n.tag === 'li').map((n) => n.textContent);
  assert.deepEqual(items, ['换了缓存位置', '保存了 Cloudflare 凭据']);
  assert.equal(r.ctx.settingsApplied, null, '关掉之后就不再记');

  // 点「保存」关掉的：不弹
  r = await settingsBox();
  r.ctx.noteSettingsApplied('换了下载位置');
  assert.equal(await r.save(), true);
  assert.equal(r.calls.modals.length, 1);
  assert.equal(r.ctx.settingsApplied, null);
});

test('动作按钮都标着「立即生效」；Cloudflare 的「清除」是危险样式，和「验证并保存」拉开', () => {
  assert.match(fnSource('cacheField'), /\[pathLine, changeButton, purgeButton, instantTag\(\)\]/);
  assert.match(fnSource('downloadFields'), /\[dirPath, dirButton, instantTag\(\)\]/);
  assert.match(fnSource('cachePolicyFields'), /\[summary, deleteButton, instantTag\(\)\]/);
  const turn = fnSource('turnSettingsFields');
  assert.match(turn, /make\('div', \{ className: 'cf-actions' \}, \[cfSave, instantTag\(\), cfClear\]\)/);
  assert.match(turn, /id: 'set-cf-clear', className: 'ghost action danger'/);
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  assert.match(css, /\.cf-actions #set-cf-clear \{\s*margin-left: auto;/);
  assert.match(css, /\.instant-tag \{/);
  // 顶上那句把规则说清楚
  assert.match(settingsHandler(), /改动点底部「保存」才生效；标着「立即生效」的按钮除外，点了当场生效，「取消」也撤不回。/);
});

test('手填 TURN 的密码框遮住（type=password），「显示」能切换', () => {
  const made = [];
  const ctx = {
    S: { settings: { turnSource: 'manual', turnEnabled: true, turnUrl: '', turnUser: 'u', turnPass: 'secret', relayOnly: false } },
    make: (tag, opts, children) => {
      const el = fakeEl(tag, opts, children);
      made.push(el);
      return el;
    },
    field: (label, ...children) => fakeEl('div', { className: 'field' }, [fakeEl('label', { text: label }), ...children]),
    hint: (...children) => fakeEl('p', { className: 'hint' }, children),
    $: () => null,
    t: (s) => s,
    cfTurnStatusText: () => '',
    cfUsageText: () => '',
    instantTag: () => fakeEl('span'),
    settingsErrorBox: (id) => fakeEl('div', { id }),
    saveCfTurnCredentials: () => {},
    clearCfTurnCredentials: () => {},
    clearSettingsErrors: () => {},
    relayOnlyWarned: false,
    String,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('turnSettingsFields'), ctx);
  const nodes = ctx.turnSettingsFields();
  const pass = findId(nodes, 'set-turn-pass');
  assert.equal(pass.type, 'password');
  assert.equal(pass.value, 'secret', '照样预填，只是遮住');
  const toggle = made.find((el) => el.tag === 'button' && el.textContent === '显示');
  toggle.onclick();
  assert.equal(pass.type, 'text');
  assert.equal(toggle.textContent, '隐藏');
  toggle.onclick();
  assert.equal(pass.type, 'password');
});

test('Discord：总开关关着时两个子选项置灰，打开总开关就能勾', () => {
  const ctx = {
    S: { settings: { language: 'zh-CN', securityMode: 'trusted', signalUrl: '', relays: '', stun: '' }, discord: { enabled: false, show: 'title', showJoin: true }, role: null, env: {} },
    roomEntered: false,
    make: fakeEl,
    field: (label, ...children) => fakeEl('div', { className: 'field' }, [fakeEl('label', { text: label }), ...children]),
    hint: (...children) => fakeEl('p', { className: 'hint' }, children),
    $: (id) => (id === 'btn-settings' ? ctx.button : null),
    button: {},
    t: (s) => s,
    openModal: (options) => {
      ctx.options = options;
    },
    securityModeLocked: () => false,
    refreshCfTurnState: () => {},
    discordStatusText: () => '',
    storedCapacity: () => 4,
    DEFAULT_RELAYS: ['wss://a.example', 'wss://b.example', 'wss://c.example'],
    turnSettingsFields: () => [],
    downloadFields: () => [],
    cacheField: () => null,
    cachePolicyFields: () => [],
    copyDiagnosticsButton: () => null,
    settingsErrorBox: (id) => fakeEl('div', { id }),
    settingsApplied: null,
    relayOnlyWarned: true,
  };
  vm.createContext(ctx);
  vm.runInContext(settingsHandler(), ctx);
  ctx.button.onclick();
  const body = ctx.options.body();
  assert.ok(typeof ctx.settingsApplied?.add === 'function' && ctx.settingsApplied.size === 0, '打开设置时从头记');
  assert.equal(ctx.relayOnlyWarned, false);
  const on = findId(body, 'set-discord-on');
  const title = findId(body, 'set-discord-show');
  const join = findId(body, 'set-discord-join');
  assert.equal(title.disabled, true);
  assert.equal(join.disabled, true);
  assert.equal(title.value, 'title', '偏好照样保留');
  on.checked = true;
  on.onchange();
  assert.equal(title.disabled, false);
  assert.equal(join.disabled, false);
  on.checked = false;
  on.onchange();
  assert.equal(title.disabled, true);
});

test('「删除所选」要点两次：第一次按钮换成「确认删除 N 个」，勾选一变就不算数；确认后才删，记进「已经生效」', async () => {
  const files = [
    { id: 'a', name: 'A.mkv', size: 10, kind: 'file', persistent: true },
    { id: 'b', name: 'B.mkv', size: 20, kind: 'file', persistent: false },
  ];
  const deleted = [];
  const timers = [];
  const ctx = {
    S: { cachePolicy: { mode: 'manual', keptDir: 'K' } },
    make: fakeEl,
    replace: (node, ...kids) => {
      node.children = kids.flat(Infinity).filter(Boolean);
    },
    field: (label, ...children) => fakeEl('div', { className: 'field' }, [fakeEl('label', { text: label }), ...children]),
    hint: (...children) => fakeEl('p', { className: 'hint' }, children),
    t: (s) => s,
    fmtBytes: (n) => `${n} B`,
    log: () => {},
    retryDiskFull: () => {},
    instantTag: () => fakeEl('span'),
    settingsErrorBox: (id) => fakeEl('div', { id }),
    settingsApplied: new Set(),
    refreshCacheFileList: null,
    CONFIRM_WINDOW_MS: 5000,
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
    window: {
      sw: {
        cache: {
          listFiles: async () => files.filter((f) => !deleted.flat().includes(f.id)),
          deleteFiles: async (ids) => {
            deleted.push(ids);
            return { removed: ids.length };
          },
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext([fnSource('cachePolicyFields'), fnSource('noteSettingsApplied')].join('\n\n'), ctx);
  const nodes = ctx.cachePolicyFields();
  await flush();
  const button = walk({ children: nodes }).find((n) => n.tag === 'button');
  const list = walk({ children: nodes }).find((n) => n.className === 'cache-files');
  const boxes = list.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 2);
  boxes[0].checked = true;
  boxes[0].onchange();
  assert.equal(button.disabled, false);

  await button.onclick();
  assert.deepEqual(deleted, [], '第一次点不删');
  assert.equal(button.textContent, '确认删除 1 个');
  // 勾选变了：上一次的确认作废
  boxes[1].checked = true;
  boxes[1].onchange();
  assert.equal(button.textContent, '删除所选');
  await button.onclick();
  assert.deepEqual(deleted, []);
  assert.equal(button.textContent, '确认删除 2 个');
  await button.onclick();
  assert.deepEqual(deleted.map((ids) => [...ids]), [['a', 'b']]);
  assert.deepEqual([...ctx.settingsApplied], ['删了缓存文件']);
  // 没再点：确认窗口过了按钮复原
  assert.equal(timers.at(-1).ms, 5000);
});

/* ------------------------------ 依赖胶囊 ------------------------------ */

function depsBox(env, securityMode = 'safe') {
  const pill = { textContent: '', className: '', onclick: null };
  const ctx = {
    S: { env, settings: { securityMode } },
    $: () => pill,
    normalizeSecurityMode: (mode) => (mode === 'trusted' ? 'trusted' : 'safe'),
    showDepsHelp: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext([fnSource('defenderMissing'), fnSource('defenderHelpText'), fnSource('updateDepsPill')].join('\n\n'), ctx);
  ctx.updateDepsPill();
  return { pill, ctx };
}

const ALL_TOOLS = { mpv: 'mpv.exe', ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe', ytDlp: 'yt-dlp.exe' };

test('依赖胶囊：安全模式下 Windows 上整个没有 Defender 也算缺件；装着没在跑照旧；问不出在不在跑的不报；别的平台不报', () => {
  const winGone = depsBox({ ...ALL_TOOLS, platform: 'win32', defender: null, defenderRunning: null });
  assert.equal(winGone.pill.textContent, '缺少 Defender');
  assert.match(winGone.ctx.defenderHelpText(), /^未找到。安全模式需要它才能放行收到的文件，没有它收到的文件会一律拒播/);

  const stopped = depsBox({ ...ALL_TOOLS, platform: 'win32', defender: 'C:\\MpCmdRun.exe', defenderRunning: false });
  assert.equal(stopped.pill.textContent, '缺少 Defender');
  assert.match(stopped.ctx.defenderHelpText(), /^装着但没在运行/);
  assert.match(stopped.ctx.defenderHelpText(), /可信房间要房主开、你也在设置里选可信房间，双方一致才连得上/);

  assert.equal(depsBox({ ...ALL_TOOLS, platform: 'win32', defender: 'C:\\MpCmdRun.exe', defenderRunning: null }).pill.textContent, '依赖就绪');
  assert.equal(depsBox({ ...ALL_TOOLS, platform: 'win32', defender: null, defenderRunning: null }, 'trusted').pill.textContent, '依赖就绪', '可信房间不依赖 Defender');

  const mac = depsBox({ ...ALL_TOOLS, platform: 'darwin', defender: null, defenderRunning: null });
  assert.equal(mac.pill.textContent, '依赖就绪', '别的平台不叫人去启用 Defender');
  assert.match(mac.ctx.defenderHelpText(), /^本平台没有可用的扫描器/);
  assert.doesNotMatch(mac.ctx.defenderHelpText(), /启用 Defender/);

  // 环境检查失败（S.env 是空对象）：不知道是什么平台，不瞎报
  assert.equal(depsBox({}).pill.textContent, '缺少 mpv / ffmpeg / ffprobe / yt-dlp');
});

test('缺依赖的提示给走得通的下一步：mpv 装好点「重新检测」，不用重启', () => {
  const help = fnSource('showDepsHelp');
  assert.match(help, /'未找到。装好后点下面的「重新检测」就行，不用重启本软件。'/);
  assert.doesNotMatch(help, /装好后重启本软件即可/);
  assert.match(help, /okText: '重新检测'/);
  assert.match(help, /defenderHelpText\(\)/);
});

/* ------------------------------ 英文 ------------------------------ */

test('设置弹窗和依赖提示的新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const sources = [
    fnSource('instantTag'),
    fnSource('noticeSettingsApplied'),
    fnSource('defenderHelpText'),
    fnSource('showDepsHelp'),
    fnSource('saveCfTurnCredentials'),
    fnSource('clearCfTurnCredentials'),
    fnSource('turnSettingsFields'),
    fnSource('cacheField'),
    fnSource('downloadFields'),
    settingsHandler(),
  ]
    .join('\n')
    // 模板字符串先抹掉：里面的 ${…join('、')} 会让单引号配错对；带参数的句子另外在下面逐条测
    .replace(/`[^`]*`/g, '``');
  const literals = new Set();
  for (const m of sources.matchAll(/'([^'\n]*[一-鿿][^'\n]*)'/g)) literals.add(m[1]);
  // noteSettingsApplied 的参数散在各处，也一条条过
  for (const m of APP.matchAll(/noteSettingsApplied\('([^']+)'\)/g)) literals.add(m[1]);
  assert.ok(literals.size > 40, `只找到 ${literals.size} 条中文字面量，正则可能失效了`);
  for (const zh of literals) assert.notEqual(translate(zh, 'en'), zh, `漏翻：${zh}`);

  // 动态模板
  assert.equal(translate('确认删除 3 个', 'en'), 'Confirm deleting 3');
  assert.match(translate('这些中继地址认不出来：ws://x。地址要形如 wss://relay.example.com', 'en'), /ws:\/\/x/);
  assert.notEqual(
    translate('这些中继地址认不出来：ws://x。地址要形如 wss://relay.example.com', 'en'),
    '这些中继地址认不出来：ws://x。地址要形如 wss://relay.example.com'
  );
  assert.equal(translate('改不了：磁盘不在', 'en'), 'Could not change it: 磁盘不在');
});
