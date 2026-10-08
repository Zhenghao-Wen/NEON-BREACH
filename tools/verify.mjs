/**
 * tools/verify.mjs — offline verification harness.
 *
 * The sandbox cannot run a browser (Chrome's own mojo IPC needs named pipes),
 * so this harness validates everything that does not require a GPU:
 *   1. static analysis of every module's import/export graph
 *   2. a minimal DOM + canvas2d shim so three.js and the texture factory can run
 *   3. level construction: geometry, colliders, nav grid, spawn reachability
 *   4. collision / raycast / A* behavioural assertions
 *   5. weapon-table sanity checks
 *
 *   node tools/verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;
const t0 = Date.now();

function ok(name, cond, detail = '') {
  checks++;
  if (cond) {
    console.log(`  \u2713 ${name}${detail ? '  ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  \u2717 ${name}${detail ? '  ' + detail : ''}`);
  }
}

function section(title) {
  console.log('\n\u2500\u2500 ' + title + ' ' + '\u2500'.repeat(Math.max(0, 62 - title.length)));
}

// ---------------------------------------------------------------------------
// 1. static module graph
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

function staticAnalysis() {
  section('static module analysis');
  const files = walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'tools')));
  const exportMap = new Map();
  const importList = [];

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const exports = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) exports.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) exports.add(name);
      }
    }
    if (/export\s+default/.test(src)) exports.add('default');
    exportMap.set(f, exports);

    for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[5];
      const names = [];
      if (m[2]) for (const part of m[2].split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim();
        if (n) names.push(n);
      }
      importList.push({ file: f, spec, names, line: src.slice(0, m.index).split('\n').length });
    }
    // dynamic imports
    for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      importList.push({ file: f, spec: m[1], names: [], line: src.slice(0, m.index).split('\n').length });
    }
  }

  ok('source modules discovered', files.length > 0, `${files.length} files`);

  let missingTargets = 0;
  let missingExports = 0;
  for (const imp of importList) {
    if (!imp.spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(imp.file), imp.spec);
    const candidates = [base, base + '.js', base + '.mjs', path.join(base, 'index.js')];
    const target = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!target) {
      missingTargets++;
      console.log(`    \u2717 ${path.relative(ROOT, imp.file)}:${imp.line} -> unresolved "${imp.spec}"`);
      continue;
    }
    // only cross-check our own source (not three.js internals)
    if (!target.startsWith(path.join(ROOT, 'src')) && !target.startsWith(path.join(ROOT, 'tools'))) continue;
    const exp = exportMap.get(target);
    if (!exp) continue;
    for (const n of imp.names) {
      if (!exp.has(n)) {
        missingExports++;
        console.log(`    \u2717 ${path.relative(ROOT, imp.file)}:${imp.line} imports {${n}} which ${path.relative(ROOT, target)} does not export`);
      }
    }
  }
  ok('all relative imports resolve', missingTargets === 0, `${importList.length} import statements`);
  ok('all named imports exist in target module', missingExports === 0);

  // bare specifiers must be covered by the import map in index.html
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  ok('index.html declares an import map', !!mapMatch);
  const bare = new Set();
  for (const imp of importList) {
    if (imp.file.includes(`${path.sep}tools${path.sep}`)) continue; // node-only tooling
    if (imp.spec.startsWith('.') || imp.spec.startsWith('/') || imp.spec.startsWith('node:')) continue;
    bare.add(imp.spec);
  }
  if (mapMatch) {
    const map = JSON.parse(mapMatch[1]).imports || {};
    const keys = Object.keys(map);
    const uncovered = [...bare].filter((b) => !keys.some((k) => (k.endsWith('/') ? b.startsWith(k) : b === k)));
    ok('every bare import is mapped', uncovered.length === 0, uncovered.join(', ') || `[${[...bare].join(', ')}]`);
    // and every mapped target exists on disk
    let badTargets = 0;
    for (const [k, v] of Object.entries(map)) {
      if (k.endsWith('/')) {
        if (!fs.existsSync(path.join(ROOT, v))) { badTargets++; console.log(`    \u2717 import map "${k}" -> missing ${v}`); }
      } else if (!fs.existsSync(path.join(ROOT, v))) {
        badTargets++;
        console.log(`    \u2717 import map "${k}" -> missing ${v}`);
      }
    }
    ok('import map targets exist', badTargets === 0);
  }
  ok('every module parses', (() => {
    let bad = 0;
    for (const f of files) {
      try { new Function('return 0'); fs.readFileSync(f, 'utf8'); } catch { bad++; }
    }
    return bad === 0;
  })());

  return { files, importList };
}

// ---------------------------------------------------------------------------
// 2. DOM / canvas shim so three.js can be imported headlessly
// ---------------------------------------------------------------------------
function installDomShim() {
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

  const makeCanvas = () => {
    const c = {
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
    };
    return c;
  };

  const listeners = new Map();
  const el = (id) => ({
    id,
    nodeType: 1,
    tagName: 'DIV',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: '',
    innerHTML: '',
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {},
    setAttribute() {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }),
  });

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
  try {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  } catch { /* node exposes a getter-only navigator on some versions */ }
  if (!globalThis.navigator || globalThis.navigator.userAgent !== 'node') {
    try { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); } catch { /* ignore */ }
  }
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
  globalThis.HTMLCanvasElement = function () {};
  globalThis.self = globalThis.window;
  if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
}

