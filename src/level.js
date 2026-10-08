/**
 * level.js —the facility.
 *
 * The world is authored as an ASCII tile map (2 m per cell). From that single
 * source of truth we derive:
 *   - merged triangle geometry (one draw call per material)
 *   - AABB collision volumes for the player and projectiles
 *   - a navigation grid for enemy pathfinding / spawn validation
 *   - room metadata for lighting, ambience and spawn weighting
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeMaterial, buildMaterial } from './gfx/textures.js';

export const CELL = 2.0;      // metres per tile
const WALL_H = 3.4;           // default ceiling height

// ---------------------------------------------------------------------------
// the map:  #=solid  .=floor  ==doorway  ;=glass wall  ,=low cover lip
// ---------------------------------------------------------------------------
const MAP = [
  '################################################',
  '#........#................#....................#',
  '#.TRAIN..=..SERVER.HALL...=...REACTOR.SPIRE....#',
  '#.YARD...#................#....................D',
  '#........#................#....................#',
  '#........=................=....................#',
  '#........#................#....................#',
  '######.###................######.###############',
  '#......#......................#................#',
  '#.HANG.=......................=................#',
  '#.AR...=.......ATRIUM.........=..........MAP...D',
  '#......=......................=..........ROOM..#',
  '#......#......................#................#',
  '####.###......................###.##############',
  '#.......................................#......#',
  '#...........MAINTENANCE.TUNNEL..........=......#',
  '#.......................................#.VAULT#',
  '####.########################.##########......##',
  '#..............................#...............#',
  '#.....LAB.BLOCK................=...............#',
  '#..............................#....OBSERV.....D',
  '#..............................#...............#',
  '################################################',
];

const ROWS = MAP.length;
const COLS = MAP[0].length;
for (let i = 0; i < ROWS; i++) {
  if (MAP[i].length !== COLS) {
    throw new Error(`level map row ${i} has ${MAP[i].length} tiles, expected ${COLS}`);
  }
}
/** Characters that block movement. 'D' is a closed roller shutter. */
const WALL_CHARS = new Set(['#', 'D']);
const ORIGIN_X = -(COLS * CELL) / 2;
const ORIGIN_Z = -(ROWS * CELL) / 2;

/** Region definitions: which tiles belong to which zone (rect in tile coords). */
const REGIONS = [
  { id: 'yard', name: 'TRAIN YARD', x0: 1, y0: 1, x1: 8, y1: 6, floor: 'concrete', wall: 'metalplate', light: 0x8fd0ff, height: 3.6, spawn: 3 },
  { id: 'server', name: 'SERVER HALL', x0: 10, y0: 1, x1: 25, y1: 6, floor: 'tiles', wall: 'metalplate', light: 0x66ffd0, height: 3.2, spawn: 2 },
  { id: 'reactor', name: 'REACTOR SPIRE', x0: 27, y0: 1, x1: 46, y1: 6, floor: 'energy', wall: 'metalplate', light: 0x2fd0ff, height: 5.4, spawn: 3 },
  { id: 'hangar', name: 'HANGAR A', x0: 1, y0: 8, x1: 6, y1: 12, floor: 'concrete', wall: 'metalplate', light: 0xffc46b, height: 4.6, spawn: 3 },
  { id: 'atrium', name: 'ATRIUM', x0: 8, y0: 8, x1: 29, y1: 12, floor: 'tiles', wall: 'concrete', light: 0xd8e6ff, height: 6.2, spawn: 4 },
  { id: 'map', name: 'MAP ROOM', x0: 31, y0: 8, x1: 45, y1: 12, floor: 'tiles', wall: 'circuit', light: 0x39ff88, height: 3.4, spawn: 2 },
  { id: 'tunnel', name: 'MAINTENANCE TUNNEL', x0: 1, y0: 14, x1: 39, y1: 16, floor: 'grating', wall: 'metalplate', light: 0x6fd0a0, height: 2.6, spawn: 3 },
  { id: 'vault', name: 'VAULT', x0: 41, y0: 15, x1: 46, y1: 16, floor: 'hazard', wall: 'metalplate', light: 0xff9a3c, height: 3.4, spawn: 2 },
  { id: 'lab', name: 'LAB BLOCK', x0: 1, y0: 18, x1: 30, y1: 21, floor: 'tiles', wall: 'concrete', light: 0xcfe6ff, height: 3.6, spawn: 3 },
  { id: 'observ', name: 'OBSERVATION', x0: 32, y0: 18, x1: 46, y1: 21, floor: 'diamond', wall: 'metalplate', light: 0x9a7bff, height: 3.4, spawn: 3 },
];

function regionAt(tx, ty) {
  for (const r of REGIONS) {
    if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) return r;
  }
  // fallback: nearest region
  let best = REGIONS[0];
  let bd = Infinity;
  for (const r of REGIONS) {
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const d = (cx - tx) ** 2 + (cy - ty) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** A vertical quad between two world-space bottom corners. */
function wallQuad(a, b, y0, y1, out, scale = 2.75, flip = false) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const w = Math.hypot(dx, dz) / scale;
  const h = (y1 - y0) / scale;
  const g = new THREE.BufferGeometry();
  const p = flip
    ? [a.x, y0, a.z, b.x, y0, b.z, b.x, y1, b.z, a.x, y1, a.z]
    : [b.x, y0, b.z, a.x, y0, a.z, a.x, y1, a.z, b.x, y1, b.z];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, w, 0, w, h, 0, h], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  out.push(g);
  return g;
}

function floorQuad(x0, z0, x1, z1, y, out, scale = 2.2, up = true) {
  const w = (x1 - x0) / scale;
  const d = (z1 - z0) / scale;
  const g = new THREE.BufferGeometry();
  const p = up
    ? [x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0]
    : [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, d, w, d, w, 0], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  out.push(g);
  return g;
}

