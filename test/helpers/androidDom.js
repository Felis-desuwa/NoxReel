'use strict';

/**
 * 安卓观众端（app-android.js）测试用的假 DOM。
 *
 * 不起 WebView：app-android.js 只用 document.getElementById / createElement、
 * textContent、classList、setAttribute、replaceChildren 和事件这几样，这里如实做一遍。
 * 聊天和弹幕会真的建节点、改 class、读 clientWidth，所以这些都得是真行为，
 * 不能像早期那样用空壳对象糊过去。
 *
 * 两个用得着的约定：
 *  - textContent 不会自动汇总子节点（真 DOM 会），要看整行文字用下面的 textOf。
 *  - clientWidth / clientHeight 默认是 0，弹幕那种要量尺寸的元素由测试自己摆。
 */

class FakeElement {
  constructor(tag, id = '') {
    this.tagName = tag;
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.className = '';
    this.textContent = '';
    this.style = {};
    this.children = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.firstElementChild = { style: {} };
    const classes = () => new Set(String(this.className).split(/\s+/).filter(Boolean));
    const write = (set) => {
      this.className = [...set].join(' ');
    };
    this.classList = {
      add: (...names) => {
        const set = classes();
        for (const name of names) set.add(name);
        write(set);
      },
      remove: (...names) => {
        const set = classes();
        for (const name of names) set.delete(name);
        write(set);
      },
      contains: (name) => classes().has(name),
      toggle: (name, force) => {
        const set = classes();
        const on = force === undefined ? !set.has(name) : !!force;
        if (on) set.add(name);
        else set.delete(name);
        write(set);
        return on;
      },
    };
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ type, ...event });
  }
  click() {
    this.dispatch('click');
  }
  select() {}
}

function fakeDocument() {
  const byId = new Map();
  return {
    documentElement: { lang: '' },
    body: {},
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement('div', id));
      return byId.get(id);
    },
    createElement(tag) {
      return new FakeElement(tag);
    },
    createTextNode(text) {
      return { nodeValue: text };
    },
    execCommand() {},
  };
}

/** 节点树上的可见文字（假 DOM 的 textContent 不汇总子节点）。 */
function textOf(node) {
  if (!node) return '';
  if (node.children?.length) return node.children.map(textOf).join('');
  return node.textContent || '';
}

/** 一个容器里每个子节点的 class 和文字，断言列表时好用。 */
const rowsOf = (node) => node.children.map((child) => ({ className: child.className, text: textOf(child) }));

module.exports = { FakeElement, fakeDocument, textOf, rowsOf };