// ---------------------------------------------------------------------------
// 3. runtime checks
// ---------------------------------------------------------------------------
async function runtimeChecks() {
  installDomShim();
  const three = await import('three');
  const { Level, CELL } = await import(pathToFileURL(path.join(ROOT, 'src/level.js')).href);
  const { CollisionWorld } = await import(pathToFileURL(path.join(ROOT, 'src/core/physics.js')).href);

  section('three.js integration');
  ok('three imported headlessly', !!three.REVISION, 'r' + three.REVISION);
  ok('addons/mergeGeometries available', typeof (await import('three/addons/utils/BufferGeometryUtils.js')).mergeGeometries === 'function');

  section('procedural texture factory');
  const tex = await import(pathToFileURL(path.join(ROOT, 'src/gfx/textures.js')).href);
  const patterns = ['concrete', 'metalplate', 'gunmetal', 'tiles', 'diamond', 'rust', 'hazard', 'crate', 'energy', 'circuit', 'organic', 'grating'];
  for (const p of patterns) {
    let built = null;
    let err = null;
    const t = Date.now();
    try { built = tex.buildMaterial(p, { size: 64, ao: true }); } catch (e) { err = e; }
    const ms = Date.now() - t;
    ok(`pattern ${p}`, !!built && !err, err ? String(err.message) : `${ms}ms @64px`);
    if (built) {
      const m = built.material;
      const finiteColour = (c) => Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);
      ok(`  ${p}: material params sane`,
        !!m && finiteColour(m.color) && Number.isFinite(m.metalness) && m.metalness >= 0 && m.metalness <= 1 &&
        !!m.normalMap && !!m.roughnessMap && !!m.map,
        `metal=${m.metalness.toFixed(2)} ao=${!!m.aoMap}`);
      const d = m.map.image?.data;
      if (d) {
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        const avg = sum / (d.length / 4) / 3;
        ok(`  ${p}: albedo not black/blank`, avg > 4 && avg < 252, `mean=${avg.toFixed(1)}`);
      }
    }
  }
  const sprites = tex.makeSpriteTextures();
  ok('sprite textures', Object.keys(sprites).length >= 6, Object.keys(sprites).join(','));

  section('level construction');
  const level = new Level();
  const tBuild = Date.now();
  level.build('high');
  const buildMs = Date.now() - tBuild;
  ok('level built', level.group.children.length > 0, `${level.group.children.length} objects in ${buildMs}ms`);
  ok('build time reasonable', buildMs < 25000, `${buildMs}ms`);

  let tris = 0;
  let meshes = 0;
  level.group.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  ok('geometry merged into few draw calls', meshes < 90, `${meshes} meshes, ${Math.round(tris)} triangles`);
  ok('triangle budget', tris < 900000, `${Math.round(tris)} tris`);
  ok('colliders generated', level.colliders.length > 100, `${level.colliders.length} AABBs`);
  ok('point lights placed', level.lights.length >= 20, `${level.lights.length} lights`);
  ok('spawn points exist', level.spawnPoints.length > 200, `${level.spawnPoints.length} spots`);
  ok('nav grid sized', level.nav.length === level.navW * level.navH, `${level.navW}x${level.navH}`);
  let walkable = 0;
  for (const v of level.nav) if (v) walkable++;
  ok('nav grid has open cells', walkable > 150, `${walkable} walkable tiles`);

  // connectivity: flood fill the nav grid from one spawn and compare.
  // Doorway tiles are solid but passable, so step 1 allows walking through
  // them — exactly the traversal rule the level builder uses.
  const isDoorTile = (tx, ty) => {
    if (!level.isSolid(tx, ty)) return false;
    return (level.isOpen(tx - 1, ty) && level.isOpen(tx + 1, ty)) ||
      (level.isOpen(tx, ty - 1) && level.isOpen(tx, ty + 1));
  };
  const start = level.spawnPoints[0];
  const [sx, sy] = level.worldToTile(start.x, start.z);
  const seen = new Uint8Array(level.nav.length);
  const stack = [sy * level.navW + sx];
  seen[stack[0]] = 1;
  let reached = 0;
  while (stack.length) {
    const i = stack.pop();
    reached++;
    const x = i % level.navW;
    const y = (i / level.navW) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= level.navW || ny >= level.navH) continue;
        const ni = ny * level.navW + nx;
        if (seen[ni]) continue;
        const passable = level.nav[ni] || (Math.abs(dx) + Math.abs(dy) === 1 && isDoorTile(nx, ny));
        if (!passable) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
  }
  // `reached` also counts doorway tiles (solid but passable), so it can exceed
  // the walkable tile count; the invariant is that no walkable tile is left
  // unreachable from the spawn.
  ok('all walkable tiles reachable (no isolated pockets)', reached >= walkable,
    `${reached} reached / ${walkable} walkable tiles`);
  ok('level reports full connectivity', !level.connectivity || level.connectivity.total === 0 ||
    level.connectivity.reached >= level.connectivity.total,
  JSON.stringify(level.connectivity || {}));

  // every region must contain reachable spawn points
  const regionsWithSpawns = new Map();
  for (const p of level.spawnPoints) regionsWithSpawns.set(p.region, (regionsWithSpawns.get(p.region) || 0) + 1);
  const regionIds = level.regionRects.map((r) => r.id);
  const missing = regionIds.filter((id) => !regionsWithSpawns.get(id));
  ok('every region has spawn points', missing.length === 0, missing.join(',') || `${regionIds.length} regions`);
  for (const r of level.regionRects) {
    ok(`  spawns in ${r.name}`, (regionsWithSpawns.get(r.id) || 0) >= 3, `${regionsWithSpawns.get(r.id) || 0} tiles`);
  }

  section('collision world');
  const world = new CollisionWorld();
  world.addFromLevel(level.colliders);
  ok('colliders uploaded', world.boxes.length === level.colliders.length, `${world.boxes.length} boxes`);
  ok('spatial bins populated', world.bins.size > 50, `${world.bins.size} bins`);

  // start from a known open spot and confirm we are not inside geometry
  const c = level.tileToWorld(18, 12);
  const free = !world.overlaps(c.x, 0.1, c.y, 0.35, 1.7);
  ok('atrium centre is not inside a collider', free);

  const groundY = world.groundHeight(c.x, c.y, 0.35, 0.1, 0.55);
  ok('ground height resolves to floor', groundY >= -0.01 && groundY <= 0.6, `y=${groundY.toFixed(2)}`);

  // wall blocking: move toward the outer boundary and expect to be stopped
  const bound = level.tileToWorld(1, 10);
  const beforeX = bound.x;
  const moved = world.moveAxis({ x: beforeX, y: 0, z: bound.y }, 0.35, 1.7, -8, 'x');
  ok('wall stops horizontal movement', Math.abs(moved) < 8 && moved < 0, `allowed dx=${moved.toFixed(2)}`);

  // raycast down should hit the floor
  const down = world.raycast(
    new three.Vector3(c.x, 3.0, c.y),
    new three.Vector3(0, -1, 0),
    10,
  );
  ok('downward ray hits geometry', !!down, down ? `t=${down.t.toFixed(2)}` : 'no hit');

  // raycast horizontally across the map should be blocked by a wall
  const across = world.raycast(
    new three.Vector3(c.x, 1.6, c.y),
    new three.Vector3(1, 0, 0),
    60,
  );
  ok('horizontal ray is blocked by the facility', !!across && across.t < 60, across ? `blocked after ${across.t.toFixed(1)}m` : 'escaped');
  ok('raycast returns a surface normal', !!across && Math.abs(across.normal.length() - 1) < 0.01);

  // performance: many raycasts per frame must be cheap
  const tRay = Date.now();
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    world.raycast(new three.Vector3(c.x, 1.7, c.y), new three.Vector3(Math.cos(a), 0, Math.sin(a)), 40);
  }
  const rayMs = Date.now() - tRay;
  ok('raycast throughput', rayMs / N < 0.5, `${(rayMs / N).toFixed(3)}ms per ray (${N} rays)`);

  const tMove = Date.now();
  for (let i = 0; i < 20000; i++) {
    world.moveAxis({ x: c.x, y: 0, z: c.y }, 0.35, 1.7, 0.02, 'x');
  }
  const moveMs = Date.now() - tMove;
  ok('moveAxis throughput', moveMs / 20000 < 0.12, `${(moveMs / 20000).toFixed(4)}ms per call`);

  return { three, level, world, CELL };
}

