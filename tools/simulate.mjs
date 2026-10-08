/**
 * tools/simulate.mjs — headless gameplay simulation.
 *
 * Boots the real gameplay stack (level, collision, pathfinding, player,
 * enemies, projectiles, director) under Node with a DOM shim, then plays the
 * game for a few simulated minutes with a scripted bot. This catches runtime
 * errors that static analysis cannot: NaN transforms, stuck agents, runaway
 * entity counts, weapons that never fire, waves that never end.
 *
 *   node tools/simulate.mjs [--seconds 120] [--verbose]
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDomShim } from './domsim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const VERBOSE = argv.includes('--verbose');
const SECONDS = flag('seconds', 150);
const DT = 1 / 60;

installDomShim();

let failures = 0;
let checks = 0;
function ok(name, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}
function section(t) { console.log('\n\u2500\u2500 ' + t + ' ' + '\u2500'.repeat(Math.max(0, 60 - t.length))); }

const three = await import('three');
const { Level } = await import(pathToFileURL(path.join(ROOT, 'src/level.js')).href);
const { CollisionWorld } = await import(pathToFileURL(path.join(ROOT, 'src/core/physics.js')).href);
const { Player } = await import(pathToFileURL(path.join(ROOT, 'src/gameplay/player.js')).href);
const { Director } = await import(pathToFileURL(path.join(ROOT, 'src/gameplay/director.js')).href);
const { FX } = await import(pathToFileURL(path.join(ROOT, 'src/gfx/fx.js')).href);
const { HUD } = await import(pathToFileURL(path.join(ROOT, 'src/ui/hud.js')).href);
const { AudioEngine } = await import(pathToFileURL(path.join(ROOT, 'src/audio/audio.js')).href);
const { ENEMY_TYPES, ENEMY_DEBUG } = await import(pathToFileURL(path.join(ROOT, 'src/entities/enemy.js')).href);

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------
section('world setup');
const scene = new three.Scene();
const camera = new three.PerspectiveCamera(78, 16 / 9, 0.05, 700);
camera.rotation.order = 'YXZ';
scene.add(camera);

const level = new Level();
level.build('high');
scene.add(level.group);

const world = new CollisionWorld();
world.addFromLevel(level.colliders);
ok('level + collision built', level.colliders.length > 100, `${level.colliders.length} boxes`);

// fake input we can drive
class FakeInput {
  constructor() { this.keys = new Set(); this.pressedSet = new Set(); this.dx = 0; this.dy = 0; this.enabled = true; this.lock = false; this.mouse = { left: false, right: false, middle: false }; }
  isDown(c) { return this.keys.has(c); }
  wasPressed(c) { return this.pressedSet.has(c); }
  mouseDown(b) { return b === 0 ? this.mouse.left : b === 2 ? this.mouse.right : false; }
  mouseWasPressed(b) { return false; }
  axes() {
    let x = 0; let y = 0;
    if (this.keys.has('KeyW')) y += 1;
    if (this.keys.has('KeyS')) y -= 1;
    if (this.keys.has('KeyD')) x += 1;
    if (this.keys.has('KeyA')) x -= 1;
    const l = Math.hypot(x, y);
    return l ? { x: x / l, y: y / l } : { x: 0, y: 0 };
  }
  consumeLook() { const o = { yaw: this.dx, pitch: this.dy }; this.dx = 0; this.dy = 0; return o; }
  endFrame() { this.pressedSet.clear(); }
  requestLock() { this.lock = true; }
  exitLock() { this.lock = false; }
}
const input = new FakeInput();

const audio = new AudioEngine();      // no AudioContext under node -> play() is a no-op
const fx = new FX(scene, document.createElement('div'));
const hud = new HUD();

const player = new Player({ camera, world, input, audio, level, viewmodels: null });
// viewmodel meshes need canvas textures; skip the visual rig in simulation
const viewRigStub = { root: new three.Group(), parts: {}, muzzle: new three.Object3D(), eject: new three.Object3D() };
player.viewRigs.rifle = viewRigStub;
player.currentRig = viewRigStub;
player.viewGroup.add(viewRigStub.root);

const director = new Director({
  scene, camera, world, level, player, hud, fx, audio, input,
  settings: { fov: 78 }, ui: null,
});
player.director = director;

ok('gameplay stack constructed', !!director && !!player);

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
section(`simulation (${SECONDS}s of gameplay @${Math.round(1 / DT)}fps)`);

director.startRun();

const stats = {
  frames: 0,
  maxEnemies: 0,
  maxParticles: 0,
  errors: [],
  nan: 0,
  stuckFrames: 0,
  playerDeaths: 0,
  wavesSeen: new Set(),
  enemiesSpawned: 0,
  kills: 0,
  shots: 0,
  hits: 0,
  trace: [],
};

const origSpawn = director.spawnEnemy.bind(director);
director.spawnEnemy = (t, o) => { stats.enemiesSpawned++; return origSpawn(t, o); };

let simTime = 0;
let nextBotDecision = 0;
let botTarget = null;
let botStrafe = 1;
const diag = { samples: [], maxBd: 0, engagedTicks: 0, ticksWithTarget: 0, losBlocked: 0, wallHits: 0, enemyHits: 0, leashResets: 0 };

const tmp = new three.Vector3();

function botTick(t) {
  const p = player;
  if (!p.alive) return;
  // choose the nearest living enemy
  let best = null;
  let bd = Infinity;
  for (const e of director.enemies) {
    if (!e.alive) continue;
    const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
    if (d < bd) { bd = d; best = e; }
  }
  botTarget = best;
  if (best) {
    diag.ticksWithTarget++;
    diag.maxBd = Math.max(diag.maxBd, bd);
    if (!best.hasLos) diag.losBlocked++;
    else diag.engagedTicks++;
  }
  if (diag.samples.length < 12 && best && Math.random() < 0.25) {
    diag.samples.push({
      t: +t.toFixed(1),
      d: +bd.toFixed(1),
      los: best.hasLos,
      player: [+p.pos.x.toFixed(1), +p.pos.z.toFixed(1)],
      enemy: [+best.pos.x.toFixed(1), +best.pos.z.toFixed(1)],
      yaw: +p.yaw.toFixed(2),
    });
  }

  input.keys.clear();
  input.mouse.left = false;

  if (!best) {
    // patrol the atrium while waiting for the next spawn
    const c = level.tileToWorld(18, 10);
    steerTowards(c.x, c.y, 1);
    return;
  }

  // aim: only shoot when we actually have line of sight
  const dx = best.pos.x - p.pos.x;
  const dz = best.pos.z - p.pos.z;
  const dy = (best.pos.y + best.eyeHeight * 0.92) - (p.pos.y + p.eyeHeight);
  const wantYaw = Math.atan2(-dx, -dz);
  let diff = wantYaw - p.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const turnRate = 0.12;
  p.yaw += Math.max(-turnRate, Math.min(turnRate, diff));
  const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
  p.pitch += Math.max(-0.12, Math.min(0.12, wantPitch - p.pitch));

  const aimed = Math.abs(diff) < 0.10;
  if (best.hasLos && aimed && bd < 45) {
    input.mouse.left = true;
    stats.shotsFiredByBot++;
  }

  // Movement: stay in the atrium's neighbourhood. The harness bot is not the
  // subject of these tests — keeping it central means waves actually reach it
  // instead of the run stalling in a far corner.
  const leashX = level.tileToWorld(18, 10).x;
  const leashZ = level.tileToWorld(18, 10).y;
  const leashDist = Math.hypot(p.pos.x - leashX, p.pos.z - leashZ);
  if (leashDist > 26) {
    const spot = level.nearestWalkable(leashX, leashZ, 6);
    if (spot) { p.pos.set(spot.x, 0.05, spot.z); p.vel.set(0, 0, 0); }
    diag.leashResets++;
    botPath = null;
    botPathT = 0;
  } else if (leashDist > 12) {
    steerTowards(leashX, leashZ, 1);
  } else if (!best.hasLos || bd > 16) {
    steerTowards(best.pos.x, best.pos.z, 1);
  } else if (bd < 6) {
    steerTowards(best.pos.x, best.pos.z, -1);
    if (Math.floor(t / 1.5) % 2 === 0) input.keys.add('KeyD'); else input.keys.add('KeyA');
  } else if (Math.floor(t / 1.5) % 2 === 0) {
    input.keys.add('KeyD');
  } else {
    input.keys.add('KeyA');
  }

  // reload / weapon swapping
  const w = p.weapon;
  if (w.ammo === 0 || (w.ammo < w.magSize * 0.3 && w.reserve > 0 && Math.random() < 0.08)) p.startReload();
  if (Math.random() < 0.002) p.throwGrenade();
  if (Math.random() < 0.001) p.melee();
}

/** Drive the fake input along an A* route to a world position. */
let botPath = null;
let botPathT = 0;
function steerTowards(tx, tz, dirSign = 1) {
  const p = player;
  botPathT -= 0.1;
  const direct = director.pf.lineClear(p.pos.x, p.pos.z, tx, tz, 0.8);
  if (direct || botPathT <= 0 || !botPath || !botPath.length) {
    botPathT = 0.5;
    botPath = direct ? null : director.pf.find(p.pos.x, p.pos.z, tx, tz);
  }
  let gx = tx;
  let gz = tz;
  if (botPath && botPath.length) {
    gx = botPath[0].x;
    gz = botPath[0].z;
    if (Math.hypot(gx - p.pos.x, gz - p.pos.z) < 1.0) {
      botPath.shift();
      if (botPath.length) { gx = botPath[0].x; gz = botPath[0].z; }
    }
  }
  const dx = gx - p.pos.x;
  const dz = gz - p.pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.4) return;
  // convert world direction into WASD relative to the current facing
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);
  const nx = (dx / len) * dirSign;
  const nz = (dz / len) * dirSign;
  const fwd = nx * fx + nz * fz;
  const right = nx * rx + nz * rz;
  if (fwd > 0.25) input.keys.add('KeyW');
  else if (fwd < -0.25) input.keys.add('KeyS');
  if (right > 0.25) input.keys.add('KeyD');
  else if (right < -0.25) input.keys.add('KeyA');
  if (Math.random() < 0.05) input.keys.add('ShiftLeft');
}

