'use strict';

// 弹幕聊天的渲染侧（ui/chatPanel.js）：聊天面板、30Hz 弹幕帧循环、本地弹幕设置、控制条上的开关。
// 盯的是几处容易悄悄坏掉的地方：拼音选词时的回车不能当成发送、昵称和正文在英文界面里不许被翻译、
// 「发送中」转「已送达」时不能重建整条消息、未读只在看不见的时候涨、没弹幕时帧循环要真的停下来。
//
// 仓库没有 jsdom，下面按 test/playlistPanel.test.js 的写法自带一份够用的假 DOM：节点树、
// class / data-* / 属性联动、带冒泡的事件、简单选择器，外加聊天要用的滚动量和表单控件的 value / checked。
const test = require('node:test');
const assert = require('node:assert/strict');

const I18N = '../src/renderer/lib/i18n.js';
const PANEL = '../src/renderer/ui/chatPanel.js';

/* ------------------------------ 假 DOM ------------------------------ */

/**
 * 指向其它节点的字段一律设成不可枚举：assert 失败时会顺着 parentNode / childNodes 把整棵树
 * 从每个祖先处各展开一遍，输出几十万行，diff 的内存按平方涨。藏起来以后只展开节点自己。
 */
function hideFields(obj, fields) {
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
  }
}

const MAX_DEPTH = 256;
const MAX_NODES = 20000;

function* lineage(node, via = 'parentNode') {
  let depth = 0;
  for (let current = node; current; current = current[via]) {
    if (++depth > MAX_DEPTH) throw new Error('假 DOM：祖先链超过上限，树里多半有环');
    yield current;
  }
}

class FakeEventTarget {
  constructor() {
    hideFields(this, { listeners: new Map() });
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    if (list.some((entry) => entry.listener === listener)) return;
    list.push({ listener });
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      list.filter((entry) => entry.listener !== listener)
    );
  }

  invokeListeners(event) {
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      entry.listener.call(this, event);
      if (event.immediateStopped) break;
    }
  }
}

function fire(target, type, init = {}) {
  const event = {
    type,
    target,
    currentTarget: null,
    bubbles: true,
    defaultPrevented: false,
    propagationStopped: false,
    immediateStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    stopImmediatePropagation() {
      this.propagationStopped = true;
      this.immediateStopped = true;
    },
    ...init,
  };
  const path = event.bubbles ? [...lineage(target)] : [target];
  for (const node of path) {
    event.currentTarget = node;
    node.invokeListeners(event);
    if (event.propagationStopped) break;
  }
  return event;
}

class FakeNode extends FakeEventTarget {
  static ELEMENT_NODE = 1;
  static TEXT_NODE = 3;
  static DOCUMENT_NODE = 9;

  constructor(nodeType, ownerDocument) {
    super();
    this.nodeType = nodeType;
    hideFields(this, { ownerDocument, parentNode: null, childNodes: [] });
  }

