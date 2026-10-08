/**
 * pathfind.js — grid A* over the level's navigation grid, with string-pulling
 * smoothing so agents walk in straight lines instead of tile staircases.
 *
 * Grid resolution is the level's 2 m tile grid, which matches the wall geometry
 * exactly. The smoothed path is additionally validated against the collision
 * world when one is supplied, because tile centres can still sit inside a solid
 * prop (a crate occupies part of a tile, not the whole cell).
 */
const SQRT2 = Math.SQRT2;

export class Pathfinder {
  constructor(level, world = null) {
    this.level = level;
    this.world = world;
    this.w = level.navW;
    this.h = level.navH;
    this.nav = level.nav;
    this.cell = level.cellSize;
    this.originX = level.origin.x;
    this.originZ = level.origin.y;
    // reusable scratch buffers (sized once)
    this.gScore = new Float32Array(this.w * this.h);
    this.fScore = new Float32Array(this.w * this.h);
    this.came = new Int32Array(this.w * this.h);
    this.stamp = new Int32Array(this.w * this.h);
    this.closed = new Uint8Array(this.w * this.h);
    this.epoch = 0;
    this.heap = [];
  }

  idx(tx, ty) { return ty * this.w + tx; }

  walkable(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.nav[ty * this.w + tx] === 1;
  }

  /** Diagonal moves require both orthogonal neighbours to be open. */
  _canStep(tx, ty, dx, dy) {
    if (!this.walkable(tx + dx, ty + dy)) return false;
    if (dx !== 0 && dy !== 0) {
      if (!this.walkable(tx + dx, ty) || !this.walkable(tx, ty + dy)) return false;
    }
    return true;
  }

