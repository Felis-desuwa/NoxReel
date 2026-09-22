import { SKIP_ATTR, translate as t } from '../lib/i18n.js';

/**
 * 建 DOM 的小工具。界面文案一律过 t()；用户写的东西（昵称、片名、聊天）用 raw，
 * 既不过 t()，也打上跳过标记，自动翻译的 MutationObserver 不会再去碰它 ——
 * 否则昵称叫「播放」的人在英文界面里会变成 Play。
 */

export const $ = (id) => document.getElementById(id);

const TRANSLATED_ATTRS = ['placeholder', 'title', 'aria-label'];

const trOf = (options) => (options.raw ? (v) => String(v) : t);

/** 节点 → 上一轮由这里设过的特性名。重绘时把这一轮不再要的删掉，别人加的（比如 aria-expanded）不碰。 */
const ownedAttrs = new WeakMap();

/** 把 options 落到节点上：make() 用它填新节点，patch() 用它原地更新旧节点。 */
function applyOptions(node, options) {
  const tr = trOf(options);
  if (options.raw) node.setAttribute(SKIP_ATTR, '');
  if (options.id) node.id = options.id;
  if (options.className || node.className) node.className = options.className || '';
  if (options.text !== undefined) {
    // 文字没变就不写：patch() 每次重画都会把整列（聊天最多 300 行）过一遍，照写的话每一行都是一次
    // DOM 改动，英文界面下还要让自动翻译的 MutationObserver 把整列再翻一遍
    const text = tr(options.text);
    if (node.textContent !== text) node.textContent = text;
  }
  const owned = new Set();
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      owned.add(String(name).toLowerCase());
      node.setAttribute(name, TRANSLATED_ATTRS.includes(name) ? tr(value) : String(value));
    }
  }
  for (const name of ownedAttrs.get(node) || []) if (!owned.has(name)) node.removeAttribute(name);
  ownedAttrs.set(node, owned);
  if (options.style) Object.assign(node.style, options.style);
  if (options.props) Object.assign(node, options.props);
}

/**
 * @param {string} tag
 * @param {{id?:string, className?:string, text?:string, attrs?:object, style?:object, props?:object, raw?:boolean}} options
 *   raw：整个元素都是用户内容（子节点也是），不翻译、打跳过标记
 */
export function make(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  applyOptions(node, options);
  const tr = trOf(options);
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(tr(child)));
  }
  return node;
}

/** 把 parent 的子节点摆成 nodes 这个顺序：已经在位的一个都不动，多余的摘掉。 */
export function place(parent, nodes) {
  const keep = new Set(nodes);
  for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
  nodes.forEach((node, i) => {
    if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] || null);
  });
  return parent;
}

/** 父节点 → Map(key → 子节点)，patch() 靠它跨重绘认出同一个子节点。 */
const keyedKids = new WeakMap();

/**
 * 按 key 原地更新子节点：命中的还是同一个 DOM 对象、留在文档里不动，只改文案和特性；
 * 没命中的才新建，多出来的摘掉。像 replace() 那样整片重建会让重绘吃掉进行中的点击
 * （按下的那个按钮已经被换走，click 根本不派发），也会把键盘焦点丢回 body ——
 * 传输和算哈希时列表每 400ms 重绘一次，行内按钮必须跨重绘留住。
 * spec：{ key, tag（默认 span）, children: [spec], ...make() 的选项 }；null / false 跳过。
 */
export function patch(parent, specs) {
  const cache = keyedKids.get(parent) || new Map();
  const nodes = [];
  const seen = new Set();
  for (const spec of specs.flat(Infinity)) {
    if (spec == null || spec === false) continue;
    if (seen.has(spec.key)) throw new Error(`patch：同一层出现重复的 key「${spec.key}」`);
    seen.add(spec.key);
    const tag = String(spec.tag || 'span');
    let node = cache.get(spec.key);
    if (!node || node.tagName !== tag.toUpperCase()) {
      node = document.createElement(tag);
      cache.set(spec.key, node);
    }
    applyOptions(node, spec);
    if (spec.children) patch(node, spec.children);
    nodes.push(node);
  }
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
  keyedKids.set(parent, cache);
  return place(parent, nodes);
}

export function replace(target, ...children) {
  const node = typeof target === 'string' ? $(target) : target;
  node.replaceChildren(
    ...children
      .flat(Infinity)
      .filter((child) => child != null && child !== false)
      .map((child) => (child instanceof Node ? child : document.createTextNode(t(child))))
  );
  return node;
}

/** 用户内容的一小段文字，嵌在界面文案中间用。 */
export const rawText = (text, className = '') => make('span', { raw: true, className, text: String(text ?? '') });