const playerPositions = [];
const t0 = Date.now();
const totalFrames = Math.floor(SECONDS / DT);

for (let f = 0; f < totalFrames; f++) {
  simTime += DT;
  stats.frames++;

  try {
    if (simTime >= nextBotDecision) {
      nextBotDecision = simTime + 0.1;
      botTick(simTime);
    }
    director.update(DT);
    player.handleInput(DT);
    player.update(DT);
    fx.update(DT, camera);
    level.update(DT);
    camera.updateMatrixWorld(true);

    // state feeding the HUD (exercises that path too)
    const hs = director.hudState(DT);
    hud.update(hs);
    input.endFrame();
  } catch (e) {
    stats.errors.push(`${simTime.toFixed(1)}s: ${e.stack || e.message}`);
    if (stats.errors.length > 4) break;
  }

  stats.wavesSeen.add(director.wave);
  stats.maxEnemies = Math.max(stats.maxEnemies, director.enemies.length);
  stats.maxParticles = Math.max(stats.maxParticles, fx.particles.active);

  // NaN / sanity probe on every transform we own
  const bad = [player.pos, player.vel, camera.position].some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z));
  if (bad) {
    stats.nan++;
    if (stats.nan < 3) stats.errors.push(`${simTime.toFixed(1)}s: NaN transform player=${player.pos.toArray().join(',')}`);
  }
  for (const e of director.enemies) {
    if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.z) || !Number.isFinite(e.yaw)) {
      stats.nan++;
      stats.errors.push(`${simTime.toFixed(1)}s: NaN enemy ${e.type}`);
      break;
    }
  }

  if (f % 60 === 0) playerPositions.push([player.pos.x, player.pos.z]);
  if (f % (60 * 20) === 0) {
    const near = director.enemies.filter((e) => e.alive)
      .map((e) => `${e.type}@${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)} hp${Math.round(e.health)} ${e.state} los=${e.hasLos ? 1 : 0}`)
      .join(' ');
    stats.trace.push(`t=${simTime.toFixed(0)}s wave=${director.wave} q=${director.spawnQueue.length} alive=${director.aliveCount()} kills=${director.kills} bot=(${player.pos.x.toFixed(0)},${player.pos.z.toFixed(0)}) hp=${player.stats.health.toFixed(0)} ${near}`);
  }
  if (!player.alive) stats.playerDeaths++;
}