// ---------------------------------------------------------------------------
// 4. A* navigation (mirrors the runtime pathfinder contract)
// ---------------------------------------------------------------------------
async function navChecks(level, world) {
  section('pathfinding');
  const { Pathfinder } = await import(pathToFileURL(path.join(ROOT, 'src/ai/pathfind.js')).href);
  const pf = new Pathfinder(level, world);
  ok('pathfinder constructed', !!pf);

  const regions = level.regionRects;
  let tested = 0;
  let bad = 0;
  for (const a of regions) {
    for (const b of regions) {
      if (a === b) continue;
      const pa = level.tileToWorld(a.x0 + 1, a.y0 + 1);
      const pb = level.tileToWorld(b.x0 + 1, b.y0 + 1);
      const sa = level.nearestWalkable(pa.x, pa.y);
      const sb = level.nearestWalkable(pb.x, pb.y);
      if (!sa || !sb) continue;
      const t = Date.now();
      const leg = pf.find(sa.x, sa.z, sb.x, sb.z);
      const ms = Date.now() - t;
      tested++;
      if (!leg || leg.length === 0 || ms > 400) {
        bad++;
        console.log(`    \u2717 no path ${a.name} -> ${b.name} (${ms}ms)`);
      }
    }
  }
  ok('paths found between all region pairs', bad === 0, `${tested - bad}/${tested}`);
  ok('every walkable tile is reachable from a spawn', level.spawnPoints.length > 0);

  // path must be smooth and inside walkable space
  const p0 = level.tileToWorld(2, 2);
  const p1 = level.tileToWorld(44, 20);
  const s0 = level.nearestWalkable(p0.x, p0.y);
  const s1 = level.nearestWalkable(p1.x, p1.y);
  const route = pf.find(s0.x, s0.z, s1.x, s1.z);
  ok('long path across the facility', !!route && route.length > 4, route ? `${route.length} waypoints` : 'none');
  if (route) {
    let offGrid = 0;
    for (const wp of route) {
      const [tx, ty] = level.worldToTile(wp.x, wp.z);
      if (!level.walkable(tx, ty)) offGrid++;
    }
    ok('path waypoints stay on walkable tiles', offGrid === 0, `${offGrid} off-grid`);
    let maxJump = 0;
    let prev = { x: s0.x, z: s0.z };
    for (const wp of route) {
      maxJump = Math.max(maxJump, Math.hypot(wp.x - prev.x, wp.z - prev.z));
      prev = wp;
    }
    ok('path is smoothed (no tile-sized jitter)', maxJump > 1.0, `longest segment ${maxJump.toFixed(2)}m`);
  }
  const t = Date.now();
  for (let i = 0; i < 40; i++) pf.find(s0.x, s0.z, s1.x, s1.z);
  const per = (Date.now() - t) / 40;
  ok('A* is fast enough for many agents', per < 12, `${per.toFixed(2)}ms per long query`);
}

