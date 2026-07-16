/** 够用就好的事件发射器。 */
export class Emitter {
  constructor() {
    this._h = new Map();
  }

  on(name, fn) {
    if (!this._h.has(name)) this._h.set(name, new Set());
    this._h.get(name).add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }

  off(name, fn) {
    this._h.get(name)?.delete(fn);
  }

  emit(name, payload) {
    const set = this._h.get(name);
    if (!set) return;
    // 复制一份再遍历：回调里可能会 off 掉自己
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[emitter] "${name}" 处理器抛错:`, e);
      }
    }
  }

  removeAll() {
    this._h.clear();
  }
}