const wall = Date.now() - t0;

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------
section('simulation results');
ok('no runtime errors during simulation', stats.errors.length === 0, stats.errors.slice(0, 3).join(' | '));
ok('no NaN transforms', stats.nan === 0, `${stats.nan} occurrences`);
ok('frames simulated', stats.frames === totalFrames, `${stats.frames} frames`);
ok('real-time budget headroom', wall / stats.frames < 16, `${(wall / stats.frames).toFixed(2)}ms per frame (headless, no GPU)`);

ok('player stayed inside the facility',
  player.pos.x > level.bounds.minX && player.pos.x < level.bounds.maxX &&
  player.pos.z > level.bounds.minZ && player.pos.z < level.bounds.maxZ,
  `pos=(${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(2)}, ${player.pos.z.toFixed(1)})`);
ok('player never fell through the floor', player.pos.y > -1, `y=${player.pos.y.toFixed(2)}`);
ok('player actually moved', new Set(playerPositions.map((p) => p.map((v) => v.toFixed(0)).join(','))).size > 12,
  `${new Set(playerPositions.map((p) => p.map((v) => v.toFixed(0)).join(','))).size} distinct positions`);

// The scripted bot aims far worse than a human, so these only assert that the
// wave machinery actually runs. Combat lethality is asserted in its own section
// below, where shots are aimed precisely.
ok('enemies spawned', stats.enemiesSpawned >= 4, `${stats.enemiesSpawned} spawned`);
ok('enemy population capped', stats.maxEnemies <= 40, `peak ${stats.maxEnemies}`);
ok('enemies were killed', director.kills >= 2, `${director.kills} kills`);
ok('wave machinery advanced', director.wave >= 1 && director.waveTotal > 0,
  `wave ${director.wave}, ${director.waveTotal} units scheduled`);

