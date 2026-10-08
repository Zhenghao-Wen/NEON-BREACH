/**
 * tools/domsim.mjs — the minimal browser surface needed to run the game's
 * non-rendering code paths under Node (used by the verification tools).
 */
export function installDomShim() {
  const grad = () => ({ addColorStop() {} });
  const ctx2d = () => new Proxy({
    canvas: null,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    createLinearGradient: grad,
    createRadialGradient: grad,
    measureText: () => ({ width: 8 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });

  const makeCanvas = () => ({
    nodeType: 1,
    tagName: 'CANVAS',
    width: 300,
    height: 150,
    style: {},
    clientWidth: 300,
    clientHeight: 150,
    getContext: (kind) => (kind === '2d' ? ctx2d() : null),
    addEventListener() {},
    removeEventListener() {},
    toDataURL: () => 'data:,',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }),
  });

  const listeners = new Map();
  const el = (id) => {
    const node = {
      id,
      nodeType: 1,
      tagName: id === 'minimap' || id === 'gl' ? 'CANVAS' : 'DIV',
      style: {},
      width: 220,
      height: 220,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      textContent: '',
      innerHTML: '',
      appendChild() {},
      removeChild() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      dataset: {},
      setAttribute() {},
      getAttribute: () => null,
      offsetWidth: 10,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }),
    };
    node.getContext = (kind) => (kind === '2d' ? ctx2d() : null);
    return node;
  };

  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : el(tag)),
    createElementNS: (ns, tag) => (tag === 'canvas' ? makeCanvas() : el(tag)),
    getElementById: (id) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener() {},
    body: el('body'),
    documentElement: el('html'),
    pointerLockElement: null,
    exitPointerLock() {},
    hidden: false,
  };
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    location: { href: 'http://localhost/', search: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const nav = { userAgent: 'node', maxTouchPoints: 0, platform: 'node' };
  try { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true }); } catch { /* getter-only on some versions */ }
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
  globalThis.HTMLCanvasElement = function () {};
  globalThis.self = globalThis.window;
  if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
}
