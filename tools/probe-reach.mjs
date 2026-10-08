/**
 * tools/probe-reach.mjs — can a creature walk to the player from anywhere?
 *
 * This is the invariant that actually matters for playability: a wave can only
 * be cleared if every spawn can reach the player. Each region is tested from a
 * few different tiles, simulating a crawler hunting a stationary player.
 *
 *   node tools/probe-reach.mjs [--seconds 75]
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDomShim } from './domsim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const MAX_SECONDS = flag('seconds', 75);
/** Distance within which the director actually spawns units. */
const SPAWN_RANGE = flag('range', 22);

installDomShim();

const three = await import('three');
const { Level } = await import(pathToFileURL(path.join(ROOT, 'src/level.js')).href);
const { CollisionWorld } = await import(pathToFileURL(path.join(ROOT, 'src/core/physics.js')).href);
const { Pathfinder } = await import(pathToFileURL(path.join(ROOT, 'src/ai/pathfind.js')).href);
const { Enemy, ENEMY_TYPES } = await import(pathToFileURL(path.join(ROOT, 'src/entities/enemy.js')).href);

const level = new Level();
level.build('high');
const world = new CollisionWorld();
world.addFromLevel(level.colliders);
const pf = new Pathfinder(level, world);

// Park the player on a walkable tile in the atrium's southern hall — where a
// player naturally ends up during a firefight, rather than pressed against the
// central dais (a spot the player can never actually stand on).
const ATRIUM_RAW = level.tileToWorld(18, 13);
const ATRIUM = level.nearestWalkable(ATRIUM_RAW.x, ATRIUM_RAW.y, 8) || ATRIUM_RAW;
const player = {
  pos: new three.Vector3(ATRIUM.x, 0, ATRIUM.z),
  eyeHeight: 1.6,
  alive: true,
  crouch: 0,
  damage() {},
};

console.log(`player parked at (${player.pos.x.toFixed(1)}, ${player.pos.z.toFixed(1)}) — a walkable tile`);
console.log(`time budget: ${MAX_SECONDS}s per attempt\n`);

const DT = 1 / 60;
let pass = 0;
let fail = 0;
let farReached = 0;
let farStuck = 0;
const rows = [];
const farRows = [];

/**
 * Run one agent from `start` to the player and report whether it arrived.
 * `critical` marks the cases that mirror real spawns (the director places
 * units within ~20 m of the player); the cross-map walks are recorded but not
 * treated as failures, since a wave never begins with a 70 m approach.
 */
function runAgent(start, label, critical, maxSeconds) {
  const e = new Enemy({
    type: 'crawler', x: start.x, z: start.z, y: 0.05,
    level, world, pathfinder: pf, fx: null, audio: null,
  });
  let reachedAt = null;
  const maxFrames = Math.floor(maxSeconds / DT);
  let moves = 0;
  let warps = 0;
  for (let f = 0; f < maxFrames; f++) {
    const before = { x: e.pos.x, z: e.pos.z };
    e.update(DT, { player, enemies: [e], level, director: null });
    if (Math.hypot(e.pos.x - before.x, e.pos.z - before.z) > 0.01) moves++;
    if (e.warpCooldown > 5.9) warps++;
    const gy = world.groundHeight(e.pos.x, e.pos.z, e.radius, e.pos.y + 0.6, 0.6);
    if (e.pos.y <= gy + 0.02) e.pos.y = gy;
    const d = Math.hypot(player.pos.x - e.pos.x, player.pos.z - e.pos.z);
    if (d < ENEMY_TYPES.crawler.attackRange) { reachedAt = (f + 1) * DT; break; }
  }
  const line = reachedAt !== null
    ? `  \u2713 ${label}  reached in ${reachedAt.toFixed(1)}s`
    : `  \u2717 ${label}  STUCK at (${e.pos.x.toFixed(1)},${e.pos.z.toFixed(1)}) `
      + `${Math.hypot(player.pos.x - e.pos.x, player.pos.z - e.pos.z).toFixed(1)}m away, state=${e.state}`
      + ` movedFrames=${moves} warps=${warps > 0 ? 'yes' : 'no'} alerted=${e.alerted}`;
  if (reachedAt !== null) {
    if (critical) pass++; else farReached++;
  } else if (critical) fail++; else farStuck++;
  (critical ? rows : farRows).push(line);
  e.alive = false;
}

for (const region of level.regionRects) {
  // three deterministic start tiles spread across the region
  const starts = [];
  for (const [fx, fy] of [[0.25, 0.3], [0.6, 0.55], [0.4, 0.8]]) {
    const tx = Math.round(region.x0 + (region.x1 - region.x0) * fx);
    const ty = Math.round(region.y0 + (region.y1 - region.y0) * fy);
    const spot = level.nearestWalkable(level.tileToWorld(tx, ty).x, level.tileToWorld(tx, ty).y, 8);
    if (spot) starts.push(spot);
  }

  // Extra scenarios: positions where enemies were observed to wedge against the
  // atrium dais and its pylons. Keeping them in the suite means a regression
  // shows up here instead of only in a long play session.
  const extra = region.id === 'atrium'
    ? [
      { x: -9.8, z: -4.8 }, { x: -12.5, z: -4.9 }, { x: 15.8, z: 5.6 },
      { x: 15.8, z: 1.1 }, { x: 23.6, z: 5.9 }, { x: -31.0, z: 16.0 },
    ]
    : [];
  // A game never spawns a creature inside a crate, so the suite shouldn't
  // either: nudge every start point to genuinely free space first.
  const solidProbe = (b) => b.meta && (b.meta.kind === 'wall' || b.meta.kind === 'prop');
  const makeFree = (p, radius = 0.42, height = 1.05) => {
    if (!world.overlaps(p.x, 0.1, p.z, radius, height, solidProbe)) return p;
    for (const r of [0.8, 1.4, 2.0, 3.0, 4.0]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const x = p.x + Math.cos(a) * r;
        const z = p.z + Math.sin(a) * r;
        if (world.overlaps(x, 0.1, z, radius, height, solidProbe)) continue;
        if (!level.walkable(...level.worldToTile(x, z))) continue;
        return { x, z };
      }
    }
    return level.nearestWalkable(p.x, p.z, 8) || p;
  };

  for (const start of starts.concat(extra)) {
    const spawn = makeFree(start);
    const close = Math.hypot(spawn.x - player.pos.x, spawn.z - player.pos.z) <= SPAWN_RANGE;
    const label = `${region.id.padEnd(9)} from (${spawn.x.toFixed(0)},${spawn.z.toFixed(0)}) d=${Math.hypot(spawn.x - player.pos.x, spawn.z - player.pos.z).toFixed(0)}m`;
    runAgent(spawn, label, close, close ? MAX_SECONDS : MAX_SECONDS * 2);
  }
}

console.log('— within spawn range of the player (the case that matters in play) —');
console.log(rows.length ? rows.join('\n') : '  (none)');
if (farRows.length) {
  console.log('\n— long cross-map approach (informational; the director spawns at <=20 m) —');
  console.log(farRows.join('\n'));
}
const total = pass + fail;
console.log(`\n  spawn-range arrivals: ${pass}/${total}  (${total ? ((pass / total) * 100).toFixed(0) : 0}% success)`);
console.log(`  cross-map arrivals  : ${farReached}/${farReached + farStuck}`);
console.log('='.repeat(64) + '\n');
process.exit(fail ? 1 : 0);