const aliveEnemies = director.enemies.filter((e) => e.alive);
ok('no enemy escaped the map', aliveEnemies.every((e) =>
  e.pos.x > level.bounds.minX - 2 && e.pos.x < level.bounds.maxX + 2 &&
  e.pos.z > level.bounds.minZ - 2 && e.pos.z < level.bounds.maxZ + 2),
`${aliveEnemies.length} alive`);
ok('no enemy below the floor', aliveEnemies.every((e) => e.pos.y > -1.5));
// Walls and props only: floor/ceiling slabs span the whole map, so including
// them would flag every agent standing on the ground.
const solidOnly = (b) => b.meta && (b.meta.kind === 'wall' || b.meta.kind === 'prop');
const embedded = aliveEnemies.filter((e) =>
  world.overlaps(e.pos.x, e.pos.y + 0.05, e.pos.z, e.radius, e.height, solidOnly));
ok('no enemy inside geometry', embedded.length === 0,
  `${embedded.length} embedded${embedded.length ? ': ' + embedded.map((e) => `${e.type}@${e.pos.x.toFixed(1)},${e.pos.z.toFixed(1)}`).join(' ') : ''}`);

ok('projectile count bounded', director.projectiles.bolts.length + director.projectiles.grenades.length < 120,
  `${director.projectiles.bolts.length + director.projectiles.grenades.length} live`);
ok('pickup count bounded', director.pickups.items.length < 90, `${director.pickups.items.length} on the floor`);
ok('particle pool not exhausted', fx.particles.active < 4000, `${fx.particles.active} active`);
ok('combo system engaged', director.combo >= 1, `combo x${director.combo.toFixed(2)}`);
ok('economy ran', director.runCreditsEarned > 0, `${Math.round(director.runCreditsEarned)} credits earned`);

// weapon cycle: every weapon must be able to fire
section('weapon live-fire (every variant)');
for (const id of Object.keys(player.weapons)) {
  const w = player.weapons[id];
  player.giveWeapon(id);
  const before = director.shotsFired;
  w.ammo = w.magSize;
  w.cooldown = 0;
  const spread = w.spreadFor({});
  const origin = player.eyePos(new three.Vector3());
  const dir = new three.Vector3(0, 0, -1).applyEuler(new three.Euler(player.pitch, player.yaw, 0, 'YXZ'));
  const okFire = w.tryFire();
  director.fireWeapon({
    player, weapon: w, def: w.def, origin, dir, spread,
    pellets: w.def.pellets, damage: w.damage, range: w.def.range,
    falloff: w.def.falloff, pierce: w.def.pierce, headMul: w.def.headMul * player.mods.headMul,
    projectile: w.def.projectile || null,
  });
  ok(`${id} fires`, okFire && director.shotsFired === before + 1, `${w.def.pellets} pellet(s)`);
}

