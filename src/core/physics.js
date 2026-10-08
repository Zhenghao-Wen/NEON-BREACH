/**
 * physics.js — a compact AABB collision world with spatial hashing.
 * Used for player/enemy movement, raycasts for bullets and line-of-sight.
 */
import * as THREE from 'three';

const BIN = 4;

export class CollisionWorld {
  constructor() {
    this.boxes = [];
    this.bins = new Map();
    this._v = new THREE.Vector3();
  }

  add(min, max, meta = {}) {
    const box = {
      min: min.clone ? min.clone() : new THREE.Vector3(min.x, min.y, min.z),
      max: max.clone ? max.clone() : new THREE.Vector3(max.x, max.y, max.z),
      meta,
    };
    const id = this.boxes.length;
    this.boxes.push(box);
    const x0 = Math.floor(box.min.x / BIN);
    const x1 = Math.floor(box.max.x / BIN);
    const z0 = Math.floor(box.min.z / BIN);
    const z1 = Math.floor(box.max.z / BIN);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = x + ',' + z;
        let arr = this.bins.get(key);
        if (!arr) { arr = []; this.bins.set(key, arr); }
        arr.push(id);
      }
    }
    return box;
  }

  addFromLevel(colliders) {
    for (const c of colliders) {
      this.add(c.min, c.max, { kind: c.kind || 'wall' });
    }
  }

  /** All boxes whose bin overlaps the query rect. */
  _query(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    const x0 = Math.floor(minX / BIN);
    const x1 = Math.floor(maxX / BIN);
    const z0 = Math.floor(minZ / BIN);
    const z1 = Math.floor(maxZ / BIN);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const arr = this.bins.get(x + ',' + z);
        if (!arr) continue;
        for (const id of arr) if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /**
   * Sweep an axis-aligned capsule (approximated as a vertical cylinder vs AABB)
   * along one axis and return the allowed movement.
   * axis: 'x' | 'y' | 'z'
   */
  moveAxis(pos, radius, height, delta, axis) {
    if (delta === 0) return 0;
    const ids = this._query(
      Math.min(pos.x - radius, pos.x + delta - radius), Math.min(pos.z - radius, pos.z + delta - radius),
      Math.max(pos.x + radius, pos.x + delta + radius), Math.max(pos.z + radius, pos.z + delta + radius),
      this._scratch || (this._scratch = []),
    );
    let allowed = delta;
    const y0 = pos.y;
    const y1 = pos.y + height;
    for (const id of ids) {
      const b = this.boxes[id];
      if (b.meta && b.meta.disabled) continue;
      if (b.max.y <= y0 + 0.001 || b.min.y >= y1 - 0.001) continue;
      if (axis === 'x') {
        if (pos.z + radius <= b.min.z || pos.z - radius >= b.max.z) continue;
        if (delta > 0 && pos.x + radius <= b.min.x + 1e-4 && pos.x + allowed + radius > b.min.x) {
          allowed = Math.min(allowed, b.min.x - radius - pos.x);
        } else if (delta < 0 && pos.x - radius >= b.max.x - 1e-4 && pos.x + allowed - radius < b.max.x) {
          allowed = Math.max(allowed, b.max.x + radius - pos.x);
        }
      } else if (axis === 'z') {
        if (pos.x + radius <= b.min.x || pos.x - radius >= b.max.x) continue;
        if (delta > 0 && pos.z + radius <= b.min.z + 1e-4 && pos.z + allowed + radius > b.min.z) {
          allowed = Math.min(allowed, b.min.z - radius - pos.z);
        } else if (delta < 0 && pos.z - radius >= b.max.z - 1e-4 && pos.z + allowed - radius < b.max.z) {
          allowed = Math.max(allowed, b.max.z + radius - pos.z);
        }
      } else {
        if (pos.x + radius <= b.min.x || pos.x - radius >= b.max.x) continue;
        if (pos.z + radius <= b.min.z || pos.z - radius >= b.max.z) continue;
        if (delta > 0 && y1 <= b.min.y + 1e-4 && y1 + allowed > b.min.y) {
          allowed = Math.min(allowed, b.min.y - y1);
        } else if (delta < 0 && y0 >= b.max.y - 1e-4 && y0 + allowed < b.max.y) {
          allowed = Math.max(allowed, b.max.y - y0);
        }
      }
    }
    return allowed;
  }

  /** Ground height under a cylinder footprint (highest box top <= feet+step). */
  groundHeight(x, z, radius, feetY, step = 0.55) {
    const ids = this._query(x - radius, z - radius, x + radius, z + radius, this._scratchG || (this._scratchG = []));
    let best = 0;
    for (const id of ids) {
      const b = this.boxes[id];
      if (b.meta && b.meta.disabled) continue;
      if (x + radius <= b.min.x || x - radius >= b.max.x) continue;
      if (z + radius <= b.min.z || z - radius >= b.max.z) continue;
      if (b.max.y > feetY + step) continue;
      if (b.max.y > best) best = b.max.y;
    }
    return best;
  }

  /**
   * True if a vertical cylinder at (x,z) overlaps anything solid.
   *
   * `filter` excludes colliders from the test. That matters because the floor
   * slab fills the whole map just below y=0 and the ceiling slab sits just
   * above each room, so an unfiltered probe near ground level always reports a
   * collision.
   */
  overlaps(x, y, z, radius, height, filter = null) {
    const ids = this._query(x - radius, z - radius, x + radius, z + radius, this._scratchO || (this._scratchO = []));
    for (const id of ids) {
      const b = this.boxes[id];
      if (b.meta && b.meta.disabled) continue;
      if (filter && !filter(b)) continue;
      if (x + radius <= b.min.x || x - radius >= b.max.x) continue;
      if (z + radius <= b.min.z || z - radius >= b.max.z) continue;
      if (y + height <= b.min.y || y >= b.max.y) continue;
      return true;
    }
    return false;
  }

  /**
   * Ray vs world. Returns {t, point, normal, box} for the nearest hit or null.
   * Slab test against candidate boxes gathered by walking the ray's bins.
   */
  raycast(origin, dir, maxDist = 200, filter = null) {
    const inv = this._inv || (this._inv = new THREE.Vector3());
    inv.set(1 / (dir.x || 1e-8), 1 / (dir.y || 1e-8), 1 / (dir.z || 1e-8));
    let bestT = maxDist;
    let bestBox = null;
    let bestNormal = null;

    // walk bins along the ray (2D DDA in XZ) and test the boxes in each
    let x = Math.floor(origin.x / BIN);
    let z = Math.floor(origin.z / BIN);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(BIN / (dir.x || 1e-8));
    const tDeltaZ = Math.abs(BIN / (dir.z || 1e-8));
    let tMaxX = ((dir.x > 0 ? (x + 1) * BIN - origin.x : origin.x - x * BIN) || 0) / Math.abs(dir.x || 1e-8);
    let tMaxZ = ((dir.z > 0 ? (z + 1) * BIN - origin.z : origin.z - z * BIN) || 0) / Math.abs(dir.z || 1e-8);
    if (!isFinite(tMaxX)) tMaxX = Infinity;
    if (!isFinite(tMaxZ)) tMaxZ = Infinity;
    const visited = this._visited || (this._visited = new Set());
    visited.clear();
    let guard = 0;

    while (guard++ < 512) {
      const arr = this.bins.get(x + ',' + z);
      if (arr) {
        for (const id of arr) {
          if (visited.has(id)) continue;
          visited.add(id);
          const b = this.boxes[id];
          if (b.meta && b.meta.disabled) continue;
          if (filter && !filter(b)) continue;
          const hit = rayBox(origin, inv, b, bestT);
          if (hit && hit.t < bestT) { bestT = hit.t; bestBox = b; bestNormal = hit.normal; }
        }
      }
      const tNext = Math.min(tMaxX, tMaxZ);
      if (tNext > bestT || tNext > maxDist * 1.5) break;
      if (tMaxX < tMaxZ) { x += stepX; tMaxX += tDeltaX; }
      else { z += stepZ; tMaxZ += tDeltaZ; }
    }

    if (!bestBox) return null;
    const point = new THREE.Vector3().copy(origin).addScaledVector(dir, bestT);
    return { t: bestT, point, normal: bestNormal, box: bestBox, meta: bestBox.meta };
  }

  /** Cheap line-of-sight test (no normal computation). */
  lineOfSight(a, b, filter = null) {
    const dir = this._losDir || (this._losDir = new THREE.Vector3());
    dir.subVectors(b, a);
    const dist = dir.length();
    if (dist < 1e-4) return true;
    dir.multiplyScalar(1 / dist);
    const hit = this.raycast(a, dir, dist - 0.05, filter);
    return !hit;
  }
}

function rayBox(origin, inv, box, maxT) {
  const t1 = (box.min.x - origin.x) * inv.x;
  const t2 = (box.max.x - origin.x) * inv.x;
  const t3 = (box.min.y - origin.y) * inv.y;
  const t4 = (box.max.y - origin.y) * inv.y;
  const t5 = (box.min.z - origin.z) * inv.z;
  const t6 = (box.max.z - origin.z) * inv.z;
  const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4), Math.min(t5, t6));
  const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4), Math.max(t5, t6));
  if (tmax < 0 || tmin > tmax || tmin > maxT) return null;
  const t = tmin < 0 ? 0 : tmin;
  const n = new THREE.Vector3();
  if (tmin === Math.min(t1, t2)) n.set(t1 > t2 ? -1 : 1, 0, 0);
  else if (tmin === Math.min(t3, t4)) n.set(0, t3 > t4 ? -1 : 1, 0);
  else n.set(0, 0, t5 > t6 ? -1 : 1);
  return { t, normal: n };
}