  get parentElement() {
    return this.parentNode?.nodeType === FakeNode.ELEMENT_NODE ? this.parentNode : null;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === FakeNode.ELEMENT_NODE);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren();
    const text = value == null ? '' : String(value);
    if (text) this.append(text);
  }

  append(...items) {
    const doc = this.ownerDocument || this;
    for (const item of items) {
      const node = typeof item === 'string' ? doc.createTextNode(item) : item;
      if (!(node instanceof FakeNode)) throw new TypeError(`假 DOM：append 只收节点或字符串，收到 ${String(item)}`);
      if (node.contains(this)) throw new Error('假 DOM：不能把祖先挂到自己下面');
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  insertBefore(node, ref) {
    if (ref != null && ref.parentNode !== this) throw new Error('假 DOM：insertBefore 的参照节点不在这个父节点下');
    node.remove(); // 先摘掉再算下标，和浏览器一样（挪动节点同样会丢焦点）
    const at = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref);
    node.parentNode = this;
    this.childNodes.splice(at, 0, node);
    return node;
  }

  replaceChildren(...items) {
    for (const child of this.childNodes) {
      child.dropFocus();
      child.parentNode = null;
    }
    this.childNodes = [];
    this.append(...items);
  }

  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    this.dropFocus();
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }

  /** 节点被移出文档时焦点落回 body，和浏览器一样 —— 不模拟这一点，「重绘不换人」的用例会假通过。 */
  dropFocus() {
    const doc = this.ownerDocument;
    if (doc?.focused && (doc.focused === this || this.contains(doc.focused))) doc.focused = null;
  }

  contains(other) {
    for (const node of lineage(other)) if (node === this) return true;
    return false;
  }

  descendants() {
    const out = [];
    const stack = [...this.childNodes].reverse();
    while (stack.length) {
      if (out.length >= MAX_NODES) throw new Error('假 DOM：后代节点超过上限，树里多半有环');
      const node = stack.pop();
      out.push(node);
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return out;
  }

  querySelectorAll(selector) {
    const chains = parseSelector(selector);
    return this.descendants().filter((node) => chains.some((chain) => matchesChain(node, chain)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeText extends FakeNode {
  constructor(doc, value) {
    super(FakeNode.TEXT_NODE, doc);
    this.nodeValue = String(value);
  }

  get textContent() {
    return this.nodeValue;
  }

  set textContent(value) {
    this.nodeValue = value == null ? '' : String(value);
  }
}

const dataAttr = (prop) => `data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

function makeDataset(el) {
  return new Proxy(
    {},
    {
      get: (_t, prop) => (typeof prop === 'string' && el.hasAttribute(dataAttr(prop)) ? el.getAttribute(dataAttr(prop)) : undefined),
      set: (_t, prop, value) => {
        el.setAttribute(dataAttr(prop), value);
        return true;
      },
      has: (_t, prop) => typeof prop === 'string' && el.hasAttribute(dataAttr(prop)),
      deleteProperty: (_t, prop) => {
        el.removeAttribute(dataAttr(prop));
        return true;
      },
    }
  );
}

function makeClassList(el) {
  const read = () => el.className.split(/\s+/).filter(Boolean);
  const write = (names) => {
    el.className = [...new Set(names)].join(' ');
  };
  const list = {
    add: (...names) => write([...read(), ...names]),
    remove: (...names) => write(read().filter((name) => !names.includes(name))),
    contains: (name) => read().includes(name),
    toggle: (name, force) => {
      const on = force === undefined ? !read().includes(name) : !!force;
      if (on) list.add(name);
      else list.remove(name);
      return on;
    },
    [Symbol.iterator]: () => read()[Symbol.iterator](),
  };
  return list;
}

class FakeElement extends FakeNode {
  constructor(doc, tagName) {
    super(FakeNode.ELEMENT_NODE, doc);
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.style = {};
    this.classList = makeClassList(this);
    this.dataset = makeDataset(this);
    // 表单控件和滚动量：组件直接读写这几个属性
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  matches(selector) {
    return parseSelector(selector).some((chain) => matchesChain(this, chain));
  }

  closest(selector) {
    const chains = parseSelector(selector);
    for (const el of lineage(this, 'parentElement')) {
      if (chains.some((chain) => matchesChain(el, chain))) return el;
    }
    return null;
  }

  focus() {
    this.ownerDocument.focused = this;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(FakeNode.DOCUMENT_NODE, null);
    this.title = 'NoxReel';
    hideFields(this, { focused: null, documentElement: this.createElement('html'), body: this.createElement('body') });
    this.documentElement.append(this.body);
    this.append(this.documentElement);
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(text) {
    return new FakeText(this, text);
  }

  getElementById(id) {
    return this.descendants().find((node) => node.nodeType === FakeNode.ELEMENT_NODE && node.id === id) ?? null;
  }
}

class FakeWindow extends FakeEventTarget {
  constructor() {
    super();
    const store = new Map();
    this.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    };
  }
}

// —— 选择器（标签、.a、#id、[attr]、[attr="v"]、:not(...)、逗号、后代空格）——

const SELECTOR_TOKEN = /^(?:(\*|[a-z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\(([^()]+)\))/i;
const selectorCache = new Map();

function unsupported(selector) {
  return new Error(`假 DOM 不支持的选择器：${selector}`);
}

function parseCompound(source, whole) {
  const compound = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let rest = source;
  let first = true;
  while (rest) {
    const m = SELECTOR_TOKEN.exec(rest);
    if (!m || (m[1] && !first)) throw unsupported(whole);
    if (m[1]) compound.tag = m[1] === '*' ? null : m[1].toUpperCase();
    else if (m[2]) compound.classes.push(m[2]);
    else if (m[3]) compound.ids.push(m[3]);
    else if (m[4]) compound.attrs.push([m[4].toLowerCase(), m[5]]);
    else compound.nots.push(parseCompound(m[6].trim(), whole));
    rest = rest.slice(m[0].length);
    first = false;
  }
  return compound;
}

function parseSelector(selector) {
  if (!selectorCache.has(selector)) {
    const chains = String(selector)
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) throw unsupported(selector);
        return trimmed.split(/\s+/).map((compound) => parseCompound(compound, selector));
      });
    selectorCache.set(selector, chains);
  }
  return selectorCache.get(selector);
}

function matchesCompound(node, compound) {
  if (node?.nodeType !== FakeNode.ELEMENT_NODE) return false;
  if (compound.tag && node.tagName !== compound.tag) return false;
  if (compound.ids.some((id) => node.id !== id)) return false;
  const classes = node.className.split(/\s+/);
  if (compound.classes.some((name) => !classes.includes(name))) return false;
  const attrOk = ([name, value]) => node.hasAttribute(name) && (value === undefined || node.getAttribute(name) === value);
  if (!compound.attrs.every(attrOk)) return false;
  return !compound.nots.some((inner) => matchesCompound(node, inner));
}

function matchesChain(node, chain) {
  if (!matchesCompound(node, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  if (i < 0 || !node.parentElement) return i < 0;
  for (const el of lineage(node.parentElement, 'parentElement')) {
    if (matchesCompound(el, chain[i]) && --i < 0) return true;
  }
  return false;
}

/* ------------------------------ 夹具 ------------------------------ */

function installGlobals(values) {
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: false });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

/** 消息区的视口高度，和每多一行长出来的内容高度。 */
const VIEWPORT = 100;
const ROW_H = 40;

/** 面板挂在 document.body 下的一对 div 里（body 是滚动区，foot 放输入行）。 */
async function withPanel(options, fn) {
  const { locale = 'zh-CN' } = options;
  const doc = new FakeDocument();
  const win = new FakeWindow();
  const restore = installGlobals({ document: doc, window: win, Node: FakeNode });
  let i18n = null;
  let before = null;
  try {
    i18n = await import(I18N);
    before = i18n.currentLocale();
    i18n.setLocale(locale);
    const { createChatPanel } = await import(PANEL);
    const body = doc.createElement('div');
    body.className = 'chat-body';
    const foot = doc.createElement('div');
    foot.className = 'chat-foot';
    doc.body.append(body, foot);
    // 内容高度跟着行数长，和浏览器一样在重绘之后才变 —— 组件必须在改 DOM 之前就把
    // 「人在不在底部」记下来，不然每次重绘都会算成「不在底部」，未读从此永远涨。
    body.clientHeight = VIEWPORT;
    Object.defineProperty(body, 'scrollHeight', {
      configurable: true,
      get: () => VIEWPORT + body.children.length * ROW_H,
    });

    const sent = [];
    const titles = [];
    let accept = true;
    const panel = createChatPanel({
      body,
      foot,
      onSend: (text) => {
        sent.push(text);
        return accept;
      },
      onTitle: (prefix) => titles.push(prefix),
    });

    const ctx = {
      doc,
      win,
      body,
      foot,
      panel,
      sent,
      titles,
      setAccept: (flag) => {
        accept = flag;
      },
      input: foot.querySelector('.chat-input'),
      sendBtn: foot.querySelector('.chat-send'),
      unread: foot.querySelector('.chat-unread'),
      notice: foot.querySelector('.chat-notice'),
      rows: () => body.children,
      /** 把滚动条拨到某个位置（0 就是翻到最上面）。 */
      scrollTo: (top) => {
        body.scrollTop = top;
        fire(body, 'scroll');
      },
      bottom: () => body.scrollHeight,
    };
    await fn(ctx);
  } finally {
    if (i18n) i18n.setLocale(before);
    restore();
  }
}

const hasClass = (el, name) => el.classList.contains(name);

/** 一条消息 / 一行系统事件 / 一条分隔线的视图模型。 */
const msg = (key, over = {}) => ({ key, kind: 'msg', name: '阿狸', text: `正文${key}`, self: false, ...over });
const sys = (key, text) => ({ key, kind: 'system', text });
const divider = (text) => ({ key: 'history', kind: 'divider', text });

/* ============================== 聊天面板 ============================== */

test('面板骨架：未读提示、提示行、输入行，输入框有占位符和长度上限', async () => {
  await withPanel({}, async ({ foot, input, sendBtn, unread, notice, body, panel }) => {
    assert.deepEqual(
      foot.children.map((el) => el.className.split(' ')[0]),
      ['chat-unread', 'chat-notice', 'chat-input-row']
    );
    assert.equal(input.tagName, 'TEXTAREA');
    assert.equal(input.getAttribute('placeholder'), '说点什么…');
    assert.equal(input.getAttribute('maxlength'), '400', '正文上限 200 码点，DOM 这一层放宽到 400 个 UTF-16 单元兜底');
    assert.equal(sendBtn.textContent, '发送');
    assert.ok(hasClass(unread, 'hidden'));
    assert.ok(hasClass(notice, 'hidden'));

    panel.render({ entries: [] });
    assert.equal(body.textContent, '还没有消息');
    assert.equal(body.children.length, 1);
    assert.ok(hasClass(body.children[0], 'panel-empty'));

    panel.render({ entries: [msg('a')] });
    assert.equal(body.querySelector('.panel-empty'), null, '有消息了就不能还挂着空列表文案');
  });
});

test('消息行：昵称和正文原样显示并打跳过标记，系统事件和分隔线照常翻译', async () => {
  await withPanel({ locale: 'en' }, async ({ body, panel }) => {
    panel.render({
      entries: [
        msg('a', { name: '播放', text: '暂停', self: true, state: 'sending' }),
        sys('s1', '播放 加入了房间'),
        divider('你加入前的消息'),
      ],
    });

    const row = body.querySelector('.chat-msg');
    const name = row.querySelector('.chat-name');
    const text = row.querySelector('.chat-text');
    // 昵称叫「播放」的人不能在英文界面里变成 Play，正文同理
    assert.equal(name.textContent, '播放');
    assert.equal(name.getAttribute('title'), '播放', '悬停提示也是昵称，不翻译');
    assert.equal(text.textContent, '暂停');
    assert.ok(name.hasAttribute('data-i18n-skip'), '自动翻译的 MutationObserver 靠这个标记绕开');
    assert.ok(text.hasAttribute('data-i18n-skip'));
    assert.ok(hasClass(row, 'self'));
    assert.equal(row.querySelector('.chat-state').textContent, 'Sending…');

    // 系统事件整句翻译，昵称靠词条里的正则捕获原样带过去 —— 所以这一行不能打跳过标记
    const system = body.querySelector('.chat-system');
    assert.equal(system.textContent, '播放 joined the room');
    assert.equal(system.hasAttribute('data-i18n-skip'), false);
    assert.equal(body.querySelector('.chat-divider').textContent, 'Messages from before you joined');
  });
});

test('「发送中」转「已送达」只换那一小段文字，消息元素跨重绘还是同一个', async () => {
  await withPanel({}, async ({ body, panel }) => {
    panel.render({ entries: [msg('a', { self: true, state: 'sending' }), msg('b')] });
    const row = body.querySelector('.chat-msg');
    const text = row.querySelector('.chat-text');
    assert.equal(row.querySelector('.chat-state').textContent, '发送中');

    panel.render({ entries: [msg('a', { self: true, state: 'sent' }), msg('b')] });
    assert.equal(body.querySelector('.chat-msg'), row, '同一条消息重绘后必须还是同一个元素');
    assert.equal(row.querySelector('.chat-text'), text, '正文节点也复用，选中的文字不会被吃掉');
    assert.equal(row.querySelector('.chat-state').textContent, '已送达');

    // 别人的消息没有送达状态那一格
    assert.equal(body.children[1].querySelector('.chat-state'), null);
  });
});

test('回车发送：输入法选词时的回车、Shift+回车都不算；发出去才清空输入框', async () => {
  await withPanel({}, async ({ input, sendBtn, sent, setAccept }) => {
    input.value = '你好';
    fire(input, 'keydown', { key: 'Enter', isComposing: true });
    assert.deepEqual(sent, [], '拼音选词按的回车是「确认候选」，不是发送');
    assert.equal(input.value, '你好');

    fire(input, 'keydown', { key: 'Enter', shiftKey: true });
    assert.deepEqual(sent, [], 'Shift+回车留给换行');

    const enter = fire(input, 'keydown', { key: 'Enter' });
    assert.deepEqual(sent, ['你好']);
    assert.equal(enter.defaultPrevented, true, '发送掉的回车不能再往输入框里插一个换行');
    assert.equal(input.value, '');

    // 纯空白不发
    input.value = '   \n ';
    fire(input, 'keydown', { key: 'Enter' });
    assert.deepEqual(sent, ['你好']);

    // 点按钮也能发
    input.value = '按钮';
    fire(sendBtn, 'click');
    assert.deepEqual(sent, ['你好', '按钮']);
    assert.equal(input.value, '');

    // 没被收下（超速）：字留着，别让人重打一遍
    setAccept(false);
    input.value = '太快了';
    fire(input, 'keydown', { key: 'Enter' });
    assert.deepEqual(sent, ['你好', '按钮', '太快了']);
    assert.equal(input.value, '太快了');
  });
});

test('输入框下面的提示（超速）跟着 view 出现和消失', async () => {
  await withPanel({}, async ({ panel, notice }) => {
    panel.render({ entries: [], notice: '发得太快了（3 秒后再试）' });
    assert.equal(hasClass(notice, 'hidden'), false);
    assert.equal(notice.textContent, '发得太快了（3 秒后再试）');

    panel.render({ entries: [], notice: '' });
    assert.ok(hasClass(notice, 'hidden'));
    assert.equal(notice.textContent, '', '文案换掉后不能叠在后面');
  });
});

test('在底部时新消息自动滚到底；滚上去之后新消息不抢位置，只挂「↓ N 条新消息」', async () => {
  await withPanel({}, async ({ panel, body, unread, scrollTo, bottom }) => {
    panel.render({ entries: [msg('a'), msg('b'), msg('c')] });
    assert.equal(body.scrollTop, bottom(), '人在底部就跟着往下滚');
    assert.ok(hasClass(unread, 'hidden'));

    // 往上翻去看旧消息
    scrollTo(0);
    panel.render({ entries: [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')] });
    assert.equal(body.scrollTop, 0, '人在看旧消息，不能把他拽到底下去');
    assert.equal(hasClass(unread, 'hidden'), false);
    assert.equal(unread.textContent, '↓ 2 条新消息');

    // 点一下回到底部，未读清零
    fire(unread, 'click');
    assert.equal(body.scrollTop, bottom());
    assert.ok(hasClass(unread, 'hidden'));
    assert.equal(panel.unreadCount(), 0);
  });
});

test('自己发的、系统事件和补上来的历史都不算未读', async () => {
  await withPanel({}, async ({ panel, unread, scrollTo }) => {
    const old = [msg('x1'), msg('x2'), msg('x3')];
    panel.render({ entries: old });
    scrollTo(0); // 翻上去，之后的新消息不会自动滚走

    const mine = [...old, msg('a', { self: true, state: 'sending' }), sys('s1', '阿狸 暂停 @ 1:23')];
    panel.render({ entries: mine });
    assert.equal(panel.unreadCount(), 0, '自己发的消息和系统事件不算未读');
    assert.ok(hasClass(unread, 'hidden'));

    const withHistory = [msg('h1', { quiet: true }), msg('h2', { quiet: true }), divider('你加入前的消息'), ...mine];
    panel.render({ entries: withHistory });
    assert.equal(panel.unreadCount(), 0, '入房时补上来的历史是旧消息，不能算成未读');

    panel.render({ entries: [...withHistory, msg('b')] });
    assert.equal(panel.unreadCount(), 1);
    assert.equal(unread.textContent, '↓ 1 条新消息');
  });
});

test('窗口没焦点时标题挂 (N)，回到窗口且看着最新消息就清掉', async () => {
  await withPanel({}, async ({ panel, titles, body, scrollTo, bottom }) => {
    panel.setFocused(false);
    panel.render({ entries: [msg('a'), msg('b')] });
    assert.equal(body.scrollTop, bottom(), '人在底部时照样跟着滚，回来就看得见');
    assert.deepEqual(titles, ['(2) ']);

    panel.render({ entries: [msg('a'), msg('b'), msg('c')] });
    assert.deepEqual(titles, ['(2) ', '(3) ']);

    panel.setFocused(true);
    assert.deepEqual(titles, ['(2) ', '(3) ', ''], '人回来了就把角标摘掉');
    assert.equal(panel.unreadCount(), 0);

    // 人在窗口里但翻到了上面：有未读提示，标题不挂角标
    scrollTo(0);
    panel.render({ entries: [msg('a'), msg('b'), msg('c'), msg('d')] });
    assert.equal(panel.unreadCount(), 1);
    assert.deepEqual(titles, ['(2) ', '(3) ', ''], '人正看着，标题上不该有 (N)');
  });
});

/* ============================== 弹幕帧循环 ============================== */

/** 够用的假引擎：push 进来的下一次 frame() 全吐出来，然后当它们飞走了。 */
function fakeEngine() {
  const engine = {
    width: 1920,
    height: 1080,
    pending: [],
    flying: 0,
    banner: false,
    settings: null,
    cleared: 0,
    push(m) {
      engine.pending.push(m);
    },
    frame() {
      // 真引擎每条都带着排布时算好的字号和不透明度，假的也要给，否则丢字段的 bug 测不出来
      const out = engine.pending.map((m, i) => ({ id: m.id, text: m.text, x: 10 + i, y: 20 + i, outline: !!m.self, track: i, fontSize: 45, opacity: 0.85 }));
      engine.pending = [];
      return out;
    },
    setBanner(flag) {
      engine.banner = flag;
    },
    setSettings(s) {
      engine.settings = s;
    },
    clear() {
      engine.pending = [];
      engine.cleared += 1;
    },
    get pendingCount() {
      return engine.pending.length;
    },
  };
  return engine;
}

/** 手动推进的定时器 + 可以卡住的 send。 */
function pumpRig(over = {}) {
  const engine = over.engine || fakeEngine();
  const frames = [];
  let resolveSend = null;
  let holding = false;
  const timers = [];
  const rig = {
    engine,
    frames,
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      const done = resolveSend;
      resolveSend = null;
      done?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    tick: () => {
      for (const entry of [...timers]) entry.fn();
    },
    timerCount: () => timers.length,
    interval: () => timers[0]?.ms,
  };
  const { createDanmakuPump } = over.module;
  rig.pump = createDanmakuPump({
    engine,
    send: (frame) => {
      frames.push(frame);
      if (!holding) return Promise.resolve();
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    },
    now: () => 0,
    setTimer: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      const i = timers.indexOf(entry);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return rig;
}

test('帧循环只在「弹幕开着 + 播放器在跑 + 场上有弹幕」时转，空了就擦干净覆盖层并停表', async () => {
  const module = await import(PANEL);
  const rig = pumpRig({ module });
  const { pump, frames, engine } = rig;

  assert.equal(pump.isRunning(), false);
  pump.push({ id: 'a', text: '来了' });
  assert.equal(pump.isRunning(), false, '播放器没起来就不该开表');
  assert.deepEqual(frames, []);

  pump.setActive(true);
  assert.equal(pump.isRunning(), false, '场上没弹幕也不用空转');

  pump.push({ id: 'a', text: '来了', self: true });
  assert.equal(pump.isRunning(), true);
  assert.equal(rig.interval(), Math.round(1000 / module.DANMAKU_FPS), '每秒 30 帧');
  await Promise.resolve();
  // 字号和不透明度要跟着一起交给主进程：丢了的话两个滑块等于没接线（mpv 只会用兜底值）
  assert.deepEqual(frames, [
    { w: 1920, h: 1080, items: [{ text: '来了', x: 10, y: 20, outline: true, fontSize: 45, opacity: 0.85 }] },
  ]);

  // 场上空了：先把覆盖层擦干净，再停表
  rig.tick();
  await Promise.resolve();
  assert.equal(pump.isRunning(), false);
  assert.deepEqual(frames.at(-1), { w: 1920, h: 1080, items: [] });

  // 又有人说话，表重新转起来
  pump.push({ id: 'b', text: '又来了' });
  assert.equal(pump.isRunning(), true);
  assert.equal(engine.cleared, 0);
});

test('pause / seek 在途时停发帧，解除后接着发', async () => {
  const module = await import(PANEL);
  const rig = pumpRig({ module });
  const { pump, frames, engine } = rig;
  pump.setActive(true);
  pump.setBusy(true);
  pump.push({ id: 'a', text: '一' });
  assert.equal(pump.isRunning(), true, '表要留着，不然解除后没人把它叫起来');
  rig.tick();
  assert.deepEqual(frames, [], 'settle 期间插队的覆盖层命令只会拖慢播放器');
  assert.equal(engine.pendingCount, 1, '这条弹幕得留着，解除后再出场');

  pump.setBusy(false);
  await Promise.resolve();
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].items, [{ text: '一', x: 10, y: 20, outline: false, fontSize: 45, opacity: 0.85 }]);
});

test('同一时间只有一帧在途，多余的丢掉；但「清空」不能丢', async () => {
  const module = await import(PANEL);
  const rig = pumpRig({ module });
  const { pump, frames } = rig;
  pump.setActive(true);
  rig.hold();
  pump.push({ id: 'a', text: '一' });
  assert.equal(frames.length, 1);

  pump.push({ id: 'b', text: '二' });
  rig.tick();
  pump.push({ id: 'c', text: '三' });
  rig.tick();
  assert.equal(frames.length, 1, '上一帧还没落地，后面的宁可丢也不排队');
  assert.equal(pump.stats().dropped, 2);

  // 这时候要清空：不能跟着丢，否则覆盖层上永远留着最后一帧
  pump.clear();
  assert.equal(frames.length, 1);
  await rig.release();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], { w: 1920, h: 1080, items: [] });
});

test('关掉弹幕、播放器退出、换片都会清空引擎并擦掉覆盖层', async () => {
  const module = await import(PANEL);
  for (const stop of [(p) => p.setEnabled(false), (p) => p.setActive(false), (p) => p.clear()]) {
    const rig = pumpRig({ module });
    const { pump, frames, engine } = rig;
    pump.setActive(true);
    pump.push({ id: 'a', text: '一' });
    await Promise.resolve();
    assert.equal(frames.length, 1);

    pump.push({ id: 'b', text: '二' });
    stop(pump);
    await Promise.resolve();
    assert.equal(pump.isRunning(), false);
    assert.equal(engine.cleared, 1, '排队里的弹幕也要扔掉，别等下一部再飞出来');
    assert.deepEqual(frames.at(-1), { w: 1920, h: 1080, items: [] });
  }
});

test('横幅和本地设置原样交给排布引擎', async () => {
  const module = await import(PANEL);
  const rig = pumpRig({ module });
  rig.pump.setBanner(true);
  assert.equal(rig.engine.banner, true);
  rig.pump.setSettings({ speed: 2 });
  assert.deepEqual(rig.engine.settings, { speed: 2 });
});

/* ============================== 本地弹幕设置 ============================== */

function fakeStorage(initial) {
  const store = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    store,
  };
}

test('弹幕设置存 localStorage；坏值、坏 JSON 一律回落到默认，绝不抛', async () => {
  const { DANMAKU_KEY, loadDanmakuSettings, saveDanmakuSettings } = await import(PANEL);
  const { DEFAULT_SETTINGS } = await import('../src/renderer/lib/danmaku.js');

  assert.deepEqual(loadDanmakuSettings(fakeStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(loadDanmakuSettings(fakeStorage({ [DANMAKU_KEY]: '{坏了' })), DEFAULT_SETTINGS);
  assert.deepEqual(loadDanmakuSettings(fakeStorage({ [DANMAKU_KEY]: '[1,2]' })), DEFAULT_SETTINGS);
  assert.deepEqual(loadDanmakuSettings(null), DEFAULT_SETTINGS, '隐私模式下 localStorage 可能根本没有');

  const wild = fakeStorage({
    [DANMAKU_KEY]: JSON.stringify({ enabled: false, opacity: 9, fontScale: -3, speed: 'x', area: '整屏' }),
  });
  assert.deepEqual(loadDanmakuSettings(wild), {
    enabled: false,
    opacity: 1,
    fontScale: 0.5,
    speed: DEFAULT_SETTINGS.speed,
    area: 'half',
  });

  const out = fakeStorage();
  saveDanmakuSettings({ enabled: false, opacity: 0.5, fontScale: 1.2, speed: 2, area: 'full' }, out);
  assert.deepEqual(JSON.parse(out.getItem(DANMAKU_KEY)), {
    enabled: false,
    opacity: 0.5,
    fontScale: 1.2,
    speed: 2,
    area: 'full',
  });
  assert.deepEqual(loadDanmakuSettings(out), { enabled: false, opacity: 0.5, fontScale: 1.2, speed: 2, area: 'full' });

  // 写不进去（隐私模式）也不能把界面搞崩
  assert.doesNotThrow(() =>
    saveDanmakuSettings(DEFAULT_SETTINGS, {
      getItem: () => null,
      setItem: () => {
        throw new Error('拒绝写入');
      },
    })
  );
});

/* ============================== 控制条上的弹幕开关 ============================== */

async function withControls(options, fn) {
  const { locale = 'zh-CN', settings } = options;
  const doc = new FakeDocument();
  const win = new FakeWindow();
  const restore = installGlobals({ document: doc, window: win, Node: FakeNode });
  let i18n = null;
  let before = null;
  try {
    i18n = await import(I18N);
    before = i18n.currentLocale();
    i18n.setLocale(locale);
    const { createDanmakuControls } = await import(PANEL);
    const slot = doc.createElement('div');
    slot.className = 'controls-slot';
    doc.body.append(slot);
    const changes = [];
    const controls = createDanmakuControls({ slot, settings, onChange: (next) => changes.push(next) });
    await fn({
      doc,
      slot,
      controls,
      changes,
      toggle: slot.querySelector('.dm-check'),
      gear: slot.querySelector('.dm-gear'),
      panel: slot.querySelector('.dm-panel'),
      area: slot.querySelector('.dm-area'),
      range: (label) => slot.querySelectorAll('.dm-range').find((el) => el.getAttribute('aria-label') === label),
    });
  } finally {
    if (i18n) i18n.setLocale(before);
    restore();
  }
}

test('控制条上的弹幕开关：⚙ 开合设置面板，改任意一项都带出完整设置', async () => {
  const { DEFAULT_SETTINGS } = await import('../src/renderer/lib/danmaku.js');
  await withControls({ settings: DEFAULT_SETTINGS }, async ({ slot, controls, changes, toggle, gear, panel, area, range }) => {
    assert.equal(toggle.checked, true);
    assert.equal(slot.querySelectorAll('.dm-range').length, 3);
    assert.equal(range('不透明度').value, String(DEFAULT_SETTINGS.opacity));
    assert.equal(range('速度').value, String(DEFAULT_SETTINGS.speed));
    assert.equal(area.value, 'half');

    // ⚙ 开合
    assert.ok(hasClass(panel, 'hidden'));
    fire(gear, 'click');
    assert.equal(controls.isOpen(), true);
    assert.equal(gear.getAttribute('aria-expanded'), 'true');
    fire(gear, 'click');
    assert.equal(controls.isOpen(), false);

    range('不透明度').value = '0.4';
    fire(range('不透明度'), 'input');
    assert.deepEqual(changes.at(-1), { ...DEFAULT_SETTINGS, opacity: 0.4 });

    area.value = 'full';
    fire(area, 'change');
    assert.deepEqual(changes.at(-1), { ...DEFAULT_SETTINGS, opacity: 0.4, area: 'full' });

    toggle.checked = false;
    fire(toggle, 'change');
    assert.deepEqual(changes.at(-1), { ...DEFAULT_SETTINGS, opacity: 0.4, area: 'full', enabled: false });
    assert.ok(hasClass(slot, 'dm-off'), '关掉之后控制条上要看得出来');

    // 滑块拖过头也不能把非法值传出去
    range('速度').value = '99';
    fire(range('速度'), 'input');
    assert.equal(changes.at(-1).speed, 4);
  });
});

test('英文界面下弹幕设置的每一项都有英文', async () => {
  const { DEFAULT_SETTINGS } = await import('../src/renderer/lib/danmaku.js');
  await withControls({ locale: 'en', settings: DEFAULT_SETTINGS }, async ({ slot, gear, area }) => {
    assert.equal(slot.querySelector('.dm-toggle').textContent, 'Danmaku');
    assert.equal(gear.getAttribute('title'), 'Danmaku settings');
    assert.deepEqual(
      slot.querySelectorAll('.dm-label').map((el) => el.textContent),
      ['Opacity', 'Font size', 'Speed', 'Display area']
    );
    assert.deepEqual(
      area.children.map((el) => el.textContent),
      ['Top half', 'Full screen']
    );
  });
});

/* ============================== app.js 的接线 ============================== */

// 这一段靠源码锚点看住 app.js 里的接线：真跑一遍 app.js 要先造出整个 window.sw、
// swarm 和同步引擎，代价远超收益；而这些接线一旦被顺手删掉，界面上是「聊天不动了」
// 这种没有报错的坏法，锚点至少能在改坏的那一刻喊一声。
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');

/** 取出 app.js 里某个函数的函数体（到下一个顶层函数为止）。 */
function fnOf(name) {
  const at = app.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `app.js 里找不到 ${name}()`);
  const next = app.indexOf('\nfunction ', at + 1);
  return app.slice(at, next < 0 ? app.length : next);
}

test('app.js：聊天消息和聊天历史各自接进房间控制通道', () => {
  const dispatch = fnOf('onRoomCtrl');
  assert.match(dispatch, /case MSG\.CHAT:\s*\r?\n\s*onChatMessage\(msg, peer\);/);
  assert.match(dispatch, /case MSG\.CHAT_HISTORY:\s*\r?\n\s*onChatHistory\(msg, peer\);/);
});

test('app.js：自己发的先记 id 再广播，房主本人直接算已送达', () => {
  const send = fnOf('sendChat');
  // 限速提示走 t() 再进 OSD（OSD 不进 DOM，自动翻译碰不到它）
  assert.match(send, /发得太快了（\$\{res\.retryAfterSec\} 秒后再试）/);
  assert.match(send, /if \(fromPlayer\) window\.sw\.player\.osd\(t\(tooFast\), \d+\);/);
  assert.match(send, /return false;/);
  // 先记 id：房主把它转回来时认得出是回声。两个下标都得先确认真的在，
  // 不然整行被删掉时 indexOf 给的 -1 会让「谁在前」这个断言自动成立
  const remembered = send.indexOf('S.chat.gate.remember(id)');
  const broadcast = send.indexOf('for (const p of chatPeers())');
  assert.ok(remembered >= 0, '自己发的 id 没记进去重表，房主转回来的那一份会显示两遍');
  assert.ok(broadcast >= 0, '没找到广播那一步，下面的先后断言会形同虚设');
  assert.ok(remembered < broadcast, '自己的 id 必须在广播之前记下');
  assert.match(send, /state: host \? 'sent' : 'sending'/);
  assert.match(send, /showDanmaku\(\{ id, text, self: true \}\)/);
  assert.match(send, /if \(host\) S\.chat\.history\.add\(/);

  const recv = fnOf('onChatMessage');
  assert.match(recv, /hostId: S\.hostId/, '只有房主转发来的才采信 origin');
  assert.match(recv, /selfId: S\.peerId/);
  assert.match(recv, /if \(res\.reason === 'echo'\) markChatDelivered\(res\.id\);/);
  assert.match(recv, /showDanmaku\(\{ id: m\.id, text: m\.text, self: false \}\)/);
  assert.match(recv, /if \(!isRoomHost\(\)\) return;/);
  // 转给所有人：转回发送者的那一份是送达回执，他那边按 id 认出回声，不会显示两遍
  assert.match(recv, /for \(const p of chatPeers\(\)\) p\.send\(wire\);/, '房主要把消息转给所有人，包括发送者本人');
  assert.match(fnOf('markChatDelivered'), /entry\.state = 'sent';/);
});

test('app.js：聊天历史只认房主那条连接、只收一次，落地时补一条分隔线且不上弹幕', () => {
  const history = fnOf('onChatHistory');
  assert.match(history, /if \(!trustsRelay\(peer\.peerId, S\.hostId\) \|\| S\.chat\.historyShown\) return;/);
  assert.match(history, /S\.chat\.historyShown = true;/);
  assert.match(history, /parseHistory\(msg\.items\)/);
  assert.match(history, /kind: 'divider', text: '你加入前的消息'/);
  assert.match(history, /quiet: true/, '补上来的旧消息不算未读');
  assert.doesNotMatch(history, /showDanmaku/, '历史只进聊天列表，不上弹幕');
  assert.match(history, /S\.chat\.gate\.remember\(it\.id\)/);

  // 握手完成时房主按契约顺序发：角色表 → 播放列表 → 聊天历史 → 同步状态
  const greet = app.slice(app.indexOf("S.swarm.on('peer-authenticated'"), app.indexOf("S.swarm.on('peer-gone'"));
  assert.ok(
    greet.indexOf('t: MSG.PLAYLIST') < greet.indexOf('t: MSG.CHAT_HISTORY'),
    'CHAT_HISTORY 要排在 PLAYLIST 之后'
  );
  assert.match(greet, /S\.swarm\.sendLarge\(peer, \{ t: MSG\.CHAT_HISTORY, items: S\.chat\.history\.snapshot\(\) \}\)/);
});

test('app.js：加入、离开、换片、谁按了暂停都在聊天流里留一行，事件日志照常保留', () => {
  const greet = app.slice(app.indexOf("S.swarm.on('peer-authenticated'"), app.indexOf("S.swarm.on('peer-gone'"));
  assert.match(greet, /S\.chat\.names\.set\(peer\.peerId, peer\.name\)/);
  assert.match(greet, /S\.chat\?\.note\(`\$\{peer\.name\} 加入了房间`\)/);

  const gone = app.slice(app.indexOf("S.swarm.on('peer-gone'"), app.indexOf("S.swarm.on('sources'"));
  assert.match(gone, /S\.chat\?\.gate\.forget\(peerId\)/, '走了的人要把他的令牌桶一起清掉');
  assert.match(gone, /S\.chat\.note\(`\$\{gone\} 离开了房间`\)/);

  const remote = app.slice(app.indexOf("S.sync.on('remote-action'"), app.indexOf("S.sync.on('local-action'"));
  assert.match(remote, /log\(`\$\{by\} \$\{label\} @ \$\{fmtTime\(position\)\}`\)/, '事件日志照常保留');
  assert.match(remote, /if \(kind === 'play' \|\| kind === 'pause'\) S\.chat\?\.note\(/);

  const switchCurrent = fnOf('switchCurrent');
  assert.match(switchCurrent, /S\.chat\?\.note\(playing\)/);
  assert.match(switchCurrent, /log\(playing, 'good'\)/);
});

test('app.js：弹幕帧随播放器代际启停，换片清场，pause / seek 在途停发', () => {
  assert.match(app, /S\.danmaku = createDanmakuPump\(\{\s*\r?\n\s*engine: danmakuEngine,/);
  assert.match(app, /send: \(frame\) => Promise\.resolve\(window\.sw\.player\.setDanmakuFrame\?\.\(frame\)\)/);
  // 起、退、主动退：三个路口都要跟着切
  assert.match(fnOf('handlePlayerExit'), /S\.danmaku\?\.setActive\(false\)/);
  assert.match(fnOf('retirePlayer'), /S\.danmaku\?\.setActive\(false\)/);
  assert.match(app.slice(app.indexOf('async function launchPlayer(')), /S\.danmaku\?\.setActive\(true\)/);
  assert.match(fnOf('switchCurrent'), /S\.danmaku\?\.clear\(\)/, '上一部的弹幕不能飞到下一部去');
  assert.match(fnOf('pushMpvBanner'), /S\.danmaku\?\.setBanner\(!!next\)/, '有常驻横幅时弹道要让出顶部');

  // pause / seek 在途：用计数不用布尔，叠在一起时先回来的那个不能把还在跑的也解了
  assert.match(app, /S\.sync\.onSetPause = \(p\) => whilePlayerBusy\(/);
  assert.match(app, /S\.sync\.onSeek = \(pos\) => whilePlayerBusy\(/);
  const busy = fnOf('whilePlayerBusy');
  assert.match(busy, /playerBusy \+= 1;\s*\r?\n\s*S\.danmaku\.setBusy\(true\);/);
  assert.match(busy, /if \(playerBusy === 0\) S\.danmaku\.setBusy\(false\);/);

  // 在播放器里发的那条和房间输入框走同一条路、同一把令牌桶
  // 主进程给的是 {text, gen, kind}，当成裸字符串的话清洗完是空的，播放器里发的弹幕会被静默丢掉
  assert.match(app, /onChatInput\?\.\(\(payload\) => \{[\s\S]*?sendChat\(payload\?\.text, \{ fromPlayer: true \}\)/);
});

test('app.js：进房就把聊天面板和弹幕开关摆出来', () => {
  const enter = app.slice(app.indexOf('async function enterRoom()'), app.indexOf('function selectRoomTab('));
  assert.match(enter, /renderChat\(\);/);
  assert.match(enter, /ensureDanmakuControls\(\);/);
  assert.match(fnOf('ensureChatPanel'), /document\.title = `\$\{prefix\}NoxReel`/);
  assert.match(fnOf('ensureChatPanel'), /window\.addEventListener\('blur', \(\) => chatPanel\.setFocused\(false\)\)/);
  assert.match(fnOf('ensureDanmakuControls'), /saveDanmakuSettings\(next\)/);
  assert.match(fnOf('ensureDanmakuControls'), /S\.danmaku\.setEnabled\(next\.enabled !== false\)/);
});

/* ============================== 聊天收发（真跑一遍） ============================== */

// 上面那几条只是盯着源码，收发这一路得真跑：把 app.js 里的收发函数原样抠进 vm 沙箱，
// 配上真的 ChatGate / ChatSender / ChatHistory 和几条假连接，按出事时的先后顺序喂消息。
// 沿用 test/roomFlowFixes.test.js、test/p4RoomCleanup.test.js 的老办法。
const vm = require('node:vm');

const APP_SRC = app.replace(/\r\n/g, '\n');

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP_SRC);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP_SRC.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP_SRC.slice(m.index, end + 2);
}

const CHAT_FNS = ['sendChat', 'onChatMessage', 'markChatDelivered', 'onChatHistory', 'chatPeers', 'pushChatEntry', 'chatSystem'];

async function chatBox({ host = false, peerId = 'me-peer-000', hostId = 'host-peer-00' } = {}) {
  const { ChatGate, ChatHistory, ChatSender } = await import('../src/renderer/lib/chat.js');
  const { MSG } = await import('../src/renderer/lib/protocol.js');
  const chat = await import('../src/renderer/lib/chat.js');

  const wire = []; // [peerId, 消息]
  const peers = new Map();
  const addPeer = (id, name) => {
    const peer = { peerId: id, name, authenticated: true, send: (m) => wire.push([id, m]) };
    peers.set(id, peer);
    return peer;
  };

  let isHost = host;
  const danmakus = [];
  const notices = [];
  const osds = [];
  let seq = 0;

  const S = {
    peerId,
    name: '我自己',
    hostId,
    swarm: { peers },
    chat: {
      entries: [],
      gate: new ChatGate(),
      sender: new ChatSender(),
      history: new ChatHistory(),
      names: new Map(),
      historyShown: false,
      notice: '',
      note: (text) => ctx.chatSystem(text),
    },
  };

  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Set,
    Map,
    S,
    MSG,
    VIEW_LIMIT: 300,
    roomEntered: true,
    randomId: () => `r${++seq}`,
    t: (x) => x,
    isRoomHost: () => isHost,
    trustsRelay: chat.trustsRelay,
    parseHistory: chat.parseHistory,
    showDanmaku: (m) => danmakus.push(m),
    renderChat: () => {},
    chatNotice: (text) => notices.push(text),
    window: { sw: { player: { osd: (text, ms) => osds.push([text, ms]) } } },
  };
  vm.createContext(ctx);
  vm.runInContext(CHAT_FNS.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });

  return {
    ctx,
    S,
    MSG,
    wire,
    danmakus,
    notices,
    osds,
    addPeer,
    setHost: (flag) => {
      isHost = flag;
    },
    entries: () => S.chat.entries,
    /** 只看真正的聊天消息（系统事件另算） */
    msgs: () => S.chat.entries.filter((e) => e.kind === 'msg'),
  };
}

test('自己发的：非房主先显示「发送中」，房主转回来同一条 id 就转成「已送达」，而且不会显示两遍', async () => {
  const box = await chatBox();
  const host = box.addPeer('host-peer-00', '房主');
  box.addPeer('other-peer-0', '阿狸');

  assert.equal(box.ctx.sendChat('你好呀'), true);
  const mine = box.msgs()[0];
  assert.equal(mine.text, '你好呀');
  assert.equal(mine.self, true);
  assert.equal(mine.state, 'sending');
  assert.equal(box.wire.length, 2, '两个人都要收到');
  const sentWire = box.wire[0][1];
  assert.equal(sentWire.t, box.MSG.CHAT);
  assert.equal(sentWire.text, '你好呀');
  assert.equal(sentWire.origin, undefined, '不是房主，不许自称转发');
  // vm 沙箱里造出来的对象和这边不是同一个 realm，deepEqual 会卡在原型上，摊平了比
  assert.deepEqual(
    box.danmakus.map((d) => [d.id, d.text, d.self]),
    [[mine.key, '你好呀', true]]
  );

  // 房主把它转回来（带 origin 指向我）
  box.ctx.onChatMessage({ t: box.MSG.CHAT, id: mine.key, text: '你好呀', ts: 1, origin: 'me-peer-000', originName: '我自己' }, host);
  assert.equal(box.msgs().length, 1, '回声不能再显示一遍');
  assert.equal(box.msgs()[0].state, 'sent');
  assert.equal(box.danmakus.length, 1, '回声也不该再上一次弹幕');
});

test('房主发的直接算已送达，同时进历史并带上 origin', async () => {
  const box = await chatBox({ host: true, peerId: 'host-peer-00', hostId: 'host-peer-00' });
  box.addPeer('other-peer-0', '阿狸');

  box.ctx.sendChat('  开  始   放了  ');
  const mine = box.msgs()[0];
  assert.equal(mine.text, '开 始 放了', '连续空白合并、首尾 trim 由 chat.js 负责');
  assert.equal(mine.state, 'sent', '房主本人就是转发中枢，没有「等谁转回来」这回事');
  assert.equal(box.wire.length, 1);
  assert.equal(box.wire[0][1].origin, 'host-peer-00');
  assert.equal(box.wire[0][1].originName, '我自己');
  assert.deepEqual(
    box.S.chat.history.list().map((it) => [it.text, it.origin]),
    [['开 始 放了', 'host-peer-00']]
  );
});

test('房主收别人的消息：进列表、上弹幕、留进历史，再转给所有人（转回发送者的那份就是送达回执）', async () => {
  const box = await chatBox({ host: true, peerId: 'host-peer-00', hostId: 'host-peer-00' });
  const a = box.addPeer('aaaa-peer-00', '阿狸');
  box.addPeer('bbbb-peer-00', '小明');
  box.addPeer('cccc-peer-00', '大壮');

  box.ctx.onChatMessage({ t: box.MSG.CHAT, id: 'abc123abc123', text: '好看', ts: 5 }, a);
  assert.deepEqual(box.msgs().map((m) => [m.name, m.text, m.self]), [['阿狸', '好看', false]]);
  assert.deepEqual(
    box.danmakus.map((d) => [d.id, d.text, d.self]),
    [['abc123abc123', '好看', false]]
  );
  // 发送者本人也要收到这一份：他那边认出是自己的回声，把「发送中」改成「已送达」。
  // 少了它，两个人的房间里发送者会永远停在「发送中」（端到端实测抓到过）。
  assert.deepEqual(box.wire.map(([to]) => to), ['aaaa-peer-00', 'bbbb-peer-00', 'cccc-peer-00']);
  assert.equal(box.wire[0][1].origin, 'aaaa-peer-00');
  assert.equal(box.wire[0][1].originName, '阿狸');
  // 留进历史，晚到的人进房时才补得上
  assert.deepEqual(
    box.S.chat.history.list().map((it) => [it.text, it.origin, it.name]),
    [['好看', 'aaaa-peer-00', '阿狸']]
  );

  // 网状模式下同一条会从两条路各到一次：按 id 去重，不显示第二遍
  box.ctx.onChatMessage({ t: box.MSG.CHAT, id: 'abc123abc123', text: '好看', ts: 5 }, a);
  assert.equal(box.msgs().length, 1);
});

test('只有房主转发来的才采信 origin：别人冒充一律算他本人', async () => {
  const box = await chatBox();
  const a = box.addPeer('aaaa-peer-00', '阿狸');
  // 阿狸冒充房主转发，想把消息挂到别人名下
  box.ctx.onChatMessage(
    { t: box.MSG.CHAT, id: 'aaa111bbb222', text: '我是房主', ts: 1, origin: 'host-peer-00', originName: '房主' },
    a
  );
  assert.deepEqual(box.msgs().map((m) => [m.name, m.text]), [['阿狸', '我是房主']]);
});

test('发得太快时挡下来并提示；在播放器里发的还会推一条 OSD', async () => {
  const box = await chatBox();
  box.addPeer('host-peer-00', '房主');
  for (let i = 0; i < 5; i++) assert.equal(box.ctx.sendChat(`第 ${i} 条`), true, '突发 5 条要放行');

  assert.equal(box.ctx.sendChat('第六条'), false);
  assert.equal(box.msgs().length, 5, '被挡下的那条不进列表');
  assert.equal(box.notices.length, 1);
  assert.match(box.notices[0], /^发得太快了（\d+ 秒后再试）$/);
  assert.equal(box.osds.length, 0, '在房间窗口里发的，不用打扰播放器');

  // 播放器里那条输入条走同一把令牌桶，绕不过去
  assert.equal(box.ctx.sendChat('播放器里发的', { fromPlayer: true }), false);
  assert.equal(box.osds.length, 1);
  assert.match(box.osds[0][0], /^发得太快了（\d+ 秒后再试）$/);

  // 空消息不占令牌，也不提示
  assert.equal(box.ctx.sendChat('   '), false);
  assert.equal(box.notices.length, 2);
});

test('聊天历史：只认房主那条连接、只收一次，旧消息在前并补一条分隔线，而且不上弹幕', async () => {
  const box = await chatBox();
  const host = box.addPeer('host-peer-00', '房主');
  const a = box.addPeer('aaaa-peer-00', '阿狸');

  const items = [
    { id: 'aaaaaaaaaaaa', text: '第一句', from: 'aaaa-peer-00', name: '阿狸', at: 1 },
    { id: 'bbbbbbbbbbbb', text: '第二句', from: 'me-peer-000', name: '我自己', at: 2 },
  ];

  // 冒充房主发历史的一律不看
  box.ctx.onChatHistory({ t: box.MSG.CHAT_HISTORY, items }, a);
  assert.equal(box.entries().length, 0);
  assert.equal(box.S.chat.historyShown, false);

  box.ctx.onChatHistory({ t: box.MSG.CHAT_HISTORY, items }, host);
  assert.deepEqual(
    box.entries().map((e) => e.kind),
    ['msg', 'msg', 'divider'],
    '旧消息在前，分隔线把它们和之后的新消息隔开'
  );
  assert.equal(box.entries()[2].text, '你加入前的消息');
  assert.equal(box.entries()[1].self, true, '历史里自己那条也认得出来');
  assert.ok(box.entries().every((e) => e.kind !== 'msg' || e.quiet), '补上来的旧消息不算未读');
  assert.deepEqual(box.danmakus, [], '历史只进聊天列表，不上弹幕');

  // 第二包历史不再收；房主随后又把同一条转发过来时，也不会显示第二遍
  box.ctx.onChatHistory({ t: box.MSG.CHAT_HISTORY, items: [{ id: 'cccccccccccc', text: '第三句', from: 'aaaa-peer-00', at: 3 }] }, host);
  assert.equal(box.entries().length, 3);
  box.ctx.onChatMessage({ t: box.MSG.CHAT, id: 'aaaaaaaaaaaa', text: '第一句', ts: 1, origin: 'aaaa-peer-00', originName: '阿狸' }, host);
  assert.equal(box.entries().filter((e) => e.kind === 'msg').length, 2);
});

test('系统事件进聊天流，列表长了只丢最老的', async () => {
  const box = await chatBox();
  box.S.chat.note('阿狸 加入了房间');
  assert.deepEqual(box.entries().map((e) => [e.kind, e.text]), [['system', '阿狸 加入了房间']]);

  for (let i = 0; i < box.ctx.VIEW_LIMIT + 5; i++) box.S.chat.note(`第 ${i} 条`);
  assert.equal(box.entries().length, box.ctx.VIEW_LIMIT);
  assert.equal(box.entries().at(-1).text, `第 ${box.ctx.VIEW_LIMIT + 4} 条`);
  assert.ok(!box.entries().some((e) => e.text === '阿狸 加入了房间'), '最老的先丢');
});

/**
 * 同一层出现两条同 key 的消息，面板的 patch() 会当场抛错，而且那两条一直留在列表里 ——
 * 之后每一次重绘都再抛一次，聊天面板从此永久坏掉。两条真实路径：
 * 去重表有 TTL（同 id 隔久了会「复活」），以及网状模式下直连那份和房主补发的历史撞上。
 */
test('app.js：同一条消息进不了聊天流两次（去重表过期、历史与直连撞上都要兜住）', async () => {
  const box = await chatBox();
  const host = box.addPeer('host-peer-00', '房主');
  const a = box.addPeer('aaaa-peer-00', '阿狸');

  box.ctx.onChatMessage({ t: box.MSG.CHAT, id: 'dd1111dd1111', text: '同一条', ts: 1 }, a);
  assert.equal(box.msgs().length, 1);

  // 去重表按时间过期之后，同一个 id 会被当成新消息收下 —— 这一层必须自己按 key 挡住
  box.S.chat.gate.clear();
  box.ctx.onChatMessage({ t: box.MSG.CHAT, id: 'dd1111dd1111', text: '同一条', ts: 1 }, a);
  assert.equal(box.msgs().length, 1, '同 key 不能进第二次');

  // 房主补发的历史里也有这一条：跳过它，只留分隔线
  box.ctx.onChatHistory({ t: box.MSG.CHAT_HISTORY, items: [{ id: 'dd1111dd1111', text: '同一条', from: 'aaaa-peer-00', name: '阿狸', at: 1 }] }, host);
  const keys = box.S.chat.entries.map((e) => e.key);
  assert.equal(keys.filter((k) => k === 'dd1111dd1111').length, 1, '历史里的重复条目要跳过');
  assert.ok(keys.includes('history'), '分隔线照常补上');

  // 重绘不抛错：真面板的 patch() 遇到重复 key 会抛，抛了就再也画不出来
  assert.doesNotThrow(() => box.ctx.pushChatEntry({ key: 'dd1111dd1111', kind: 'msg', name: '阿狸', text: '同一条' }));
});