// pickups
section('pickup collection');
const probe = level.nearestWalkable(player.pos.x, player.pos.z, 5) || { x: player.pos.x, z: player.pos.z };
player.pos.set(probe.x, 0, probe.z);
player.stats.health = 40;
director.pickups.spawn('health', player.pos.x, 0, player.pos.z);
director.pickups.spawn('credits', player.pos.x, 0, player.pos.z, { amount: 55 });
const creditsBefore = director.credits;
for (let i = 0; i < 30; i++) {
  director.pickups.update(DT, { player, enemies: director.enemies, director, fx, audio, level, world });
}
ok('health pickup heals', player.stats.health > 40, `hp=${player.stats.health.toFixed(1)}`);
ok('credit pickup pays out', director.credits > creditsBefore, `+${Math.round(director.credits - creditsBefore)}`);

// armoury
section('armoury');
const items = director.shopItems();
ok('shop lists items', items.length > 8, `${items.length} entries`);
director.credits = 999999;
for (const it of director.shopItems()) director.buy(it);
const allOwned = Object.values(player.weapons).every((w) => w.owned);
ok('every weapon purchasable', allOwned, `${player.loadout.length} owned`);
const afterBuy = director.shopItems();
ok('owned items leave the shop', afterBuy.filter((i) => i.kind === 'weapon').length === 0);

// player damage + death
section('player survivability');
player._god = false;
player.stats.health = player.stats.maxHealth;
player.stats.armor = player.stats.maxArmor;
const hp0 = player.stats.health;
const dealt = player.damage(30, { x: player.pos.x + 3, z: player.pos.z });
ok('damage applies through armour', dealt < 30 && player.stats.health < hp0, `${dealt.toFixed(1)} to health`);
let guard = 0;
while (player.alive && guard++ < 400) player.damage(25, { x: 0, z: 0 });
ok('player can die', !player.alive, `${guard} hits`);
player.respawnAt({ x: probe.x, y: 0, z: probe.z });
ok('respawn restores state', player.alive && player.stats.health === player.stats.maxHealth);

// boss encounter
section('boss encounter');
director.wave = 12;
director.waveCfg = { hp: 1, speed: 1, dmg: 1, maxAlive: 30 };
director.spawnQueue = [];
const boss = director.spawnEnemy('overloader', { spot: { x: probe.x + 14, z: probe.z + 6 }, minDistance: 0 });
ok('boss spawns', !!boss && boss.def.boss, boss?.def.name);
ok('boss bar state exposed', !!director.hudState(DT).boss);
boss.health = 1;
boss.takeDamage(999, { sourcePos: new three.Vector3(), fromDir: new three.Vector3(1, 0, 0) });
ok('boss dies', !boss.alive);
// let the death animation finish
for (let i = 0; i < 200; i++) director.update(DT);
ok('boss removed after死亡 animation', !director.enemies.includes(boss));