/** Box with world-scaled UVs so textures never stretch. */
function boxGeo(w, h, d, scale = 1.6) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const dims = [
    [d, h], [d, h], // +x, -x
    [w, d], [w, d], // +y, -y
    [w, h], [w, h], // +z, -z
  ];
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    const [sw, sh] = dims[face] || [1, 1];
    uv.setXY(i, uv.getX(i) * (sw / scale), uv.getY(i) * (sh / scale));
  }
  uv.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------
export class Level {
  constructor() {
    this.group = new THREE.Group();
    this.colliders = [];        // {min:Vec3, max:Vec3, kind:'wall'|'prop'|'low'}
    this.nav = null;            // Uint8Array, 0 = blocked
    this.navW = COLS;
    this.navH = ROWS;
    this.lights = [];
    this.spawnPoints = [];
    this.openSpots = [];
    this.pickupSpots = [];
    this.regionRects = REGIONS;
    this.cellSize = CELL;
    this.origin = new THREE.Vector2(ORIGIN_X, ORIGIN_Z);
    this.bounds = {
      minX: ORIGIN_X, maxX: -ORIGIN_X,
      minZ: ORIGIN_Z, maxZ: -ORIGIN_Z,
    };
  }

  tileToWorld(tx, ty) {
    return new THREE.Vector2(ORIGIN_X + (tx + 0.5) * CELL, ORIGIN_Z + (ty + 0.5) * CELL);
  }

  worldToTile(x, z) {
    return [Math.floor((x - ORIGIN_X) / CELL), Math.floor((z - ORIGIN_Z) / CELL)];
  }

  isSolid(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return true;
    return WALL_CHARS.has(MAP[ty][tx]);
  }

  /** Closed roller shutters: solid for movement, drawn as their own mesh. */
  isShutter(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return false;
    return MAP[ty][tx] === 'D';
  }

  isOpen(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return false;
    return !WALL_CHARS.has(MAP[ty][tx]);
  }

