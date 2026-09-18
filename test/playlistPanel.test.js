'use strict';

// 播放列表面板（ui/playlistPanel.js）：只管画表格和收集手势，改表交给回调。
// 这里盯的是几处容易悄悄坏掉的地方：行以 id 复用、拖动期间不重绘、上下半截的落点、
// 片名这类用户内容在英文界面里不许被翻译、「⋯」菜单的开关时机。
//
// 仓库没有 jsdom，下面自己实现面板用得到的那一块 DOM：节点树（含 insertBefore 和「节点被摘掉就丢焦点」）、
// class / data-* / 属性联动、带冒泡的事件派发，以及一个够用的选择器（标签、.a、.a.b、#id、[属性]、[属性="值"]、
// :not(...)、逗号、后代空格）。遇到不认识的选择器直接报错，免得组件换了写法而测试悄悄放行。
const test = require('node:test');
const assert = require('node:assert/strict');

const I18N = '../src/renderer/lib/i18n.js';
const PANEL = '../src/renderer/ui/playlistPanel.js';

/* ------------------------------ 假 DOM ------------------------------ */

/**
 * 指向其它节点的字段一律设成不可枚举。断言失败时 assert 会把实参按 depth 1000 展开再逐行做 diff：
 * 顺着 parentNode / childNodes / ownerDocument 能把整棵假 DOM 从每个祖先处各展开一遍，
 * 输出几十万行，diff 的内存按平方涨 —— 实测一次失败就吃掉 20 多 GB。藏起来以后只展开节点自己。
 */
function hideFields(obj, fields) {
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
  }
}

// 遍历上限：树里万一出现环（假 DOM 或组件的毛病），立刻报错，而不是无限循环吃内存
const MAX_DEPTH = 256;
const MAX_NODES = 20000;

/** 从 node 起沿 via（parentNode / parentElement）往上走，含 node 自己。 */
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

  addEventListener(type, listener, options) {
    const list = this.listeners.get(type) || [];
    if (list.some((entry) => entry.listener === listener)) return;
    list.push({ listener, once: typeof options === 'object' && !!options?.once });
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((entry) => entry.listener !== listener));
  }

  invokeListeners(event) {
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.listener);
      if (typeof entry.listener === 'function') entry.listener.call(this, event);
      else entry.listener.handleEvent(event);
      if (event.immediateStopped) break;
    }
  }
}

