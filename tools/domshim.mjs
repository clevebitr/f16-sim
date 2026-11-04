/**
 * domshim.mjs — 极简 DOM 桩，用于在 Node 中冒烟测试 UI 层
 * 目的：捕获 main.js / 渲染器中的运行时错误（不是像素级验证）
 */

function makeCtx() {
  const target = {
    canvas: null,
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, stroke() {}, clip() {},
    fillText() {}, setLineDash() {},
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

let elCounter = 0;

function makeEl(tag = 'div') {
  const self = {
    tagName: tag.toUpperCase(),
    id: '',
    nodeType: 1,
    _html: '',
    textContent: '',
    style: new Proxy({ setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; } }, { get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } }),
    dataset: {},
    children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !this._s.has(c) : !!force;
        if (on) this._s.add(c); else this._s.delete(c);
        return on;
      },
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    setAttribute() {}, getAttribute() { return null; },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    focus() {}, blur() {},
    get clientWidth() { return 300; },
    get clientHeight() { return 200; },
    get offsetParent() { return makeEl(); },
    get offsetHeight() { return 140; },
    get offsetWidth() { return 300; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    get parentElement() { return this._parent || makeEl(); },
    getContext: () => makeCtx(),
    width: 300,
    height: 200,
  };
  self._uid = ++elCounter;
  return self;
}

const registry = new Map();
function elFor(sel) {
  if (!registry.has(sel)) registry.set(sel, makeEl(sel.startsWith('#') ? 'div' : 'div'));
  return registry.get(sel);
}

const body = makeEl('body');
const doc = {
  body,
  documentElement: makeEl('html'),
  getElementById: (id) => {
    const el = elFor('#' + id);
    el.id = id;
    return el;
  },
  querySelector: (sel) => elFor(sel),
  querySelectorAll: (sel) => {
    // 常见选择器返回空列表即可（初始化会被跳过）
    if (sel === '.menu-item' || sel === '.scenario' || sel === '.stage-pane') {
      return [makeEl(), makeEl()];
    }
    return [];
  },
  createElement: (t) => makeEl(t),
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};

const rafQueue = [];
const win = {
  devicePixelRatio: 2,
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
  cancelAnimationFrame() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  },
  performance: { now: () => Date.now() },
};

globalThis.window = win;
globalThis.document = doc;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = win.requestAnimationFrame;
globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
if (typeof globalThis.performance === 'undefined') globalThis.performance = win.performance;

export function pumpFrames(n, dtMs = 16.7) {
  for (let i = 0; i < n; i++) {
    const q = rafQueue.splice(0, rafQueue.length);
    if (!q.length) break;
    const t = performance.now() + i * dtMs;
    for (const cb of q) cb(t);
  }
}

export function fakeTime() {
  // 让 performance.now() 单调递增
  let t = 0;
  performance.now = () => (t += 16.7);
}