  build(quality = 'high') {
    const texOpt = quality === 'low' ? { size: 256 } : {};
    const palettes = new Map();
    const getMat = (pattern, key) => {
      if (!palettes.has(key)) palettes.set(key, makeMaterial(pattern, { repeat: [1, 1], ...texOpt }));
      return palettes.get(key);
    };

    // ---- geometry buckets keyed by material -------------------------------
    const buckets = new Map();
    const push = (mat, geo) => {
      if (!buckets.has(mat)) buckets.set(mat, []);
      buckets.get(mat).push(geo);
    };

    const floorByRegion = new Map();
    const ceilByRegion = new Map();
    for (const r of REGIONS) {
      floorByRegion.set(r.id, []);
      ceilByRegion.set(r.id, []);
    }

    // ---- floors & ceilings -------------------------------------------------
    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        if (this.isSolid(tx, ty)) continue;
        const r = regionAt(tx, ty);
        const x0 = ORIGIN_X + tx * CELL;
        const z0 = ORIGIN_Z + ty * CELL;
        const x1 = x0 + CELL;
        const z1 = z0 + CELL;
        const isGrate = r.floor === 'grating';
        floorQuad(x0, z0, x1, z1, 0, floorByRegion.get(r.id), isGrate ? 2.0 : 2.4, true);
        floorQuad(x0, z0, x1, z1, r.height, ceilByRegion.get(r.id), 2.6, false);
        // solid slabs below the floor and above the ceiling: these give
        // bullets somewhere to impact, stop the player falling through the
        // world and keep the raycast world honest.
        this.colliders.push({
          min: V(x0, -1.0, z0), max: V(x1, 0, z1), kind: 'floor', region: r.id,
        });
        this.colliders.push({
          min: V(x0, r.height, z0), max: V(x1, r.height + 1.0, z1), kind: 'ceiling', region: r.id,
        });
      }
    }
    for (const r of REGIONS) {
      const fmat = getMat(r.floor, 'floor:' + r.floor);
      const cmat = getMat('metalplate', 'ceil:metalplate');
      const fg = floorByRegion.get(r.id);
      const cg = ceilByRegion.get(r.id);
      if (fg.length) push(fmat, mergeGeometries(fg, false));
      if (cg.length) push(cmat, mergeGeometries(cg, false));
    }

    // ---- walls -------------------------------------------------------------
    const wallBuckets = new Map();
    const gmat = getMat('metalplate', 'wall:metalplate');
    const cmat = getMat('concrete', 'wall:concrete');
    const hmat = getMat('hazard', 'wall:hazard');
    const emat = getMat('energy', 'wall:energy');
    const pickWall = (region) => {
      if (region.wall === 'circuit') return getMat('circuit', 'wall:circuit');
      if (region.wall === 'concrete') return cmat;
      if (region.wall === 'hazard') return hmat;
      return gmat;
    };
    const wq = (mat, a, b, y0, y1, flip, scale) => {
      if (!wallBuckets.has(mat)) wallBuckets.set(mat, []);
      wallQuad(a, b, y0, y1, wallBuckets.get(mat), scale ?? 2.75, flip);
    };
    const LIP = 1.05;

    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        if (this.isSolid(tx, ty)) continue;
        const r = regionAt(tx, ty);
        const mat = pickWall(r);
        const x0 = ORIGIN_X + tx * CELL;
        const z0 = ORIGIN_Z + ty * CELL;
        const x1 = x0 + CELL;
        const z1 = z0 + CELL;
        // negative X neighbour
        if (this.isSolid(tx - 1, ty)) {
          const n = regionAt(tx - 1, ty);
          const h = Math.min(r.height, n.height);
          wq(mat, V(x0, 0, z0), V(x0, 0, z1), 0, h, true);
          this.colliders.push({ min: V(x0 - 0.35, 0, z0), max: V(x0, h, z1), kind: 'wall' });
        }
        if (this.isSolid(tx + 1, ty)) {
          const n = regionAt(tx + 1, ty);
          const h = Math.min(r.height, n.height);
          wq(mat, V(x1, 0, z0), V(x1, 0, z1), 0, h, false);
          this.colliders.push({ min: V(x1, 0, z0), max: V(x1 + 0.35, h, z1), kind: 'wall' });
        }
        if (this.isSolid(tx, ty - 1)) {
          const n = regionAt(tx, ty - 1);
          const h = Math.min(r.height, n.height);
          wq(mat, V(x0, 0, z0), V(x1, 0, z0), 0, h, false);
          this.colliders.push({ min: V(x0, 0, z0 - 0.35), max: V(x1, h, z0), kind: 'wall' });
        }
        if (this.isSolid(tx, ty + 1)) {
          const n = regionAt(tx, ty + 1);
          const h = Math.min(r.height, n.height);
          wq(mat, V(x0, 0, z1), V(x1, 0, z1), 0, h, true);
          this.colliders.push({ min: V(x0, 0, z1), max: V(x1, h, z1 + 0.35), kind: 'wall' });
        }
        // maintain a ceiling step where heights differ
        const taller = [[tx - 1, ty, -1, 0], [tx + 1, ty, 1, 0], [tx, ty - 1, 0, -1], [tx, ty + 1, 0, 1]];
        for (const [nx, ny, ox, oz] of taller) {
          if (this.isSolid(nx, ny)) continue;
          const n = regionAt(nx, ny);
          if (n.height <= r.height + 0.01) continue;
          const ax = ox < 0 ? x0 : ox > 0 ? x1 : x0;
          const az = oz < 0 ? z0 : oz > 0 ? z1 : z0;
          const bx = ox !== 0 ? ax : x1;
          const bz = oz !== 0 ? az : z1;
          wq(pickWall(n), V(ax, 0, az), V(bx, 0, bz), r.height, n.height, ox === 0 && oz < 0, 2.75);
        }
      }
    }
    for (const [mat, geos] of wallBuckets) push(mat, mergeGeometries(geos, false));

    // ---- prop builders -----------------------------------------------------
    // Props are collected first, then filtered by the connectivity pass, and
    // only afterwards merged into their material buckets.
    const props = [];
    const crateMat = getMat('crate', 'prop:crate');
    const rustMat = getMat('rust', 'prop:rust');
    const steelMat = getMat('gunmetal', 'prop:steel');
    const grateMat = getMat('grating', 'prop:grating');
    const hazardMat = hmat;
    const energyMat = emat;
    const circuitMat = getMat('circuit', 'wall:circuit');
    const diamondMat = getMat('diamond', 'floor:diamond');
    const blockers = [];   // {x0,x1,z0,z1,drop()} for connectivity rescue

    const addBox = (mat, x, y, z, w, h, d, colliderKind, opts = {}) => {
      const g = boxGeo(w, h, d, 1.5);
      g.translate(x, y + h / 2, z);
      const box = colliderKind ? {
        min: V(x - w / 2, y, z - d / 2),
        max: V(x + w / 2, y + h, z + d / 2),
        kind: colliderKind,
        noNav: !!opts.noNav,
      } : null;
      if (box) this.colliders.push(box);
      const prop = {
        mat, geo: g, box, blocked: !!opts.blocked,
        region: opts.region || null, dropped: false,
        noClearance: !!opts.noClearance,
      };
      props.push(prop);
      if (!opts.noConnectivity) {
        blockers.push({
          x0: x - w / 2 - 0.35, x1: x + w / 2 + 0.35,
          z0: z - d / 2 - 0.35, z1: z + d / 2 + 0.35,
          props: [prop],
        });
      }
      return prop;
    };
    const addCyl = (mat, x, y, z, r, h, seg = 12, collide = true, opts = {}) => {
      const g = new THREE.CylinderGeometry(r, r, h, seg, 1, true);
      g.translate(x, y + h / 2, z);
      const box = collide ? {
        min: V(x - r, y, z - r), max: V(x + r, y + h, z + r), kind: 'prop',
        noNav: !!opts.noNav,
      } : null;
      if (box) this.colliders.push(box);
      const prop = {
        mat, geo: g, box, blocked: collide && !opts.noBlock, region: opts.region || null,
        dropped: false, noClearance: !!opts.noClearance,
      };
      props.push(prop);
      if (collide && !opts.noConnectivity) {
        blockers.push({
          x0: x - r - 0.35, x1: x + r + 0.35,
          z0: z - r - 0.35, z1: z + r + 0.35,
          props: [prop],
        });
      }
      return prop;
    };
    // free-standing geometry that never participates in navigation
    const worldOf = (tx, ty) => this.tileToWorld(tx, ty);
    const addDeco = (mat, geo) => { props.push({ mat, geo, box: null, blocked: false, dropped: false, deco: true }); };

    // ---- hand-placed props per region -------------------------------------
    // Placement rules keep the map traversable:
    //   * only tiles with at least one solid orthogonal neighbour (edges, not
    //     open floor), so props never sit in the middle of a route
    //   * at least one tile of clearance from doorways, junctions and other
    //     props, so corridors stay wider than an agent's collision radius
    const rng = (() => { let s = 987654321; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
    const spawnRng = rng;

    // tile classification
    const doorTiles = [];
    const corridorTiles = new Set();
    for (let ty = 1; ty < ROWS - 1; ty++) {
      for (let tx = 1; tx < COLS - 1; tx++) {
        if (this.isSolid(tx, ty)) continue;
        if (MAP[ty][tx] === '=') doorTiles.push([tx, ty]);
        const n = [this.isSolid(tx - 1, ty), this.isSolid(tx + 1, ty), this.isSolid(tx, ty - 1), this.isSolid(tx, ty + 1)]
          .filter(Boolean).length;
        if (n >= 2) corridorTiles.add(tx + ',' + ty);
      }
    }
    const nearDoor = (tx, ty) => {
      for (const [dx, dy] of doorTiles) {
        if (Math.abs(dx - tx) <= 1 && Math.abs(dy - ty) <= 1) return true;
      }
      return false;
    };

    const propTileBlocked = new Set();
    const placeableIn = (region) => {
      const out = [];
      for (let ty = region.y0; ty <= region.y1; ty++) {
        for (let tx = region.x0; tx <= region.x1; tx++) {
          if (tx < 1 || ty < 1 || tx >= COLS - 1 || ty >= ROWS - 1) continue;
          if (this.isSolid(tx, ty)) continue;
          const i = ty * COLS + tx;
          if (propTileBlocked.has(i)) continue;
          if (nearDoor(tx, ty)) continue;
          if (corridorTiles.has(tx + ',' + ty)) continue;
          const walls = [this.isSolid(tx - 1, ty), this.isSolid(tx + 1, ty), this.isSolid(tx, ty - 1), this.isSolid(tx, ty + 1)]
            .filter(Boolean).length;
          if (walls < 1) continue;
          // keep a 1-tile moat: neighbours must be open floor
          const neighbours = [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]]
            .filter(([nx, ny]) => !this.isSolid(nx, ny));
          if (neighbours.some(([nx, ny]) => propTileBlocked.has(ny * COLS + nx) || nearDoor(nx, ny) || corridorTiles.has(nx + ',' + ny))) continue;
          out.push([tx, ty]);
        }
      }
      return out;
    };

    for (const region of REGIONS) {
      const candidates = placeableIn(region);
      if (!candidates.length) continue;
      const area = (region.x1 - region.x0 + 1) * (region.y1 - region.y0 + 1);
      const count = Math.min(candidates.length, Math.max(2, Math.round(area * 0.1)));
      for (let i = 0; i < count; i++) {
        const tiles = placeableIn(region);
        if (!tiles.length) break;
        const [tx, ty] = tiles[(rng() * tiles.length) | 0];
        propTileBlocked.add(ty * COLS + tx);
        const p = this.tileToWorld(tx, ty);
        const x = p.x + (rng() - 0.5) * 0.5;
        const z = p.y + (rng() - 0.5) * 0.5;
        if (rng() < 0.55) {
          const s = 0.75 + rng() * 0.5;
          const stack = rng() < 0.35;
          const prop = addBox(crateMat, x, 0, z, s, s, s, 'prop', { region: region.id, blocked: true });
          if (stack) {
            const g2 = boxGeo(s * 0.7, s * 0.7, s * 0.7, 1.5);
            g2.translate(x + 0.06, s + s * 0.35, z - 0.05);
            prop.geo = mergeGeometries([prop.geo, g2], false) || prop.geo;
          }
        } else {
          const h = 1.0 + rng() * 0.35;
          addCyl(rustMat, x, 0, z, 0.36, h, 12, true, { region: region.id, blocked: true });
          addCyl(steelMat, x, h - 0.06, z, 0.375, 0.08, 12, false, { noConnectivity: true });
          addCyl(steelMat, x, 0.28, z, 0.375, 0.07, 12, false, { noConnectivity: true });
        }
      }
    }

    // Reactor spire: a glowing central column with a ring of pylons
    {
      const c = this.tileToWorld(36, 3);
      addCyl(steelMat, c.x, 0, c.y, 2.1, 0.35, 24, false, { noConnectivity: true });
      addCyl(energyMat, c.x, 0.35, c.y, 1.55, 5.0, 24, false, { noConnectivity: true });
      addCyl(steelMat, c.x, 5.35, c.y, 1.9, 0.5, 24, false, { noConnectivity: true });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const px = c.x + Math.cos(a) * 4.2;
        const pz = c.y + Math.sin(a) * 4.2;
        addBox(steelMat, px, 0, pz, 0.55, 5.6, 0.55, 'prop', { blocked: true, region: 'reactor', noClearance: true });
        addBox(energyMat, px, 2.4, pz + (Math.sin(a) >= 0 ? 0.3 : -0.3), 0.2, 1.2, 0.1, null);
      }
    }

    // Server hall: rows of racks
    {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 6; col++) {
          const tx = 12 + col * 2;
          const ty = 2 + Math.round(row * 1.6);
          if (this.isSolid(tx, ty) || !this.isOpen(tx, ty - 1)) continue;
          const p = worldOf(tx, ty);
          addBox(circuitMat, p.x, 0, p.y, 1.0, 2.2, 0.62, 'prop', { blocked: true, region: 'server' });
          addBox(steelMat, p.x, 2.2, p.y, 1.0, 0.12, 0.62, null);
        }
      }
    }

    // Atrium centrepiece: a raised dais with pillars and a holographic core.
    // Radii are chosen so the ring between the dais edge and the pylons stays
    // comfortably walkable (the pylons used to leave a 0.3 m slot, which
    // agents could not squeeze through).
    {
      const c = this.tileToWorld(18, 10);
      // The dais is solid for navigation (noNav stays false so its tiles are
      // stamped out of the nav grid) but exempt from the clearance heuristic,
      // which would otherwise reject it for "pinching" the space around it.
      const landmark = { noConnectivity: true, noClearance: true };
      addCyl(steelMat, c.x, 0, c.y, 2.4, 0.4, 28, true, landmark);
      addCyl(hazardMat, c.x, 0.4, c.y, 2.1, 0.12, 28, false, { noConnectivity: true, noClearance: true });
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const px = c.x + Math.cos(a) * 6.9;
        const pz = c.y + Math.sin(a) * 6.9;
        addBox(steelMat, px, 0, pz, 0.7, 6.2, 0.7, 'prop', landmark);
        addBox(energyMat, px, 5.2, pz, 0.5, 0.9, 0.5, null);
      }
      // hovering hologram
      const holo = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.15, 1),
        new THREE.MeshBasicMaterial({ color: 0x63f4ff, wireframe: true, transparent: true, opacity: 0.85 }),
      );
      holo.position.set(c.x, 2.4, c.y);
      holo.userData.spin = 0.45;
      holo.userData.bob = { base: 2.4, amp: 0.22, speed: 1.1 };
      this.group.add(holo);
      if (!this.animated) this.animated = [];
      this.animated.push(holo);
    }

    // Observation deck: window wall + consoles
    {
      const p = worldOf(39, 19);
      for (let i = 0; i < 4; i++) {
        addBox(steelMat, p.x - 3 + i * 2, 0, p.y, 1.2, 0.95, 0.9, 'prop');
        addBox(circuitMat, p.x - 3 + i * 2, 0.95, p.y - 0.25, 1.1, 0.5, 0.35, null);
      }
    }

    // Lab block: benches, tanks, fume hoods
    {
      for (let i = 0; i < 6; i++) {
        const p = worldOf(3 + i * 4, 19);
        addBox(steelMat, p.x, 0, p.y, 2.4, 0.9, 1.0, 'prop');
        addBox(circuitMat, p.x, 0.9, p.y - 0.4, 2.2, 0.35, 0.3, null);
        if (i % 2 === 0) addCyl(getMat('circuit', 'wall:circuit'), p.x + 1.1, 0.9, p.y + 0.2, 0.18, 1.1, 10, false);
      }
    }

    // Hangar: a landed dropship-ish block + gantry (kept clear of the doorway)
    {
      const p = worldOf(4.0, 11);
      addBox(steelMat, p.x, 0, p.y, 3.6, 1.9, 4.4, 'prop');
      addBox(hazardMat, p.x, 1.9, p.y, 3.7, 0.25, 4.5, null);
      addBox(grateMat, p.x - 2.2, 0, p.y - 1.4, 1.4, 3.2, 0.25, 'prop');
      addCyl(rustMat, p.x + 2.2, 0, p.y + 1.8, 0.5, 3.2, 14);
    }

    // Map room: glowing table + wall screens
    {
      const p = worldOf(37, 10);
      addBox(steelMat, p.x, 0, p.y, 4.4, 0.85, 2.6, 'prop');
      const table = boxGeo(4.0, 0.16, 2.2, 2.0);
      table.translate(p.x, 0.93, p.y);
      addDeco(energyMat, table);
    }

    // Vault: big door + lockers
    {
      const p = worldOf(43.5, 15.5);
      addCyl(steelMat, p.x, 0, p.y, 1.1, 2.6, 20);
      addBox(hazardMat, p.x - 1.6, 0, p.y + 0.9, 1.0, 2.4, 0.8, 'prop');
      addBox(steelMat, p.x + 1.6, 0, p.y + 0.9, 1.0, 2.4, 0.8, 'prop');
    }

    // Tunnel: pipes, cable trays, flickering strip lights
    {
      for (let i = 0; i < 18; i++) {
        const tx = 2 + i * 2;
        const p = worldOf(tx, 15);
        const pipe = new THREE.CylinderGeometry(0.13, 0.13, 1.4, 8);
        pipe.rotateZ(Math.PI / 2);
        pipe.translate(p.x, 2.2, p.y - 0.6);
        addDeco(rustMat, pipe);
      }
      for (let i = 0; i < 9; i++) {
        const p = worldOf(3 + i * 4, 15);
        addBox(hazardMat, p.x, 2.25, p.y + 0.7, 2.2, 0.22, 0.22, null);
      }
    }

    // ---- catwalk ring overlooking the atrium ------------------------------
    {
      const cw = { x0: 8, y0: 8, x1: 29, y1: 12 };
      const y = 3.4;
      const mk = (tx0, ty0, tx1, ty1) => {
        const a = this.tileToWorld(tx0, ty0);
        const b = this.tileToWorld(tx1, ty1);
        const x0 = a.x - CELL / 2, x1 = b.x + CELL / 2;
        const z0 = a.y - CELL / 2, z1 = b.y + CELL / 2;
        const g = boxGeo(x1 - x0, 0.22, z1 - z0, 1.8);
        g.translate((x0 + x1) / 2, y - 0.11, (z0 + z1) / 2);
        addDeco(diamondMat, g);
        // railings
        const railH = 1.0;
        const post = (px, pz) => {
          const pg = boxGeo(0.1, railH, 0.1, 1.0);
          pg.translate(px, y + railH / 2, pz);
          addDeco(steelMat, pg);
        };
        const railBar = (ax, az, bx, bz, hy) => {
          const len = Math.hypot(bx - ax, bz - az);
          const rg = boxGeo(len, 0.08, 0.08, 1.0);
          rg.rotateY(Math.atan2(bz - az, bx - ax) * -1);
          rg.translate((ax + bx) / 2, y + hy, (az + bz) / 2);
          addDeco(steelMat, rg);
        };
        for (let px = x0; px <= x1 + 0.01; px += 1.0) { post(px, z0); post(px, z1); }
        for (let pz = z0; pz <= z1 + 0.01; pz += 1.0) { post(x0, pz); post(x1, pz); }
        railBar(x0, z0, x1, z0, railH); railBar(x0, z1, x1, z1, railH);
        railBar(x0, z0, x0, z1, railH); railBar(x1, z0, x1, z1, railH);
        railBar(x0, z0, x1, z0, 0.5); railBar(x0, z1, x1, z1, 0.5);
        railBar(x0, z0, x0, z1, 0.5); railBar(x1, z0, x1, z1, 0.5);
        return { x0, x1, z0, z1 };
      };
      // an L-shaped walkway
      const w1 = mk(8, 8, 29, 8);
      const w2 = mk(29, 8, 29, 12);
      // stairs up from the hall to the catwalk (south edge of the ring)
      const steps = 9;
      const stairX = 11;
      const zBottom = ORIGIN_Z + 13.0;
      const zTop = ORIGIN_Z + 9.0;
      const stepDepth = Math.abs(zTop - zBottom) / steps + 0.06;
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const a = this.tileToWorld(stairX, 0);
        const sz = zBottom + (zTop - zBottom) * t;
        const sy = y * t;
        const sg = boxGeo(2.6, 0.22, stepDepth, 1.6);
        sg.translate(a.x, sy, sz);
        addDeco(diamondMat, sg);
        this.colliders.push({
          min: V(a.x - 1.3, sy - 1.1, sz - stepDepth / 2),
          max: V(a.x + 1.3, sy, sz + stepDepth / 2),
          kind: 'low',
        });
      }
      // catwalk supports
      for (const px of [10, 16, 22, 28]) {
        const p = this.tileToWorld(px, 8);
        addBox(steelMat, p.x, 0, p.y + 0.5, 0.3, y - 0.2, 0.3, 'prop');
      }
    }

    // ---- pipe runs and wall details ---------------------------------------
    {
      for (let i = 0; i < 14; i++) {
        const p = this.tileToWorld(1 + i * 3, 1);
        const g = new THREE.CylinderGeometry(0.16, 0.16, CELL * 3, 10, 1, true);
        g.rotateZ(Math.PI / 2);
        g.translate(p.x, 2.9, p.y + 0.2);
        addDeco(rustMat, g);
      }
      for (let i = 0; i < 10; i++) {
        const p = this.tileToWorld(11 + i * 3, 13);
        const g = new THREE.CylinderGeometry(0.11, 0.11, CELL * 3, 8, 1, true);
        g.rotateZ(Math.PI / 2);
        g.translate(p.x, 3.05, p.y);
        addDeco(steelMat, g);
      }
    }

    // ---- navigation grid ---------------------------------------------------
    // Built before props are merged so the connectivity pass can drop any prop
    // that would seal off part of the facility.
    this.nav = new Uint8Array(COLS * ROWS);
    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        this.nav[ty * COLS + tx] = this.isSolid(tx, ty) ? 0 : 1;
      }
    }

    // A prop that creates a 1 m dead pocket (too narrow for a 0.42 m agent to
    // squeeze through) is dropped, otherwise creatures can wedge themselves
    // between the prop and a wall with no way out.
    const AGENT_RADIUS = 0.42;
    const blockedTilesOf = (p) => {
      if (!p.blocked || !p.box) return null;
      const [tx0, ty0] = this.worldToTile(p.box.min.x, p.box.min.z);
      const [tx1, ty1] = this.worldToTile(p.box.max.x - 0.02, p.box.max.z - 0.02);
      const tiles = [];
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
          tiles.push([tx, ty]);
        }
      }
      return tiles;
    };
    const rebuildNavRaw = () => {
      this.nav.fill(0);
      for (let ty = 0; ty < ROWS; ty++) {
        for (let tx = 0; tx < COLS; tx++) {
          if (!this.isSolid(tx, ty)) this.nav[ty * COLS + tx] = 1;
        }
      }
      // Props are stamped with sub-tile accuracy: the dais is a large round
      // platform that clips the corner of many tiles, and marking whole tiles
      // solid would shred the atrium's connectivity. A tile only counts as
      // blocked when walking through it is genuinely impossible.
      const S = 1 / 3;
      for (const c of this.colliders) {
        if (c.kind !== 'prop' && c.kind !== 'low') continue;
        if (c.noNav) continue;
        const [tx0, ty0] = this.worldToTile(c.min.x, c.min.z);
        const [tx1, ty1] = this.worldToTile(c.max.x - 1e-4, c.max.z - 1e-4);
        for (let ty = tx0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
            if (this.nav[ty * COLS + tx] === 0) continue;
            const bx0 = ORIGIN_X + tx * CELL;
            const bz0 = ORIGIN_Z + ty * CELL;
            let inside = 0;
            let samples = 0;
            for (let iy = 0; iy < 3; iy++) {
              for (let ix = 0; ix < 3; ix++) {
                const px = bx0 + (ix + 0.5) * S * CELL;
                const pz = bz0 + (iy + 0.5) * S * CELL;
                samples++;
                if (px > c.min.x && px < c.max.x && pz > c.min.z && pz < c.max.z) inside++;
              }
            }
            if (inside >= samples * 0.72) this.nav[ty * COLS + tx] = 0;
          }
        }
      }
    };

    rebuildNavRaw();
    let clearanceDropped = 0;
    {
      const forbidden = new Set();
      for (const p of props) {
        const tiles = blockedTilesOf(p);
        if (!tiles) continue;
        // Landmark geometry (the atrium dais, the reactor column) is part of
        // the level's shape, not clutter — the clearance test would reject it
        // for "pinching" the space around it.
        if (p.noClearance) continue;
        let createsPocket = false;
        for (const [tx, ty] of tiles) {
          if (forbidden.has(ty * COLS + tx)) { createsPocket = true; break; }
          // Test the 2x2 windows around the prop. Doors are single tiles, so a
          // prop that pinches a door into an impassable diamond only shows up
          // when the diagonal window is checked too.
          for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0], [-1, 1], [1, -1], [0, 1], [1, 0]]) {
            if (this.isBlockedRect(tx + ox, ty + oy, AGENT_RADIUS)) { createsPocket = true; break; }
          }
          if (createsPocket) break;
        }
        if (createsPocket) {
          p.dropped = true;
          for (const [tx, ty] of tiles) forbidden.add(ty * COLS + tx);
          clearanceDropped++;
        }
      }
    }

    // A doorway is a wall tile with open space on opposite sides: agents can
    // pass through those tiles even though the tile itself is solid.
    const isDoor = (tx, ty) => {
      if (!this.isSolid(tx, ty)) return false;
      const h = this.isOpen(tx - 1, ty) && this.isOpen(tx + 1, ty);
      const v = this.isOpen(tx, ty - 1) && this.isOpen(tx, ty + 1);
      return h || v;
    };

    const pickSpot = () => {
      if (!this.openSpots.length) return this.spawnPoints[0] || { x: 0, z: 0 };
      return this.openSpots[(spawnRng() * this.openSpots.length) | 0];
    };
    this.pickSpot = pickSpot;

    const reachCount = () => {
      const total = new Uint8Array(COLS * ROWS);
      const seen = new Uint8Array(COLS * ROWS);
      let totalN = 0;
      for (let i = 0; i < this.nav.length; i++) if (this.nav[i]) { total[i] = 1; totalN++; }
      // find a seed
      let seed = -1;
      for (let i = 0; i < total.length; i++) if (total[i]) { seed = i; break; }
      if (seed < 0) return { reached: 0, total: 0, seen };
      const stack = [seed];
      seen[seed] = 1;
      let reached = 0;
      while (stack.length) {
        const i = stack.pop();
        reached++;
        const x = i % COLS;
        const y = (i / COLS) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
            const ni = ny * COLS + nx;
            if (seen[ni]) continue;
            const passable = total[ni] || (Math.abs(dx) + Math.abs(dy) === 1 && isDoor(nx, ny));
            if (!passable) continue;
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      return { reached, total: totalN, seen };
    };

    let conn = { reached: 0, total: 0, seen: new Uint8Array(COLS * ROWS) };
    let droppedCount = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      rebuildNavRaw();
      conn = reachCount();
      if (conn.reached >= conn.total) break;
      // pick the prop footprint overlapping the most unreachable tiles
      let best = null;
      let bestScore = 0;
      for (const b of blockers) {
        let score = 0;
        const [tx0, ty0] = this.worldToTile(b.x0, b.z0);
        const [tx1, ty1] = this.worldToTile(b.x1, b.z1);
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
            const i = ty * COLS + tx;
            if (!conn.seen[i] && this.nav[i]) score++;
          }
        }
        if (score > bestScore) { bestScore = score; best = b; }
      }
      if (!best || bestScore === 0) break;
      let removed = false;
      for (const p of best.props) {
        if (p.dropped) continue;
        p.dropped = true;
        droppedCount++;
        removed = true;
      }
      if (!removed) break;
      // drop the collider too
      for (const p of best.props) {
        if (p.box) {
          const i = this.colliders.indexOf(p.box);
          if (i >= 0) this.colliders.splice(i, 1);
        }
      }
      blockers.splice(blockers.indexOf(best), 1);
    }
    this.connectivity = { reached: conn.reached, total: conn.total, droppedProps: droppedCount, clearanceDropped };
    rebuildNavRaw();

    // ---- assemble ----------------------------------------------------------
    const propGeo = new Map();
    for (const p of props) {
      if (p.dropped) { p.geo.dispose?.(); continue; }
      if (!propGeo.has(p.mat)) propGeo.set(p.mat, []);
      propGeo.get(p.mat).push(p.geo);
    }
    // closed roller shutters along the facility's outer bays
    const shutterGeos = [];
    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        if (!this.isShutter(tx, ty)) continue;
        const x0 = ORIGIN_X + tx * CELL;
        const z0 = ORIGIN_Z + ty * CELL;
        const r = regionAt(tx, ty);
        const g = boxGeo(CELL * 0.98, r.height * 0.82, 0.3, 1.1);
        g.translate(x0 + CELL / 2, r.height * 0.41, z0 + CELL / 2);
        shutterGeos.push(g);
        // slats
        for (let s = 0; s < 6; s++) {
          const sg = boxGeo(CELL * 0.94, 0.1, 0.36, 1.0);
          sg.translate(x0 + CELL / 2, 0.35 + s * (r.height * 0.82 / 6), z0 + CELL / 2);
          shutterGeos.push(sg);
        }
      }
    }
    if (shutterGeos.length) {
      propGeo.set(hazardMat, [...(propGeo.get(hazardMat) || []), mergeGeometries(shutterGeos, false)]);
    }

    const allBuckets = new Map([...buckets, ...propGeo]);
    for (const [mat, geos] of allBuckets) {
      if (!geos.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }

    // ---- lights ------------------------------------------------------------
    for (const r of REGIONS) {
      const cx = (r.x0 + r.x1 + 1) / 2;
      const cy = (r.y0 + r.y1 + 1) / 2;
      const spanX = (r.x1 - r.x0 + 1);
      const spanY = (r.y1 - r.y0 + 1);
      const n = Math.max(2, Math.min(5, Math.round(Math.sqrt(spanX * spanY) / 3)));
      for (let i = 0; i < n; i++) {
        const tx = r.x0 + ((i + 0.5) / n) * (r.x1 - r.x0 + 1);
        const ty = cy + ((i % 2) ? 1.6 : -1.6);
        const p = this.tileToWorld(Math.round(tx), Math.round(Math.max(r.y0, Math.min(r.y1, ty))));
        const light = new THREE.PointLight(r.light, 22, 17, 2.0);
        light.position.set(p.x, r.height - 0.7, p.y);
        light.castShadow = false;
        this.group.add(light);
        this.lights.push(light);
        // visible fixture
        const g = boxGeo(1.5, 0.1, 0.35, 1.0);
        g.translate(p.x, r.height - 0.32, p.y);
        const fix = new THREE.Mesh(g, getMat('energy', 'wall:energy'));
        fix.matrixAutoUpdate = false;
        this.group.add(fix);
      }
    }

    // ---- spawn / pickup points --------------------------------------------
    for (const r of REGIONS) {
      for (let ty = r.y0; ty <= r.y1; ty++) {
        for (let tx = r.x0; tx <= r.x1; tx++) {
          if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
          if (!this.nav[ty * COLS + tx]) continue;
          // a spawn tile must have room: keep it away from solid neighbours on
          // both axes so agents never materialise inside a wall or a crate
          const p = this.tileToWorld(tx, ty);
          const point = { x: p.x, z: p.y, region: r.id, y: 0 };
          this.spawnPoints.push(point);
          const openNeighbours = [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]]
            .filter(([nx, ny]) => this.nav[ny * COLS + nx]).length;
          if (openNeighbours >= 3) this.openSpots.push(point);
          if (spawnRng() < 0.22) this.pickupSpots.push(point);
        }
      }
    }

    // a couple of decorative emissive wall strips for neon flavour
    this.addNeonStrips(getMat('energy', 'wall:energy'));

    // fail loudly rather than shipping a level agents cannot traverse
    this.validation = this.validate();
    return this;
  }

  addNeonStrips(mat) {
    const geos = [];
    const strip = (tx, ty, horiz, len) => {
      const p = this.tileToWorld(tx, ty);
      const g = boxGeo(horiz ? len : 0.14, 0.1, horiz ? 0.14 : len, 1.0);
      g.translate(p.x, 0.06, p.y);
      geos.push(g);
    };
    for (let i = 0; i < 12; i++) strip(9 + i, 12, true, CELL);
    for (let i = 0; i < 6; i++) strip(29, 8 + i, false, CELL);
    if (geos.length) {
      const merged = mergeGeometries(geos, false);
      const m = new THREE.Mesh(merged, mat);
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }
  }

  /**
   * Post-build sanity check. Throws when the generated world would break the
   * game — an unreachable pocket of floor means enemies could never be killed,
   * and a prop overlapping walkable space means agents would path into it.
   * Cheap enough to always run, and it turns a silent gameplay bug into a
   * loud build error.
   */
  validate() {
    const problems = [];
    // doorways are solid tiles with open space on opposite sides
    const isDoor = (tx, ty) => {
      if (!this.isSolid(tx, ty)) return false;
      return (this.isOpen(tx - 1, ty) && this.isOpen(tx + 1, ty)) ||
        (this.isOpen(tx, ty - 1) && this.isOpen(tx, ty + 1));
    };
    let walkable = 0;
    let seed = -1;
    for (let i = 0; i < this.nav.length; i++) {
      if (this.nav[i]) { walkable++; if (seed < 0) seed = i; }
    }
    if (seed < 0) problems.push('navigation grid has no walkable tiles');

    if (seed >= 0) {
      const seen = new Uint8Array(this.nav.length);
      const stack = [seed];
      seen[seed] = 1;
      let reached = 0;
      while (stack.length) {
        const i = stack.pop();
        reached++;
        const x = i % COLS;
        const y = (i / COLS) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
            const ni = ny * COLS + nx;
            if (seen[ni]) continue;
            if (!(this.nav[ni] || (Math.abs(dx) + Math.abs(dy) === 1 && isDoor(nx, ny)))) continue;
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      if (reached < walkable) {
        problems.push(`${walkable - reached} of ${walkable} walkable tiles are unreachable from the spawn`);
      }
    }

    if (!this.spawnPoints.length) problems.push('no spawn points were generated');
    if (this.colliders.length < 50) problems.push(`only ${this.colliders.length} colliders`);

    if (problems.length) {
      const err = new Error('level validation failed:\n  - ' + problems.join('\n  - '));
      err.problems = problems;
      throw err;
    }
    return {
      walkable,
      colliders: this.colliders.length,
      connectivity: this.connectivity,
      spawnPoints: this.spawnPoints.length,
    };
  }

  /** nearest walkable tile centre to a world point */
  nearestWalkable(x, z, maxRadius = 6) {
    const [tx0, ty0] = this.worldToTile(x, z);
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = tx0 + dx;
          const ty = ty0 + dy;
          if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
          if (!this.nav[ty * COLS + tx]) continue;
          const p = this.tileToWorld(tx, ty);
          return { x: p.x, z: p.y };
        }
      }
    }
    return null;
  }

  walkable(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return false;
    return this.nav[ty * COLS + tx] === 1;
  }

  /**
   * True when an agent of `halfWidth` could not pass between (tx,tz) and
   * (tx+1,tz+1) in either direction.
   *
   * Used while placing props: a 1 m gap between a crate and a wall looks fine on
   * the tile grid but a 0.42 m-radius creature physically cannot squeeze
   * through it, which would leave agents wedged. Props that create such a
   * pocket are rejected instead.
   */
  isBlockedRect(tx, tz, halfWidth) {
    const worldX = ORIGIN_X + tx * CELL;
    const worldZ = ORIGIN_Z + tz * CELL;
    const w = halfWidth;
    // sample the corners of the agent's footprint at a given offset in the window
    const free = (ox, oz) => {
      const corners = [
        [worldX + ox - w, worldZ + oz - w],
        [worldX + ox + w, worldZ + oz - w],
        [worldX + ox - w, worldZ + oz + w],
        [worldX + ox + w, worldZ + oz + w],
      ];
      for (const [cx, cz] of corners) {
        const gx = Math.floor(cx / CELL);
        const gy = Math.floor(cz / CELL);
        if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return false;
        if (this.nav[gy * COLS + gx] === 0) return false;
      }
      return true;
    };
    const S = CELL * 0.16;
    // east-west corridor: can we slide across the window left->right?
    let canX = true;
    for (let i = 1; i < CELL / S; i++) {
      if (!free(S * i, CELL / 2)) { canX = false; break; }
    }
    if (canX) return false;
    // north-south corridor
    let canZ = true;
    for (let i = 1; i < CELL / S; i++) {
      if (!free(CELL / 2, S * i)) { canZ = false; break; }
    }
    return !canZ;
  }

  /** nearest walkable tile centre to a world point */
  nearestWalkable(x, z, maxRadius = 6) {
    const [tx0, ty0] = this.worldToTile(x, z);
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = tx0 + dx;
          const ty = ty0 + dy;
          if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
          if (!this.nav[ty * COLS + tx]) continue;
          const p = this.tileToWorld(tx, ty);
          return { x: p.x, z: p.y };
        }
      }
    }
    return null;
  }

  regionNameAt(x, z) {
    const [tx, ty] = this.worldToTile(x, z);
    return regionAt(tx, ty).name;
  }

  update(dt) {
    if (this.animated) {
      for (const o of this.animated) {
        if (o.userData.spin) o.rotation.y += o.userData.spin * dt;
        if (o.userData.bob) {
          const b = o.userData.bob;
          o.position.y = b.base + Math.sin(performance.now() * 0.001 * b.speed) * b.amp;
        }
      }
    }
  }
}