function makeEvent(type, target, init) {
  return {
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
}

/** 与浏览器一致：先目标、再逐级祖先，一直冒到 document（bubbles:false 时只到目标）。 */
function fire(target, type, init = {}) {
  const event = makeEvent(type, target, init);
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

  get isConnected() {
    return [...lineage(this)].at(-1).nodeType === FakeNode.DOCUMENT_NODE;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren();
    const text = value == null ? '' : String(value);
    if (text) this.append(text);
  }

  // 已经挂在别处的节点会先摘下来再挂过来，和浏览器一样（重绘复用行元素全靠这一点）
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
    if (!(node instanceof FakeNode)) throw new TypeError('假 DOM：insertBefore 只收节点');
    if (ref != null && ref.parentNode !== this) throw new Error('假 DOM：insertBefore 的参照节点不在这个父节点下');
    if (node.contains(this)) throw new Error('假 DOM：不能把祖先挂到自己下面');
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

  /**
   * 摘掉节点的同时把里面的焦点也丢掉：浏览器就是这样，节点被移出文档（哪怕下一行又挂回去）
   * 焦点都回不来，落到 body 上。假 DOM 不模拟这一点的话，「重绘不换人」的用例会假通过。
   */
  dropFocus() {
    const doc = this.ownerDocument;
    if (doc?.focused && (doc.focused === this || this.contains(doc.focused))) doc.focused = null;
  }

  contains(other) {
    for (const node of lineage(other)) if (node === this) return true;
    return false;
  }

  /** 按文档顺序列出全部后代（不含自己）。 */
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
      get: (_target, prop) =>
        typeof prop === 'string' && el.hasAttribute(dataAttr(prop)) ? el.getAttribute(dataAttr(prop)) : undefined,
      set: (_target, prop, value) => {
        el.setAttribute(dataAttr(prop), value);
        return true;
      },
      has: (_target, prop) => typeof prop === 'string' && el.hasAttribute(dataAttr(prop)),
      deleteProperty: (_target, prop) => {
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

const ZERO_RECT = { left: 0, top: 0, width: 0, height: 0 };

class FakeElement extends FakeNode {
  constructor(doc, tagName) {
    super(FakeNode.ELEMENT_NODE, doc);
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.style = {};
    this.rect = null; // 测试可以直接给某个元素定布局，没给就问 document.layout
    this.classList = makeClassList(this);
    this.dataset = makeDataset(this);
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

  // 下面几个属性和浏览器一样与特性联动，选择器才看得见（比如 button:not([disabled])）
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

  get draggable() {
    return this.getAttribute('draggable') === 'true';
  }

  set draggable(value) {
    this.setAttribute('draggable', value ? 'true' : 'false');
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(value) {
    if (value) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
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

  getBoundingClientRect() {
    const r = { ...ZERO_RECT, ...(this.rect || this.ownerDocument.layout?.(this) || {}) };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
  }

  focus() {
    this.ownerDocument.focused = this;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(FakeNode.DOCUMENT_NODE, null);
    // layout：(el) => {left, top, width, height} | null
    hideFields(this, { layout: null, focused: null, documentElement: this.createElement('html'), body: this.createElement('body') });
    this.documentElement.append(this.body);
    this.append(this.documentElement);
  }

  // 和浏览器一样：拿着焦点的元素被摘掉以后，焦点落回 body
  get activeElement() {
    return this.focused?.isConnected && this.contains(this.focused) ? this.focused : this.body;
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
    this.innerWidth = 1280;
    this.innerHeight = 720;
    const store = new Map();
    // i18n.setLocale 会把语言写进 localStorage，这里接住，别碰真的存储
    this.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    };
  }
}

// —— 选择器 ——

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

// 逗号分隔的每一段是一条「后代链」：空格隔开的若干复合选择器，最后一个对应元素自己
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

// —— 拖放数据 ——

function fileList(...files) {
  // 真的 FileList 不是数组，组件得自己展开
  return {
    length: files.length,
    item: (i) => files[i] ?? null,
    *[Symbol.iterator]() {
      yield* files;
    },
  };
}

class FakeDataTransfer {
  constructor({ types = [], files = fileList() } = {}) {
    this.externalTypes = [...types];
    this.data = new Map();
    this.files = files;
    this.effectAllowed = 'uninitialized';
    this.dropEffect = 'none';
  }

  get types() {
    return Object.freeze([...this.externalTypes, ...this.data.keys()]);
  }

  setData(type, value) {
    this.data.set(type, String(value));
  }

  getData(type) {
    return this.data.get(type) ?? '';
  }
}

/* ------------------------------ 测试夹具 ------------------------------ */

const DOM_GLOBALS = ['document', 'window', 'Node'];

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

const ROW_TOP = 100;
const ROW_H = 40;

function row(id, over = {}) {
  return {
    id,
    name: `片子${id}`,
    meta: [],
    current: false,
    next: false,
    locked: false,
    lockTitle: '',
    transfer: null,
    notice: null,
    menu: [{ key: 'remove', label: '移除', danger: true }],
    ...over,
  };
}

const played = (id, over = {}) => ({ id, name: `看过的${id}`, meta: [], menu: [{ key: 'replay', label: '再放一次' }], ...over });

const job = (key, over = {}) => ({ key, name: `新片${key}`, text: '正在检查格式', detail: '', tone: '', ratio: null, actions: [], ...over });

/** rows 里可以直接写 id 字符串；index 按顺序补上。 */
function view(rows, over = {}) {
  return {
    canEdit: true,
    emptyText: '列表还是空的，点右上角加一部。',
    banner: '',
    rows: rows.map((r, i) => {
      const item = typeof r === 'string' ? row(r) : r;
      return { ...item, index: item.index ?? i + 1 };
    }),
    pending: [],
    history: [],
    ...over,
  };
}

/**
 * 每个用例一份全新的假 document / window，面板挂在 document.body 下面的一个 div 里，
 * 这样子元素的事件既能冒到面板 body，也能冒到 document。用完还原全局和界面语言。
 */
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
    const { createPlaylistPanel } = await import(PANEL);
    const body = doc.createElement('div');
    body.className = 'panel-body';
    doc.body.append(body);
    const calls = { actions: [], moves: [], drops: [] };
    const panel = createPlaylistPanel({
      body,
      onAction: (key, id) => calls.actions.push([key, id]),
      onMove: (id, beforeId) => calls.moves.push([id, beforeId]),
      onDropFiles: (files) => calls.drops.push(files),
    });

    const table = body.querySelector('.pl-table');
    // 队列里的行按在表里的位置摆好：第 i 行占 [ROW_TOP + i*ROW_H, +ROW_H)
    doc.layout = (el) => {
      if (el.parentNode !== table) return null;
      const i = table.children.indexOf(el);
      return { left: 0, top: ROW_TOP + i * ROW_H, width: 320, height: ROW_H };
    };

    const ctx = {
      doc,
      win,
      body,
      panel,
      calls,
      table,
      banner: body.querySelector('.pl-banner'),
      empty: body.querySelector('.panel-empty'),
      history: body.querySelector('.pl-history'),
      rowEl: (id) => table.querySelector(`.pl-row[data-id="${id}"]`),
      historyEl: (id) => body.querySelector(`.pl-history-list .pl-row[data-id="${id}"]`),
      // 表里的顺序；待加入的行记成 +key
      order: () => table.children.map((el) => (el.dataset.pending !== undefined ? `+${el.dataset.pending}` : el.dataset.id)),
      historyOrder: () => body.querySelector('.pl-history-list').children.map((el) => el.dataset.id),
      /** 第 id 行上半截 / 下半截的 clientY */
      yOf: (id, half) => {
        const rect = ctx.rowEl(id).getBoundingClientRect();
        return half === 'upper' ? rect.top + rect.height * 0.25 : rect.top + rect.height * 0.75;
      },
      openMenus: () => doc.querySelectorAll('.pl-menu'),
    };
    await fn(ctx);
  } finally {
    if (i18n) i18n.setLocale(before);
    restore();
  }
}

/** 浏览器里一次点击是 mousedown 再 click。 */
function press(el) {
  fire(el, 'mousedown');
  fire(el, 'click');
}

const hasClass = (el, name) => el.classList.contains(name);
const texts = (els) => els.map((el) => el.textContent);

/** 按浏览器的顺序走完一次行拖动：源行 dragstart → 目标 dragover → 目标 drop → 源行 dragend。 */
function dragRow(source, target, clientY) {
  const dataTransfer = new FakeDataTransfer();
  fire(source, 'dragstart', { dataTransfer });
  const over = fire(target, 'dragover', { clientY, dataTransfer });
  const dropped = fire(target, 'drop', { clientY, dataTransfer });
  fire(source, 'dragend', { dataTransfer });
  return { over, dropped, dataTransfer };
}

/* ------------------------------ 用例 ------------------------------ */

test('按 view 的顺序出行：队列在前、待加入在后，已播放收进 details，空列表文案只在没行时出现', async () => {
  await withPanel({}, async ({ body, panel, table, empty, history, order, historyOrder }) => {
    // 骨架顺序固定：提示条、表格、空列表文案、已播放
    assert.deepEqual(
      body.children.map((el) => el.className.split(' ')[0]),
      ['pl-banner', 'pl-table', 'panel-empty', 'pl-history']
    );

    panel.render(view(['a', 'b', 'c'], { pending: [job('j1')], history: [played('h1'), played('h2')] }));
    assert.deepEqual(order(), ['a', 'b', 'c', '+j1'], '待加入的行排在队列后面');
    assert.deepEqual(texts(table.querySelectorAll('.pl-index')), ['1', '2', '3', '+']);
    const pendingEl = table.children[3];
    assert.ok(hasClass(pendingEl, 'pending'));
    assert.equal(pendingEl.draggable, false);
    assert.equal(pendingEl.hasAttribute('data-id'), false, '待加入的行不能被当成可排序的行');

    assert.equal(history.tagName, 'DETAILS');
    assert.equal(hasClass(history, 'hidden'), false);
    assert.equal(history.children[0].tagName, 'SUMMARY');
    assert.equal(history.children[0].textContent, '已播放（2）');
    assert.deepEqual(historyOrder(), ['h1', 'h2']);
    assert.ok(history.querySelectorAll('.pl-row').every((el) => hasClass(el, 'played')));
    assert.ok(hasClass(empty, 'hidden'));

    panel.render(view(['c', 'a', 'b']));
    assert.deepEqual(order(), ['c', 'a', 'b'], '顺序跟着 view 走');
    assert.ok(hasClass(history, 'hidden'), '没有已播放就收起');
    assert.equal(history.children[0].textContent, '已播放（0）');
    assert.deepEqual(historyOrder(), []);

    // 队列空了但还有待加入的片：不算空列表
    panel.render(view([], { pending: [job('j1')] }));
    assert.deepEqual(order(), ['+j1']);
    assert.ok(hasClass(empty, 'hidden'));

    panel.render(view([]));
    assert.deepEqual(order(), []);
    assert.equal(hasClass(empty, 'hidden'), false);
    assert.equal(empty.textContent, '列表还是空的，点右上角加一部。');

    panel.render(view([], { emptyText: '列表还是空的，等房主加片。' }));
    assert.equal(empty.textContent, '列表还是空的，等房主加片。', '文案换了要跟着换，不能叠在后面');

    panel.render(view(['a']));
    assert.ok(hasClass(empty, 'hidden'));
  });
});

test('行以 id 为键复用元素；id 消失后丢掉，再出现时是新元素', async () => {
  await withPanel({}, async ({ panel, rowEl, order }) => {
    panel.render(view(['a', 'b']));
    const a = rowEl('a');
    const b = rowEl('b');

    panel.render(view(['b', 'a'], { canEdit: false }));
    assert.equal(rowEl('a'), a, '同一个 id 重绘后还是同一个元素（拖动、焦点、动画都靠它）');
    assert.equal(rowEl('b'), b);
    assert.deepEqual(order(), ['b', 'a']);

    panel.render(view(['b']));
    assert.equal(rowEl('a'), null);
    assert.equal(a.parentNode, null, '消失的行要从表里摘掉');

    panel.render(view(['a', 'b']));
    assert.notEqual(rowEl('a'), a, '缓存里不能留着已经消失的行，否则重新出现时会拿到旧元素');
    assert.equal(rowEl('b'), b);
  });
});

test('英文界面：片名等用户内容原样显示，界面文案照常翻译', async () => {
  await withPanel({ locale: 'en' }, async ({ panel, body, table, history, rowEl, historyEl }) => {
    panel.render(
      view(
        [
          row('a', {
            name: '播放',
            current: true,
            meta: ['排队中', { label: '添加者：', raw: '暂停' }, '', null, { raw: '播放', className: 'pl-who' }, { text: '已收完', className: 'ok' }],
            transfer: { text: '已收完 · 扫描中', tone: 'busy', ratio: null },
            notice: { text: '需要允许打开', tone: 'warn', site: '暂停.example.com', actions: [{ key: 'allow', label: '允许' }] },
          }),
          row('b', { name: '暂停', next: true, locked: true, lockTitle: '已开播：把别的片拖到它上面会先问你要不要切过去' }),
        ],
        {
          pending: [job('j1', { name: '播放', text: '正在检查格式', detail: '等待房主确认' })],
          history: [played('h1', { name: '已播放（3）', meta: ['已收完'] })],
        }
      )
    );

    // 片名叫「播放」「暂停」也不能被翻成 Play / Pause
    const nameA = rowEl('a').querySelector('.pl-name');
    assert.equal(nameA.textContent, '播放');
    assert.equal(nameA.getAttribute('title'), '播放', '悬停提示也是片名，不翻译');
    assert.ok(nameA.hasAttribute('data-i18n-skip'), '要打跳过标记，自动翻译的 MutationObserver 才不会再去碰它');
    assert.equal(rowEl('b').querySelector('.pl-name').textContent, '暂停');
    // 片名恰好长得像带数字的界面文案，模式翻译也不能碰
    assert.equal(historyEl('h1').querySelector('.pl-name').textContent, '已播放（3）');
    const pendingName = table.querySelector('.pending .pl-name');
    assert.equal(pendingName.textContent, '播放');
    assert.ok(pendingName.hasAttribute('data-i18n-skip'));
    assert.equal(pendingName.getAttribute('title'), '播放');

    // 徽标是界面文案
    assert.equal(rowEl('a').querySelector('.pl-badge.playing').textContent, 'Now playing');
    assert.equal(rowEl('b').querySelector('.pl-badge.next').textContent, 'Up next');
    assert.equal(rowEl('a').querySelector('.pl-badge.next'), null, '正在播放的行不再标「下一部」');

    // meta：字符串和 {text} 翻译，{label} 翻译、{raw} 原样；空片段不留多余的分隔符
    const meta = rowEl('a').querySelector('.pl-meta');
    assert.deepEqual(texts(meta.children), ['Queued', ' · ', 'Added by ', '暂停', ' · ', '播放', ' · ', 'Received']);
    const rawParts = meta.querySelectorAll('[data-i18n-skip]');
    assert.deepEqual(texts(rawParts), ['暂停', '播放']);
    assert.ok(hasClass(rawParts[1], 'pl-who'));
    assert.equal(meta.querySelectorAll('.ok-sep').length, 1, '带样式片段前的分隔符跟着带样式');
    assert.equal(meta.children[2].hasAttribute('data-i18n-skip'), false, '前缀是界面文案，不能跟着跳过');
    assert.equal(historyEl('h1').querySelector('.pl-meta').textContent, 'Received');

    assert.equal(rowEl('a').querySelector('.pl-transfer').textContent, 'Received · Scanning');
    assert.ok(hasClass(rowEl('a').querySelector('.pl-transfer'), 'busy'));

    // notice：说明翻译，站点原样
    const notice = rowEl('a').querySelector('.pl-notice');
    assert.ok(hasClass(notice, 'warn'));
    assert.equal(notice.querySelector('.pl-notice-text').children[0].textContent, 'Needs your permission to open');
    const site = notice.querySelector('.pl-site');
    assert.equal(site.textContent, '暂停.example.com');
    assert.ok(site.hasAttribute('data-i18n-skip'));
    assert.equal(notice.querySelector('.pl-act').textContent, 'Allow');

    // 待加入：状态和细节是界面文案
    assert.equal(table.querySelector('.pending .pl-transfer').textContent, 'Checking the format');
    assert.equal(table.querySelector('.pending .pl-pending-text').textContent, 'Waiting for the host');

    // 界面上的提示属性照翻
    const lock = rowEl('b').querySelector('.pl-lock');
    assert.equal(lock.getAttribute('title'), 'Already playing: dragging another video above it asks before switching');
    assert.equal(lock.getAttribute('aria-label'), lock.getAttribute('title'));
    const more = rowEl('a').querySelector('.pl-more');
    assert.equal(more.getAttribute('aria-label'), 'More actions');
    assert.equal(more.getAttribute('title'), 'More actions');

    assert.equal(history.children[0].textContent, 'Played (1)');
    assert.equal(body.querySelector('.panel-empty').textContent, '');
  });
});

test('canEdit 决定行能不能拖、有没有抓手；已播放的行永远不能拖', async () => {
  await withPanel({}, async ({ panel, body, table, rowEl, historyEl }) => {
    const rows = ['a', row('b', { current: true })];
    const history = [played('h1')];

    panel.render(view(rows, { canEdit: false, history }));
    for (const id of ['a', 'b']) {
      assert.equal(rowEl(id).draggable, false, `${id} 没权限时不能拖`);
      assert.equal(hasClass(rowEl(id), 'editable'), false);
      assert.ok(rowEl(id).querySelector('.pl-index'), '序号照常显示');
    }
    assert.equal(body.querySelector('.pl-grip'), null, '没权限就不给抓手');
    assert.equal(hasClass(table, 'editable'), false);

    const a = rowEl('a');
    panel.render(view(rows, { canEdit: true, history }));
    assert.equal(rowEl('a'), a);
    for (const id of ['a', 'b']) {
      assert.equal(rowEl(id).draggable, true);
      assert.ok(hasClass(rowEl(id), 'editable'));
      assert.equal(rowEl(id).querySelectorAll('.pl-grip').length, 1);
    }
    assert.ok(hasClass(rowEl('b'), 'current'));
    assert.ok(hasClass(table, 'editable'));
    // 已播放区不参与排序
    const h1 = historyEl('h1');
    assert.equal(h1.draggable, false);
    assert.equal(h1.querySelector('.pl-grip'), null);
    assert.equal(h1.querySelector('.pl-index'), null);
    assert.ok(hasClass(h1, 'played'));
    assert.equal(hasClass(h1, 'editable'), false);

    // 权限被收回：同一个元素重新填，抓手和可拖都要撤掉
    panel.render(view(rows, { canEdit: false, history }));
    assert.equal(rowEl('a'), a);
    assert.equal(a.draggable, false);
    assert.equal(body.querySelector('.pl-grip'), null);
  });
});

test('拖动排序：上半截插到前面、下半截插到后面、表格空白放到最后，拖回原位不发请求', async () => {
  await withPanel({}, async ({ doc, panel, table, calls, rowEl, yOf }) => {
    const { isDragging } = panel;
    panel.render(view(['a', 'b', 'c', 'd'], { pending: [job('j1')], history: [played('h1')] }));
    const moved = (source, target, y) => {
      calls.moves.length = 0;
      const result = dragRow(rowEl(source), target, y);
      assert.equal(isDragging(), false, '松手后拖动状态要清掉');
      return { ...result, moves: calls.moves.slice() };
    };

    let r = moved('a', rowEl('c'), yOf('c', 'upper'));
    assert.deepEqual(r.moves, [['a', 'c']], '上半截 → 插到 c 前面');
    assert.ok(r.over.defaultPrevented, 'dragover 不拦下来浏览器就不让放');
    assert.equal(r.over.dataTransfer.dropEffect, 'move');
    assert.ok(r.dropped.defaultPrevented);
    assert.equal(r.dataTransfer.effectAllowed, 'move');
    assert.ok([...r.dataTransfer.data.values()].includes('a'), '拖动数据里带着条目 id');
    assert.equal(r.dataTransfer.types.includes('Files'), false);

    r = moved('a', rowEl('c'), yOf('c', 'lower'));
    assert.deepEqual(r.moves, [['a', 'd']], '下半截 → 插到下一行 d 前面');

    r = moved('a', rowEl('d'), yOf('d', 'lower'));
    assert.deepEqual(r.moves, [['a', null]], '最后一行的下半截 → 放到最后（后面的待加入行不算）');

    r = moved('b', table, ROW_TOP + 10 * ROW_H);
    assert.deepEqual(r.moves, [['b', null]], '表格空白处 → 放到最后');

    // 落点是行里的子元素也照样找到行
    r = moved('d', rowEl('b').querySelector('.pl-name'), yOf('b', 'upper'));
    assert.deepEqual(r.moves, [['d', 'b']]);

    // 拖回原位：插到自己前面、插到紧跟自己的那一行前面，顺序都不会变
    assert.deepEqual(moved('b', rowEl('b'), yOf('b', 'upper')).moves, [], '落在自己上半截');
    assert.deepEqual(moved('b', rowEl('a'), yOf('a', 'lower')).moves, [], '落在紧邻上一行的下半截');
    assert.deepEqual(moved('b', rowEl('b'), yOf('b', 'lower')).moves, [], '落在自己下半截');
    assert.deepEqual(moved('b', rowEl('c'), yOf('c', 'upper')).moves, [], '落在紧邻下一行的上半截');
    assert.deepEqual(moved('d', table, ROW_TOP + 10 * ROW_H).moves, [], '最后一行拖到空白处');
    assert.equal(table.querySelectorAll('.dragging, .drop-before, .drop-after').length, 0, '松手后标记全清掉');

    // 待加入、已播放的行拖不起来
    for (const source of [table.querySelector('.pending'), doc.querySelector('.pl-history-list .pl-row')]) {
      const dataTransfer = new FakeDataTransfer();
      fire(source, 'dragstart', { dataTransfer });
      assert.equal(isDragging(), false);
      assert.equal(dataTransfer.types.length, 0);
    }
  });
});

test('拖动中的落点标记：上半截标在前、下半截标在后、空白处标在最后一行后面', async () => {
  await withPanel({}, async ({ panel, table, rowEl, yOf }) => {
    panel.render(view(['a', 'b', 'c']));
    const dataTransfer = new FakeDataTransfer();
    const marks = () =>
      table.children.map((el) => [el.dataset.id, hasClass(el, 'drop-before') ? 'before' : hasClass(el, 'drop-after') ? 'after' : '']);

    fire(rowEl('a'), 'dragstart', { dataTransfer });
    assert.ok(hasClass(rowEl('a'), 'dragging'));
    fire(rowEl('b'), 'dragover', { clientY: yOf('b', 'upper'), dataTransfer });
    assert.deepEqual(marks(), [['a', ''], ['b', 'before'], ['c', '']]);
    fire(rowEl('b'), 'dragover', { clientY: yOf('b', 'lower'), dataTransfer });
    assert.deepEqual(marks(), [['a', ''], ['b', 'after'], ['c', '']], '换半截时旧标记要清掉');
    fire(table, 'dragover', { clientY: ROW_TOP + 10 * ROW_H, dataTransfer });
    assert.deepEqual(marks(), [['a', ''], ['b', ''], ['c', 'after']]);
    fire(rowEl('a'), 'dragend', { dataTransfer });
    assert.deepEqual(marks(), [['a', ''], ['b', ''], ['c', '']]);
    assert.equal(hasClass(rowEl('a'), 'dragging'), false);
  });
});

test('没有编辑权限时 dragstart 不开始拖动，放下也不发请求', async () => {
  await withPanel({}, async ({ panel, calls, rowEl, yOf }) => {
    panel.render(view(['a', 'b'], { canEdit: false }));
    const dataTransfer = new FakeDataTransfer();
    // 行本身不可拖，但拖里面选中的文字之类仍会冒出 dragstart
    fire(rowEl('a').querySelector('.pl-name'), 'dragstart', { dataTransfer });
    assert.equal(panel.isDragging(), false);
    assert.equal(hasClass(rowEl('a'), 'dragging'), false);
    assert.equal(dataTransfer.types.length, 0);
    const over = fire(rowEl('b'), 'dragover', { clientY: yOf('b', 'lower'), dataTransfer });
    assert.equal(over.defaultPrevented, false);
    fire(rowEl('b'), 'drop', { clientY: yOf('b', 'lower'), dataTransfer });
    assert.deepEqual(calls.moves, []);
  });
});

test('拖动期间 render 不动 DOM，松手后补画最后一次 view', async () => {
  await withPanel({}, async ({ panel, calls, rowEl, order, yOf }) => {
    panel.render(view(['a', 'b', 'c']));
    const a = rowEl('a');
    assert.equal(panel.isDragging(), false);

    // 用 dragend 结束（比如按 Esc 取消拖动）
    let dataTransfer = new FakeDataTransfer();
    fire(a, 'dragstart', { dataTransfer });
    assert.equal(panel.isDragging(), true);
    panel.render(view(['a', 'b']));
    panel.render(view(['a', 'b', 'x'], { canEdit: true }));
    assert.deepEqual(order(), ['a', 'b', 'c'], '拖动中重绘会把手里的行换掉，必须等松手');
    assert.equal(rowEl('x'), null);
    fire(a, 'dragend', { dataTransfer });
    assert.equal(panel.isDragging(), false);
    assert.deepEqual(order(), ['a', 'b', 'x'], '补画的是最后一次，不是第一次');
    assert.equal(rowEl('a'), a);

    // 用 drop 结束：先补画，再按最新的列表判断要不要发请求
    dataTransfer = new FakeDataTransfer();
    fire(rowEl('b'), 'dragstart', { dataTransfer });
    panel.render(view(['x', 'a', 'b']));
    assert.deepEqual(order(), ['a', 'b', 'x']);
    fire(rowEl('a'), 'drop', { clientY: yOf('a', 'upper'), dataTransfer });
    assert.deepEqual(order(), ['x', 'a', 'b']);
    assert.deepEqual(calls.moves, [['b', 'a']]);
    fire(rowEl('b'), 'dragend', { dataTransfer });
    assert.deepEqual(order(), ['x', 'a', 'b']);

    // 拖动中这一行被别人删掉：松手时不再发请求，DOM 也跟上
    calls.moves.length = 0;
    dataTransfer = new FakeDataTransfer();
    fire(rowEl('x'), 'dragstart', { dataTransfer });
    panel.render(view(['a', 'b']));
    fire(rowEl('b'), 'drop', { clientY: yOf('b', 'lower'), dataTransfer });
    assert.deepEqual(calls.moves, []);
    assert.deepEqual(order(), ['a', 'b']);
    assert.equal(panel.isDragging(), false);
  });
});

test('从资源管理器拖文件进来：能编辑时高亮并交出文件数组，不能编辑时不接', async () => {
  const f1 = { name: '一.mkv' };
  const f2 = { name: '二.mp4' };

  await withPanel({}, async ({ doc, panel, body, calls, rowEl }) => {
    panel.render(view(['a', 'b']));
    const dataTransfer = new FakeDataTransfer({ types: ['Files'], files: fileList(f1, f2) });
    const over = fire(rowEl('a').querySelector('.pl-name'), 'dragover', { clientY: 0, dataTransfer });
    assert.ok(over.defaultPrevented, '不拦 dragover，文件会被浏览器直接打开');
    assert.equal(dataTransfer.dropEffect, 'copy');
    assert.ok(hasClass(body, 'file-over'));
    assert.equal(panel.isDragging(), false, '外部文件不是行拖动');

    // 在面板里面换元素不算离开
    fire(rowEl('a'), 'dragleave', { relatedTarget: rowEl('b'), dataTransfer });
    assert.ok(hasClass(body, 'file-over'));
    fire(body, 'dragleave', { relatedTarget: doc.body, dataTransfer });
    assert.equal(hasClass(body, 'file-over'), false, '拖出面板就撤掉高亮');
    fire(body, 'dragover', { clientY: 0, dataTransfer });
    assert.ok(hasClass(body, 'file-over'));

    const dropped = fire(rowEl('b'), 'drop', { clientY: 0, dataTransfer });
    assert.ok(dropped.defaultPrevented);
    assert.equal(calls.drops.length, 1);
    assert.ok(Array.isArray(calls.drops[0]), 'FileList 要展开成数组再交出去');
    assert.equal(calls.drops[0].length, 2);
    assert.equal(calls.drops[0][0], f1);
    assert.equal(calls.drops[0][1], f2);
    assert.equal(hasClass(body, 'file-over'), false);
    assert.deepEqual(calls.moves, []);

    // 拖进来的不是文件（比如网页上的一段文字）：不接
    const text = new FakeDataTransfer({ types: ['text/plain'] });
    assert.equal(fire(body, 'dragover', { clientY: 0, dataTransfer: text }).defaultPrevented, false);
    assert.equal(hasClass(body, 'file-over'), false);
    fire(body, 'drop', { clientY: 0, dataTransfer: text });
    assert.equal(calls.drops.length, 1);
  });

  await withPanel({}, async ({ panel, body, calls, rowEl }) => {
    panel.render(view(['a'], { canEdit: false }));
    const dataTransfer = new FakeDataTransfer({ types: ['Files'], files: fileList(f1) });
    assert.equal(fire(rowEl('a'), 'dragover', { clientY: 0, dataTransfer }).defaultPrevented, false);
    assert.equal(hasClass(body, 'file-over'), false);
    const dropped = fire(rowEl('a'), 'drop', { clientY: 0, dataTransfer });
    assert.equal(dropped.defaultPrevented, false);
    assert.deepEqual(calls.drops, [], '没权限的人拖文件进来不能加片');
  });
});

test('行菜单：⋯ 打开、点菜单项回调并收起、再点 ⋯ / Esc / 点外面都会收起', async () => {
  await withPanel({ locale: 'en' }, async ({ doc, win, body, panel, calls, rowEl, openMenus }) => {
    const menuA = [
      { key: 'up', label: '上移', disabled: true },
      { key: 'play', label: '立即播放' },
      { key: 'remove', label: '移除', danger: true },
    ];
    const rows = [row('a', { menu: menuA }), row('b', { menu: [] }), row('c', { menu: [{ key: 'skip', label: '跳过' }] })];
    panel.render(view(rows));

    // 没有菜单项的行不给 ⋯，只留占位
    assert.equal(rowEl('b').querySelector('.pl-more'), null);
    assert.ok(rowEl('b').querySelector('.pl-more-spacer'));

    const moreA = rowEl('a').querySelector('.pl-more');
    assert.equal(moreA.getAttribute('aria-haspopup'), 'menu');
    press(moreA);
    assert.equal(openMenus().length, 1);
    const menu = openMenus()[0];
    assert.equal(menu.parentNode, doc.body, '菜单挂在 document.body 下，不被面板的滚动和裁剪困住');
    assert.equal(body.contains(menu), false);
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.equal(moreA.getAttribute('aria-expanded'), 'true');
    const items = menu.querySelectorAll('.pl-menu-item');
    assert.deepEqual(texts(items), ['Move up', 'Play now', 'Remove']);
    assert.deepEqual(items.map((el) => el.disabled), [true, false, false]);
    assert.equal(items[0].matches('button:not([disabled])'), false);
    assert.deepEqual(items.map((el) => hasClass(el, 'danger')), [false, false, true]);
    assert.equal(doc.activeElement, items[1], '焦点落在第一个可用的菜单项上');

    // 在菜单里按下鼠标不算点外面
    fire(items[1], 'mousedown');
    assert.equal(openMenus().length, 1);
    fire(items[1], 'click');
    assert.deepEqual(calls.actions, [['play', 'a']]);
    assert.equal(openMenus().length, 0, '选完就收起');
    assert.equal(moreA.getAttribute('aria-expanded'), 'false');

    // 再点同一个 ⋯ 收起（mousedown 落在 ⋯ 上不能先把菜单关掉，否则 click 又会把它打开）
    press(moreA);
    assert.equal(openMenus().length, 1);
    press(moreA);
    assert.equal(openMenus().length, 0);
    assert.equal(moreA.getAttribute('aria-expanded'), 'false');

    // 打开别的行的菜单：旧的换掉，同时只有一个
    press(moreA);
    const moreC = rowEl('c').querySelector('.pl-more');
    press(moreC);
    assert.equal(openMenus().length, 1);
    assert.deepEqual(texts(openMenus()[0].querySelectorAll('.pl-menu-item')), ['Skip']);
    assert.equal(moreA.getAttribute('aria-expanded'), 'false');
    assert.equal(moreC.getAttribute('aria-expanded'), 'true');

    // Esc 收起，别的键不收
    fire(doc.activeElement, 'keydown', { key: 'a' });
    assert.equal(openMenus().length, 1);
    fire(doc.activeElement, 'keydown', { key: 'Escape' });
    assert.equal(openMenus().length, 0);

    // 在菜单外按下鼠标收起（点在面板里的别处也算）
    press(moreA);
    fire(rowEl('b'), 'mousedown');
    assert.equal(openMenus().length, 0);
    press(moreA);
    fire(doc.body, 'mousedown');
    assert.equal(openMenus().length, 0);

    // 窗口缩放、面板滚动时菜单位置会错开，直接收起
    press(moreA);
    win.invokeListeners(makeEvent('resize', win, { bubbles: false }));
    assert.equal(openMenus().length, 0);
    press(moreA);
    fire(body, 'scroll', { bubbles: false });
    assert.equal(openMenus().length, 0);

    // 开始拖动时收起
    press(moreA);
    fire(rowEl('a'), 'dragstart', { dataTransfer: new FakeDataTransfer() });
    assert.equal(openMenus().length, 0);
    fire(rowEl('a'), 'dragend', { dataTransfer: new FakeDataTransfer() });

    // 重绘后这一行还在：菜单保持打开；这一行被别人删掉：菜单跟着收起
    press(rowEl('a').querySelector('.pl-more'));
    panel.render(view(rows));
    assert.equal(openMenus().length, 1);
    panel.render(view([rows[1], rows[2]]));
    assert.equal(openMenus().length, 0, '行没了还留着菜单，点下去就是对不存在的条目操作');
    assert.deepEqual(calls.actions, [['play', 'a']], '以上收起都不该触发回调');
  });
});

/**
 * 传输进度会让表格每 400ms 重绘一次。⋯ 跨重绘必须还是同一个按钮，菜单也要按行 id 认按钮：
 * 只认打开时那个旧按钮的话（行在队列和已播放之间搬家就会换元素），
 * 再点新的 ⋯ 会「按下先关、松开又开」，菜单永远收不起来。
 */
test('重绘不换掉 ⋯ 按钮；行搬进已播放换了元素时，菜单改认新按钮', async () => {
  await withPanel({}, async ({ doc, panel, rowEl, historyEl, openMenus }) => {
    const rows = [row('a'), row('b')];
    panel.render(view(rows));
    const more = rowEl('a').querySelector('.pl-more');
    press(more);
    assert.equal(openMenus().length, 1);

    panel.render(view(rows));
    assert.equal(rowEl('a').querySelector('.pl-more'), more, '重绘不能换掉 ⋯，否则正按着的那次点击和键盘焦点都会丢');
    assert.equal(openMenus().length, 1);
    assert.equal(more.getAttribute('aria-expanded'), 'true', '展开状态要标在现在看得见的按钮上');

    // 按下落在 ⋯ 上不能先把菜单关掉，点完应当收起
    fire(more, 'mousedown');
    assert.equal(openMenus().length, 1);
    fire(more, 'click');
    assert.equal(openMenus().length, 0);
    assert.equal(more.getAttribute('aria-expanded'), 'false');

    // 这一行搬进「已播放」：行元素是新的，菜单得改认新按钮
    press(more);
    panel.render(view([rows[1]], { history: [played('a')] }));
    const moved = historyEl('a').querySelector('.pl-more');
    assert.notEqual(moved, more, '前提：搬进已播放是另一个行元素');
    assert.equal(openMenus().length, 1);
    assert.equal(moved.getAttribute('aria-expanded'), 'true');
    press(moved);
    assert.equal(openMenus().length, 0, '认的还是旧按钮的话，这一下会「按下先关、松开又开」');

    // 别的行的 ⋯ 照旧是「换一个菜单」
    press(moved);
    panel.render(view([rows[1]], { history: [played('a')] }));
    press(rowEl('b').querySelector('.pl-more'));
    assert.equal(openMenus().length, 1);
    assert.equal(historyEl('a').querySelector('.pl-more').getAttribute('aria-expanded'), 'false');
    assert.equal(doc.activeElement, openMenus()[0].querySelector('.pl-menu-item'));
  });
});

/**
 * 传输和算哈希时列表每 400ms 重绘一次（下载进度、哈希进度都会顶着节流触发）。
 * 行内按钮要是每次重绘都重建，mousedown 落在旧按钮、按钮随即被摘走，click 根本不派发——
 * 用户点「取消」「允许打开」大约每四次丢一次；带着焦点的按钮被摘掉，焦点还会掉回 body，
 * 传输期间键盘完全没法操作列表。这里盯的是队列行、notice 行、待加入行、已播放行四处。
 */
test('重绘期间按着的行内按钮不换人：松手照样回调，键盘焦点也不丢', async () => {
  await withPanel({}, async ({ doc, panel, table, calls, rowEl, historyEl }) => {
    const notice = { text: '需要允许打开', tone: 'warn', site: 'example.com', actions: [{ key: 'allow', label: '允许' }] };
    const scene = (ratio) =>
      view([row('a', { notice, transfer: { text: '接收中', tone: 'busy', ratio } }), 'b'], {
        pending: [job('j1', { ratio, actions: [{ key: 'cancel-add', label: '取消' }] })],
        history: [played('h1')],
      });

    panel.render(scene(0.1));
    const allow = rowEl('a').querySelector('.pl-act');
    const cancel = table.querySelector('.pending .pl-act');
    const more = rowEl('a').querySelector('.pl-more');
    const playedMore = historyEl('h1').querySelector('.pl-more');

    // 进度在动的重绘：所有行内按钮都还是原来那个节点，且一直待在文档里
    panel.render(scene(0.2));
    assert.equal(rowEl('a').querySelector('.pl-act'), allow, 'notice 行的按钮被换掉了');
    assert.equal(table.querySelector('.pending .pl-act'), cancel, '待加入行的按钮被换掉了');
    assert.equal(rowEl('a').querySelector('.pl-more'), more, '队列行的 ⋯ 被换掉了');
    assert.equal(historyEl('h1').querySelector('.pl-more'), playedMore, '已播放行的 ⋯ 被换掉了');
    assert.equal(cancel.textContent, '取消');
    assert.equal(rowEl('a').querySelector('.pl-progress i').style.width, '20.0%', '进度条照常跟着走');

    // 按下 → 重绘 → 松手：click 仍落在同一个按钮上，回调不能丢
    for (const [btn, expected] of [[allow, ['allow', 'a']], [cancel, ['cancel-add', 'j1']]]) {
      calls.actions.length = 0;
      fire(btn, 'mousedown');
      panel.render(scene(0.3));
      assert.ok(btn.isConnected, '按下的按钮被重绘摘走了，浏览器就不会派发 click');
      fire(btn, 'click');
      assert.deepEqual(calls.actions, [expected]);
    }

    // 键盘焦点：重绘不能把焦点从按钮上抖下来
    for (const btn of [allow, cancel, more, playedMore]) {
      btn.focus();
      panel.render(scene(0.4));
      assert.equal(doc.activeElement, btn, '重绘把焦点丢回了 body，传输期间就没法用键盘操作列表');
    }
  });
});

test('键盘关菜单或选完一项后，焦点回到这一行的 ⋯', async () => {
  await withPanel({}, async ({ doc, panel, calls, rowEl, openMenus }) => {
    const rows = [row('a', { menu: [{ key: 'play', label: '立即播放' }] })];
    panel.render(view(rows));
    press(rowEl('a').querySelector('.pl-more'));
    fire(doc.activeElement, 'keydown', { key: 'Escape' });
    assert.equal(openMenus().length, 0);
    assert.equal(doc.activeElement, rowEl('a').querySelector('.pl-more'));

    // 重绘过也一样：回到现在这个按钮，不是已经摘掉的旧按钮
    press(rowEl('a').querySelector('.pl-more'));
    panel.render(view(rows));
    fire(openMenus()[0].querySelector('.pl-menu-item'), 'click');
    assert.deepEqual(calls.actions, [['play', 'a']]);
    assert.equal(doc.activeElement, rowEl('a').querySelector('.pl-more'));

    // 点外面收起不抢焦点：焦点该去用户点的地方，不能被拽回 ⋯
    press(rowEl('a').querySelector('.pl-more'));
    fire(doc.body, 'mousedown');
    assert.equal(openMenus().length, 0);
    assert.notEqual(doc.activeElement, rowEl('a').querySelector('.pl-more'));
  });
});

test('拖动途中被收回编辑权限：松手不发请求，表格按最新权限补画', async () => {
  await withPanel({}, async ({ panel, calls, rowEl, yOf }) => {
    panel.render(view(['a', 'b', 'c']));
    const dataTransfer = new FakeDataTransfer();
    fire(rowEl('c'), 'dragstart', { dataTransfer });
    assert.equal(panel.isDragging(), true);
    // 房主把我降成游客：这次重绘被推迟到松手
    panel.render(view(['a', 'b', 'c'], { canEdit: false }));
    assert.equal(rowEl('a').draggable, true, '前提：拖动中不重绘');
    fire(rowEl('a'), 'drop', { clientY: yOf('a', 'upper'), dataTransfer });
    assert.deepEqual(calls.moves, [], '没权限了还发，只能等房主拒绝再弹一条报错');
    assert.equal(panel.isDragging(), false);
    assert.equal(rowEl('a').draggable, false);
    assert.equal(rowEl('a').querySelector('.pl-grip'), null);
  });
});

test('已播放行的菜单也能用，回调带的是该行 id', async () => {
  await withPanel({}, async ({ panel, calls, historyEl, openMenus }) => {
    panel.render(view(['a'], { history: [played('h1', { menu: [{ key: 'forget', label: '从已播放中移除' }] })] }));
    press(historyEl('h1').querySelector('.pl-more'));
    const item = openMenus()[0].querySelector('.pl-menu-item');
    assert.equal(item.textContent, '从已播放中移除');
    fire(item, 'click');
    assert.deepEqual(calls.actions, [['forget', 'h1']]);
    assert.equal(openMenus().length, 0);
  });
});

test('菜单贴着 ⋯ 右对齐摆在下方，底部放不下时翻到上方，不越过左边界', async () => {
  await withPanel({}, async ({ doc, panel, rowEl, openMenus }) => {
    panel.render(view(['a']));
    const more = rowEl('a').querySelector('.pl-more');
    const baseLayout = doc.layout;
    doc.layout = (el) => (hasClass(el, 'pl-menu') ? { width: 160, height: 90 } : baseLayout(el));

    more.rect = { left: 290, top: 110, width: 24, height: 24 };
    press(more);
    let menu = openMenus()[0];
    assert.equal(menu.style.left, '154px', '右边缘对齐 ⋯ 的右边缘：314 - 160');
    assert.equal(menu.style.top, '138px', '⋯ 底边下方 4px');
    press(more);

    // 窗口 720 高，下方放不下 → 翻到 ⋯ 上方；太靠左 → 夹在 8px
    more.rect = { left: 76, top: 650, width: 24, height: 24 };
    press(more);
    menu = openMenus()[0];
    assert.equal(menu.style.left, '8px');
    assert.equal(menu.style.top, '556px', '650 - 90 - 4');
  });
});

test('notice 和待加入行里的按钮点下去回调 onAction(key, id)', async () => {
  await withPanel({}, async ({ panel, table, calls, rowEl }) => {
    panel.render(
      view(
        [
          row('a', {
            notice: {
              text: '需要允许打开',
              tone: 'warn',
              site: 'example.com',
              actions: [
                { key: 'allow', label: '允许' },
                { key: 'skip-me', label: '这一部我先跳过', primary: true },
              ],
            },
          }),
          'b',
        ],
        { pending: [job('job-1', { actions: [{ key: 'cancel-add', label: '取消' }] })] }
      )
    );

    const [allow, skip] = rowEl('a').querySelectorAll('.pl-act');
    assert.ok(hasClass(skip, 'primary-lite'));
    assert.equal(hasClass(allow, 'primary-lite'), false);
    press(allow);
    press(skip);
    assert.deepEqual(calls.actions, [['allow', 'a'], ['skip-me', 'a']]);

    // 待加入的行还没有条目 id，用任务 key 作 id
    const cancel = table.querySelector('.pending .pl-act');
    assert.equal(cancel.textContent, '取消');
    press(cancel);
    assert.deepEqual(calls.actions.at(-1), ['cancel-add', 'job-1']);

    // 点在行的其他地方不触发
    const count = calls.actions.length;
    press(rowEl('a').querySelector('.pl-name'));
    press(rowEl('b'));
    assert.equal(calls.actions.length, count);
    assert.equal(rowEl('b').querySelector('.pl-notice'), null, '没有 notice 的行不画提示块');
  });
});

test('进度条只在 ratio 严格介于 0 和 1 之间时画，宽度按百分比', async () => {
  await withPanel({}, async ({ panel, table, rowEl }) => {
    const transfer = (ratio) => ({ text: '已收完', tone: 'ok', ratio });
    const bar = (el) => el.querySelector('.pl-progress i');
    panel.render(
      view(
        [
          row('half', { transfer: transfer(0.256) }),
          row('zero', { transfer: transfer(0) }),
          row('full', { transfer: transfer(1) }),
          row('none', { transfer: { text: '排队中' } }),
          row('text', { transfer: transfer('0.5') }),
          row('idle'),
        ],
        { pending: [job('p-half', { ratio: 0.5 }), job('p-full', { ratio: 1 }), job('p-zero', { ratio: 0 })] }
      )
    );

    assert.equal(bar(rowEl('half')).style.width, '25.6%');
    assert.ok(rowEl('half').querySelector('.pl-transfer.ok'));
    for (const id of ['zero', 'full', 'none', 'text']) {
      assert.equal(rowEl(id).querySelector('.pl-progress'), null, `${id} 不该有进度条`);
      assert.ok(rowEl(id).querySelector('.pl-transfer'), `${id} 的状态文字照常显示`);
    }
    assert.equal(rowEl('idle').querySelector('.pl-transfer'), null);
    assert.equal(rowEl('idle').querySelector('.pl-state').children.length, 0);

    const pending = (key) => table.querySelector(`.pl-row[data-pending="${key}"]`);
    assert.equal(bar(pending('p-half')).style.width, '50.0%');
    assert.equal(pending('p-full').querySelector('.pl-progress'), null);
    assert.equal(pending('p-zero').querySelector('.pl-progress'), null);

    // 同一行收完：进度条跟着撤掉
    const half = rowEl('half');
    panel.render(view([row('half', { transfer: transfer(1) })]));
    assert.equal(rowEl('half'), half);
    assert.equal(half.querySelector('.pl-progress'), null);
  });
});

test('banner 有内容时显示并翻译，空串或缺省时隐藏', async () => {
  await withPanel({ locale: 'en' }, async ({ panel, banner }) => {
    assert.ok(hasClass(banner, 'hidden'), '初始是收起的');
    panel.render(view(['a'], { banner: '房主已离开，列表暂停更新' }));
    assert.equal(hasClass(banner, 'hidden'), false);
    assert.equal(banner.textContent, 'The host left; the playlist is no longer updated');

    panel.render(view(['a'], { banner: '房主已离开，这个房间结束了' }));
    assert.equal(banner.children.length, 1, '换文案不能叠在旧文案后面');
    assert.equal(banner.textContent, 'The host left; this room has ended');

    panel.render(view(['a'], { banner: '' }));
    assert.ok(hasClass(banner, 'hidden'));
    assert.equal(banner.textContent, '');

    const withoutBanner = view(['a']);
    delete withoutBanner.banner;
    panel.render(withoutBanner);
    assert.ok(hasClass(banner, 'hidden'));
  });
});

test('假 DOM 节点出现在失败的断言里时，报错信息只描述节点自己', () => {
  // 节点间的引用要是可枚举，这棵 30 个节点的小树一次失败就生成 130 万字符的报错；
  // 面板用例里的树更大，曾经一次失败吃掉 20 多 GB 内存
  const doc = new FakeDocument();
  let parent = doc.body;
  for (let depth = 0; depth < 6; depth++) {
    const level = doc.createElement('div');
    for (let i = 0; i < 4; i++) level.append(doc.createElement('span'));
    parent.append(level);
    parent = level;
  }
  let message = '';
  try {
    assert.equal(parent.children[0], null);
  } catch (err) {
    message = err.message;
  }
  assert.ok(message.length > 0, '断言本该失败');
  assert.ok(message.length < 2000, `报错信息有 ${message.length} 个字符`);
});

test('夹具用完会还原全局对象和界面语言，出错也一样', async () => {
  const i18n = await import(I18N);
  const snapshot = () => DOM_GLOBALS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const before = snapshot();
  const locale = i18n.currentLocale();

  await withPanel({ locale: 'en' }, async ({ doc }) => {
    assert.equal(globalThis.document, doc);
    assert.equal(i18n.currentLocale(), 'en');
    assert.ok(doc.createElement('div') instanceof Node, '组件靠 instanceof Node 区分节点和文字');
  });
  assert.deepEqual(snapshot(), before);
  assert.equal(i18n.currentLocale(), locale);

  await assert.rejects(
    withPanel({ locale: 'en' }, async () => {
      throw new Error('故意失败');
    }),
    /故意失败/
  );
  assert.deepEqual(snapshot(), before);
  assert.equal(i18n.currentLocale(), locale);
});