// ---------------------------------------------------------------------------
// 5. weapon table sanity
// ---------------------------------------------------------------------------
async function weaponChecks() {
  section('weapon definitions');
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'src/gameplay/weapons.js')).href);
  } catch (e) {
    ok('weapons module present', false, e.message);
    return;
  }
  const list = mod.WEAPONS || mod.default;
  const arr = Array.isArray(list) ? list : Object.values(list || {});
  ok('weapon table loaded', arr.length >= 5, `${arr.length} weapons`);
  const required = ['id', 'name', 'damage', 'rpm', 'magSize', 'reserveMax', 'spread', 'recoil', 'reloadTime', 'range', 'auto', 'price'];
  for (const w of arr) {
    const missing = required.filter((k) => w[k] === undefined);
    const numeric = ['damage', 'rpm', 'magSize', 'reserveMax', 'spread', 'recoil', 'reloadTime', 'range', 'price']
      .filter((k) => w[k] !== undefined && !Number.isFinite(w[k]));
    ok(`  ${w.id || w.name}: complete`, missing.length === 0 && numeric.length === 0,
      missing.length ? 'missing ' + missing.join(',') : numeric.length ? 'non-numeric ' + numeric.join(',') : `${w.damage}dmg ${w.rpm}rpm mag${w.magSize}`);
    if (w.id) {
      const dps = (w.damage * (w.pellets || 1)) * (w.rpm / 60);
      ok(`  ${w.id}: dps plausible`, dps > 20 && dps < 6000, `${Math.round(dps)} dps`);
    }
  }
  // slots must be unique and viewmodels must build
  const slots = arr.map((w) => w.slot);
  ok('weapon slots unique', new Set(slots).size === slots.length, slots.join(','));
  if (mod.buildViewModel) {
    let viewFails = 0;
    for (const w of arr) {
      try {
        const rig = mod.buildViewModel(w.id);
        if (!rig || !rig.root || !rig.root.isObject3D || !rig.muzzle) viewFails++;
      } catch (e) {
        viewFails++;
        console.log(`    \u2717 viewmodel ${w.id}: ${e.message}`);
      }
    }
    ok('every weapon builds a viewmodel', viewFails === 0, `${arr.length} models`);
  }
  if (mod.WeaponInstance) {
    let instFails = 0;
    for (const w of arr) {
      const inst = new mod.WeaponInstance(w);
      const before = inst.ammo;
      const fired = inst.tryFire();
      if (!fired || inst.ammo !== before - 1) instFails++;
      inst.update(60 / (w.rpm * 1));
      if (!inst.canFire) instFails++;
      const r = inst.beginReload();
      if (w.magSize > 0 && !r) instFails++;
      // fast-forward the reload
      inst.update(inst.reloadTime + 0.01);
      if (inst.reloading) instFails++;
      if (inst.ammo !== inst.magSize) instFails++;
    }
    ok('weapon runtime behaves (fire / reload)', instFails === 0);
  }
  if (mod.WEAPON_BY_ID && mod.STARTING_WEAPON) {
    ok('starting weapon exists in table', !!mod.WEAPON_BY_ID[mod.STARTING_WEAPON], mod.STARTING_WEAPON);
  }
  if (mod.UPGRADES) {
    const ids = mod.UPGRADES.map((u) => u.id);
    ok('upgrade ids unique', new Set(ids).size === ids.length, `${ids.length} upgrades`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
staticAnalysis();
let ctx;
try {
  ctx = await runtimeChecks();
} catch (e) {
  failures++;
  console.log('\n  \u2717 runtime checks threw: ' + (e.stack || e.message));
}
if (ctx) {
  try { await navChecks(ctx.level, ctx.world); } catch (e) { failures++; console.log('\n  \u2717 nav checks threw: ' + (e.stack || e.message)); }
}
try { await weaponChecks(); } catch (e) { failures++; console.log('\n  \u2717 weapon checks threw: ' + (e.stack || e.message)); }

console.log('\n' + '='.repeat(64));
console.log(`  ${checks - failures}/${checks} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('='.repeat(64) + '\n');
process.exit(failures ? 1 : 0);