// ---------------------------------------------------------------------------
// combat lethality: an aimed burst must actually kill things, and headshots
// must hurt more than body shots. This is the measurement the scripted bot is
// too inaccurate to provide.
// ---------------------------------------------------------------------------
section('combat lethality');
{
  // Run these in a controlled arena. The bot wanders, and depending on where it
  // stops there may be no clear sight line to place a target — which would make
  // the damage assertions measure level geometry instead of combat.
  const originalPos = player.pos.clone();
  const arena = level.nearestWalkable(level.tileToWorld(18, 12).x, level.tileToWorld(18, 12).y, 8)
    || { x: player.pos.x, z: player.pos.z };
  player.pos.set(arena.x, 0, arena.z);
  player.vel.set(0, 0, 0);
  player.stats.health = player.stats.maxHealth;
  director.state = 'combat';
  console.log(`    [arena] relocated player to (${arena.x.toFixed(1)}, ${arena.z.toFixed(1)})`);

  const aimDir = new three.Vector3();
  const shootAt = (enemy, { head = false, shots = 1, weaponId = 'rifle', step = false } = {}) => {
    player.giveWeapon(weaponId);
    player.equip(weaponId, true);
    const w = player.weapons[weaponId];
    const hpBefore = enemy.health;
    for (let i = 0; i < shots; i++) {
      w.ammo = w.magSize;
      w.cooldown = 0;
      const origin = player.eyePos(new three.Vector3());
      const targetY = enemy.pos.y + (head ? enemy.eyeHeight : enemy.height * 0.5);
      aimDir.set(enemy.pos.x - origin.x, targetY - origin.y, enemy.pos.z - origin.z).normalize();
      w.tryFire();
      director.fireWeapon({
        player, weapon: w, def: w.def, origin, dir: aimDir.clone(), spread: 0,
        pellets: w.def.pellets, damage: w.damage, range: w.def.range,
        falloff: w.def.falloff, pierce: w.def.pierce, headMul: w.def.headMul * player.mods.headMul,
        projectile: w.def.projectile || null,
      });
      // Projectile weapons need the simulation to advance so the bolt travels.
      if (w.def.projectile || step) {
        for (let k = 0; k < 30; k++) {
          director.projectiles.update(DT, { player, enemies: [enemy], level, director, fx, audio, world });
          if (!enemy.alive) break;
        }
      }
    }
    return hpBefore - enemy.health;
  };

  /**
   * Place a target straight ahead of the player at a distance with clear line of
   * sight, the way a real firefight looks — rather than wherever the nearest
   * walkable tile happens to be. Retries until the sight line is genuinely
   * clear so the test measures damage, not level geometry.
   */
  const spawnDummy = (type = 'crawler', dist = 9) => {
    const probe = level.nearestWalkable(player.pos.x, player.pos.z, 4) || { x: player.pos.x, z: player.pos.z };
    baseX = probe.x;
    baseZ = probe.z;
    const solidOnly = (b) => b.meta && (b.meta.kind === 'wall' || b.meta.kind === 'prop');
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const angle of [0, 0.35, -0.35, 0.7, -0.7, Math.PI / 2, -Math.PI / 2, Math.PI, 1.2, -1.2]) {
        const jitter = attempt * 0.5;
        const sx = baseX + Math.cos(angle) * (dist + jitter);
        const sz = baseZ + Math.sin(angle) * (dist + jitter);
        const wl = level.nearestWalkable(sx, sz, 4);
        if (!wl) continue;
        if (world.overlaps(wl.x, 0.1, wl.z, 0.5, 1.1, solidOnly)) continue;
        if (!world.lineOfSight(
          new three.Vector3(baseX, 1.5, baseZ),
          new three.Vector3(wl.x, 0.6, wl.z),
          solidOnly,
        )) continue;
        const e = director.spawnEnemy(type, { spot: { x: wl.x, z: wl.z }, minDistance: 0 });
        e.alerted = false;
        e.hasLos = true;
        return e;
      }
    }
    const fallback = level.nearestWalkable(baseX + dist, baseZ, 6) || { x: baseX + dist, z: baseZ };
    const e = director.spawnEnemy(type, { spot: fallback, minDistance: 0 });
    e.alerted = false;
    e.hasLos = true;
    return e;
  };
  let baseX = player.pos.x;
  let baseZ = player.pos.z;

  // Damage multiplier needs a target that survives one hit, otherwise the
  // multiplier is invisible (a crawler dies to a single body shot either way).
  const bodyDmg = (() => {
    const e = spawnDummy('brute');
    const d = shootAt(e, { head: false, shots: 1 });
    e.health = 0; e.alive = false;
    return d;
  })();
  const headDmg = (() => {
    const e = spawnDummy('brute');
    const d = shootAt(e, { head: true, shots: 1 });
    e.health = 0; e.alive = false;
    return d;
  })();
  ok('body shot registers damage', bodyDmg > 5, `${bodyDmg.toFixed(1)} damage to a brute`);
  ok('headshot multiplies damage', headDmg > bodyDmg * 1.5, `${headDmg.toFixed(1)} vs ${bodyDmg.toFixed(1)}`);

  const killTarget = spawnDummy('crawler', 8);
  const kills0 = director.kills;
  let shotsUsed = 0;
  for (let i = 0; i < 40 && killTarget.alive; i++) { shootAt(killTarget, { head: true, shots: 1 }); shotsUsed++; }
  ok('a crawler dies from aimed fire', !killTarget.alive, `${shotsUsed} shots`);
  ok('kill is credited', director.kills > kills0, `${director.kills - kills0} kill(s)`);

  // every weapon must be able to kill a crawler
  const weaponKills = [];
  for (const id of Object.keys(player.weapons)) {
    const target = spawnDummy('crawler', 7);
    let n = 0;
    while (target.alive && n < 60) { shootAt(target, { head: true, shots: 1, weaponId: id }); n++; }
    weaponKills.push(`${id}:${target.alive ? 'FAIL' : n}`);
    if (target.alive) { target.health = 0; target.alive = false; }
  }
  ok('every weapon can kill a crawler', !weaponKills.some((s) => s.includes('FAIL')), weaponKills.join(' '));

  // explosive ordnance: the fuse is driven by director.update, which also steps
  // the projectiles, so run the real loop rather than only the bolt pool
  // Pin the wave configuration so the test does not inherit late-wave scaling.
  director.wave = 3;
  director.waveCfg = { hp: 1, speed: 1, dmg: 1, maxAlive: 30 };
  // Build an explicit cluster around a known point so the blast radius is
  // actually exercised, rather than relying on where spawnDummy lands.
  const anchor = level.nearestWalkable(player.pos.x, player.pos.z, 5) || { x: player.pos.x, z: player.pos.z };
  const cluster = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const spot = level.nearestWalkable(anchor.x + Math.cos(a) * 1.6, anchor.z + Math.sin(a) * 1.6, 3) || anchor;
    const e = director.spawnEnemy('crawler', { spot, minDistance: 0 });
    e.alerted = false;
    cluster.push(e);
  }
  const clusterRadius = Math.max(...cluster.map((e) =>
    Math.hypot(e.pos.x - (cluster[0]?.pos.x ?? 0), e.pos.z - (cluster[0]?.pos.z ?? 0))));
  // make the dummies unkillable so the director does not reap them mid-test
  for (const e of cluster) e.health = 1e9;
  const hpBefore = cluster.map((e) => e.health);
  player.pos.set(baseX, 0, baseZ);
  const target = cluster[0];
  director.spawnGrenade(
    new three.Vector3(target.pos.x, 1.2, target.pos.z),
    new three.Vector3(0, 0, 0),
  );
  for (let i = 0; i < 300; i++) {
    // the run may have ended during the earlier phases; combat resolution and
    // projectile stepping only happen while the mission is live
    director.state = 'combat';
    player.stats.health = player.stats.maxHealth;
    director.update(DT);
    if (VERBOSE && i === 150) {
      const g = director.projectiles.grenades[0];
      console.log('    [grenade] live', director.projectiles.grenades.length,
        'pos', g ? g.pos.toArray().map((v) => +v.toFixed(2)).join(',') : 'n/a',
        'fuse', g ? g.fuse.toFixed(2) : 'n/a',
        'target', target.pos.x.toFixed(2), target.pos.z.toFixed(2));
    }
  }
  if (VERBOSE) console.log('    [grenade] hp after:', cluster.map((e) => Math.round(e.health)).join(','));
  const damaged = cluster.filter((e, i) => e.health < hpBefore[i] || !e.alive).length;
  ok('grenade damages a cluster', damaged >= 2, `${damaged}/4 affected`);
  for (const e of cluster) { e.alive = false; e.health = 0; }
  // clear any lingering grenades so later assertions see a clean world
  director.projectiles.clear();

  // restore the player to where the run left them
  player.pos.copy(originalPos);
  director.clearEnemies();
}
console.log('\n  wave reached     :', director.wave);
console.log('  kills            :', director.kills);
console.log('  enemies spawned  :', stats.enemiesSpawned);
console.log('  peak alive       :', stats.maxEnemies);
console.log('  shots fired      :', director.shotsFired);
console.log('  accuracy         :', director.shotsFired ? ((director.shotsHit / director.shotsFired) * 100).toFixed(1) + '%' : 'n/a');
console.log('  score            :', Math.round(director.score));
console.log('  credits earned   :', Math.round(director.runCreditsEarned));
console.log('  peak particles   :', stats.maxParticles);
if (VERBOSE) {
  console.log('  engagement diag  :', JSON.stringify({
    ticksWithTarget: diag.ticksWithTarget,
    engaged: diag.engagedTicks,
    losBlocked: diag.losBlocked,
    maxBd: +diag.maxBd.toFixed(1),
  }));
  console.log('  --- trace ---');
  for (const line of stats.trace) console.log('   ', line);
  console.log('  nav counters     :', JSON.stringify(ENEMY_DEBUG));
  console.log('  player final     :', player.pos.toArray().map((v) => +v.toFixed(1)).join(','));
  console.log('  enemies          :', director.enemies.map((e) => `${e.type}@${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)} hp${Math.round(e.health)} ${e.state}`).join(' '));
}

console.log('\n' + '='.repeat(64));
console.log(`  ${checks - failures}/${checks} checks passed`);
console.log('='.repeat(64) + '\n');
process.exit(failures ? 1 : 0);