  _push(node) {
    const heap = this.heap;
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].f <= heap[i].f) break;
      const t = heap[parent];
      heap[parent] = heap[i];
      heap[i] = t;
      i = parent;
    }
  }

  _pop() {
    const heap = this.heap;
    if (!heap.length) return null;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < heap.length && heap[l].f < heap[best].f) best = l;
        if (r < heap.length && heap[r].f < heap[best].f) best = r;
        if (best === i) break;
        const t = heap[best];
        heap[best] = heap[i];
        heap[i] = t;
        i = best;
      }
    }
    return top;
  }

  /** Nearest walkable tile to a world position (spiral search). */
  tileFromWorld(x, z, maxR = 10) {
    let tx = Math.floor((x - this.originX) / this.cell);
    let ty = Math.floor((z - this.originZ) / this.cell);
    if (this.walkable(tx, ty)) return { tx, ty };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.walkable(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
        }
      }
    }
    return null;
  }

  /**
   * Find a path. Returns an array of world-space {x,z} waypoints (excluding the
   * start, including the goal) or null when unreachable.
   */
  find(fromX, fromZ, toX, toZ, maxNodes = 6000) {
    // A stale route must never be reused: waypoints behind the agent would make
    // it turn around and oscillate instead of continuing forward.
    this.path = null;
    this.pathIdx = 0;
    // When the destination is physically inside a prop (someone standing on the
    // atrium dais, a crate dropped at their feet), no route can reach that exact
    // point. Rather than failing, aim for the standable tile closest to it so
    // the agent still closes in and can attack once it has line of sight.
    let goalX = toX;
    let goalZ = toZ;
    if (this.world && this.inSolid(goalX, goalZ)) {
      const alt = this.level.nearestWalkable(goalX, goalZ, 8);
      if (!alt) return null;
      goalX = alt.x;
      goalZ = alt.z;
    }
    const s = this.tileFromWorld(fromX, fromZ);
    const g = this.tileFromWorld(goalX, goalZ);
    if (!s || !g) return null;
    if (s.tx === g.tx && s.ty === g.ty) {
      // Same tile. Head straight for the target if that is actually walkable,
      // otherwise there is nothing sensible to do — return null so the caller
      // falls back to direct steering instead of receiving a route that is
      // just the agent's own position (which would freeze it in place).
      return this.lineClear(fromX, fromZ, goalX, goalZ) ? [{ x: goalX, z: goalZ }] : null;
    }
    toX = goalX;
    toZ = goalZ;

    const epoch = ++this.epoch;
    const W = this.w;
    const startIdx = this.idx(s.tx, s.ty);
    const goalIdx = this.idx(g.tx, g.ty);
    const { gScore, fScore, came, stamp, closed } = this;

    this.heap.length = 0;
    const hEst = (tx, ty) => {
      const dx = Math.abs(tx - g.tx);
      const dy = Math.abs(ty - g.ty);
      // octile distance
      return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
    };

    stamp[startIdx] = epoch;
    gScore[startIdx] = 0;
    fScore[startIdx] = hEst(s.tx, s.ty);
    came[startIdx] = -1;
    this._push({ i: startIdx, f: fScore[startIdx] });

    let expanded = 0;
    let found = false;

    while (this.heap.length && expanded < maxNodes) {
      const cur = this._pop();
      const ci = cur.i;
      if (closed[ci] === epoch) continue;
      closed[ci] = epoch;
      expanded++;
      if (ci === goalIdx) { found = true; break; }
      const cx = ci % W;
      const cy = (ci / W) | 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this._canStep(cx, cy, dx, dy)) continue;
          const ni = this.idx(nx, ny);
          if (closed[ni] === epoch) continue;
          const step = (dx && dy) ? SQRT2 : 1;
          const tentative = gScore[ci] + step;
          if (stamp[ni] === epoch && tentative >= gScore[ni]) continue;
          // Reset the parent the first time a node is touched in THIS search.
          // `came` is a shared scratch buffer, and leaving stale pointers in it
          // makes the reconstruction walk another query's chain — which looked
          // like "no path" for most agents.
          if (stamp[ni] !== epoch) came[ni] = -1;
          stamp[ni] = epoch;
          gScore[ni] = tentative;
          came[ni] = ci;
          const f = tentative + hEst(nx, ny);
          fScore[ni] = f;
          this._push({ i: ni, f });
        }
      }
    }

    if (!found) return null;

    // rebuild the tile chain
    const chain = [];
    let node = goalIdx;
    let guard = 0;
    while (node !== -1 && guard++ < 4096) {
      chain.push(node);
      node = came[node];
    }
    chain.reverse();

    const pts = chain.map((i) => {
      const tx = i % W;
      const ty = (i / W) | 0;
      return {
        x: this.originX + (tx + 0.5) * this.cell,
        z: this.originZ + (ty + 0.5) * this.cell,
      };
    });
    return this.buildRoute(fromX, fromZ, toX, toZ, pts);
  }

  /** Optional diagnostics attached to the last buildRoute() call. */
  _debugRoute(fromX, fromZ, toX, toZ, raw, free, route) {
    if (!this.debug) return;
    this.lastRoute = {
      from: [+fromX.toFixed(1), +fromZ.toFixed(1)],
      to: [+toX.toFixed(1), +toZ.toFixed(1)],
      raw: raw.map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]),
      free: free.map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]),
      route: route ? route.map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]) : null,
    };
  }

  /**
   * Turn a raw tile-centre chain into a walkable route.
   *
   * Invariant: every returned waypoint is free of solid geometry, and every
   * waypoint after the first is reachable from its predecessor in a straight
   * line. That is what makes the route followable — a waypoint buried in a
   * crate or stranded across a wall would make the agent push into it forever.
   *
   * The exact source position is used as the anchor when it is free (so the
   * agent does not first walk backwards to its own tile centre), otherwise the
   * first free chain point becomes the anchor and the approach from the
   * source is simply a straight steer.
   */
  buildRoute(fromX, fromZ, toX, toZ, rawPoints) {
    if (!rawPoints.length) return null;
    if (!this.world) return rawPoints.slice();

    const anchorFree = !this.inSolid(fromX, fromZ);
    const keep = (p) => !this.inSolid(p.x, p.z);
    const destFree = !this.inSolid(toX, toZ);
    const free = [];

    // The anchor is a waypoint we know we can stand on (unless the agent is
    // genuinely stuck inside something, in which case it steers out directly).
    if (anchorFree) free.push({ x: fromX, z: fromZ });
    for (const p of rawPoints) {
      if (!keep(p)) continue;
      const last = free[free.length - 1];
      if (last && Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) continue;
      free.push(p);
    }

    // The first free point must be reachable from the agent, otherwise the
    // agent is sealed in and there is nothing sensible to path to.
    if (free.length && (free[0].x !== fromX || free[0].z !== fromZ)) {
      if (!this.worldLineClear(fromX, fromZ, free[0].x, free[0].z, false)) return null;
    }
    if (!free.length) return null;

    // Follow the destination with the exact requested point when it is standable.
    if (destFree) {
      const tail = free[free.length - 1];
      if (Math.hypot(tail.x - toX, tail.z - toZ) > 0.05 &&
          this.worldLineClear(tail.x, tail.z, toX, toZ, true)) {
        free.push({ x: toX, z: toZ });
      }
    }

    // String pulling, collision aware.
    const route = [free[0]];
    let anchor = 0;
    let guard = 0;
    while (anchor < free.length - 1 && guard++ < free.length + 8) {
      let next = anchor + 1;
      for (let i = free.length - 1; i > anchor + 1; i--) {
        const last = i === free.length - 1;
        if (this.worldLineClear(free[anchor].x, free[anchor].z, free[i].x, free[i].z, last)) {
          next = i;
          break;
        }
      }
      route.push(free[next]);
      anchor = next;
    }

    // The agent's own position is not a destination: drop it when it leads.
    if (route.length > 1) {
      const first = route[0];
      if (Math.abs(first.x - fromX) < 1e-4 && Math.abs(first.z - fromZ) < 1e-4) route.shift();
    }
    this._debugRoute(fromX, fromZ, toX, toZ, rawPoints, free, route.length ? route : null);
    return route.length ? route : null;
  }

  /** True when a world position is inside solid map geometry. */
  inSolid(x, z, radius = 0.3) {
    if (!this.world) return false;
    const solid = (b) => b.meta && (b.meta.kind === 'wall' || b.meta.kind === 'prop');
    return this.world.overlaps(x, 0.1, z, radius, 0.8, solid);
  }

  /** Ray-march a segment through the collision world at body height. */
  worldLineClear(ax, az, bx, bz, isLast, radius = 0.16) {
    if (!this.world) return true;
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return true;
    // walls and props only: the floor/ceiling slabs span the whole map and
    // would report every probe as blocked
    const solid = (b) => b.meta && (b.meta.kind === 'wall' || b.meta.kind === 'prop');
    const steps = Math.max(2, Math.ceil(dist / (radius * 1.2)));
    // The final waypoint is the requested destination, which may legitimately
    // sit in space the nav grid calls blocked (inside the atrium dais, on top
    // of the catwalk). Only the segment leading to it has to be solid-free.
    const last = isLast ? steps : steps - 1;
    for (let i = 1; i <= last; i++) {
      const t = i / steps;
      const x = ax + dx * t;
      const z = az + dz * t;
      if (this.world.overlaps(x, 0.1, z, radius, 0.8, solid)) return false;
    }
    return true;
  }

  /**
   * Cheap grid-only clearance test: walks every cell the segment touches
   * (supercover traversal rather than fixed-step sampling, which can skip
   * straight over a thin wall). Used by A* expansion, where a collision-world
   * probe per neighbour would dominate the search cost.
   *
   * Endpoints are resolved with the same tolerance as tileFromWorld, so an
   * agent standing inside a solid tile (against a pylon, on a crate lip) can
   * still ask whether a route exists.
   */
  lineClear(ax, az, bx, bz) {
    if (!Number.isFinite(ax) || !Number.isFinite(az) || !Number.isFinite(bx) || !Number.isFinite(bz)) return false;
    const cell = this.cell;
    const gx = (x) => (x - this.originX) / cell;
    const gy = (z) => (z - this.originZ) / cell;

    // the walk starts from the nearest walkable cell to each endpoint
    const s = this.tileFromWorld(ax, az, 4);
    const g = this.tileFromWorld(bx, bz, 4);
    if (!s || !g) return false;
    let tx = s.tx;
    let ty = s.ty;
    const tx1 = g.tx;
    const ty1 = g.ty;
    if (tx === tx1 && ty === ty1) return true;

    // first grid crossing parameter for each axis, using the raw segment
    const dx = bx - ax;
    const dz = bz - az;
    if (dx === 0 && dz === 0) return true;

    const stepX = tx1 > tx ? 1 : tx1 < tx ? -1 : 0;
    const stepY = ty1 > ty ? 1 : ty1 < ty ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(cell / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(cell / dz) : Infinity;
    let tMaxX = stepX !== 0
      ? (((tx + (stepX > 0 ? 1 : 0)) * cell + this.originX) - ax) / dx
      : Infinity;
    let tMaxY = stepY !== 0
      ? (((ty + (stepY > 0 ? 1 : 0)) * cell + this.originZ) - az) / dz
      : Infinity;
    if (tMaxX < 0) tMaxX = 0;
    if (tMaxY < 0) tMaxY = 0;

    let guard = 0;
    const maxSteps = Math.abs(tx1 - tx) + Math.abs(ty1 - ty) + 4;
    while (guard++ < maxSteps) {
      if (tMaxX < tMaxY) { tx += stepX; tMaxX += tDeltaX; }
      else { ty += stepY; tMaxY += tDeltaY; }
      if (!this.walkable(tx, ty)) return false;
      if (tx === tx1 && ty === ty1) return true;
    }
    return this.walkable(tx1, ty1);
  }

  /**
   * String pulling: repeatedly try to connect the current anchor directly to
   * the furthest reachable waypoint, dropping everything in between. Uses the
   * collision-aware test so a shortcut can never cut through a crate.
   */
  simplify(points) {
    if (points.length <= 2) return points.slice();
    const out = [points[0]];
    let anchor = 0;
    let guard = 0;
    while (anchor < points.length - 1 && guard++ < points.length + 8) {
      let next = anchor + 1;
      for (let i = points.length - 1; i > anchor + 1; i--) {
        const last = i === points.length - 1;
        if (this.worldLineClear(points[anchor].x, points[anchor].z, points[i].x, points[i].z, last)) {
          next = i;
          break;
        }
      }
      out.push(points[next]);
      anchor = next;
    }
    // A route must always end at the requested destination, even when the
    // destination itself sits in space the grid calls blocked (standing on the
    // atrium dais, on the catwalk). Only the approach has to be clear.
    if (out.length && points.length) {
      const dest = points[points.length - 1];
      const tail = out[out.length - 1];
      if (tail.x !== dest.x || tail.z !== dest.z) out.push(dest);
    }
    return out;
  }
}
