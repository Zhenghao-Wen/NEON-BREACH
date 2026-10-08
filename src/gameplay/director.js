/**
 * director.js — the game itself.
 *
 * Owns the wave schedule, enemy population, combat resolution, economy and the
 * armoury. The player, HUD and FX are driven from here so that the rules of the
 * game live in exactly one place.
 */
import * as THREE from 'three';
import { Enemy, ENEMY_TYPES, chooseSpawn } from '../entities/enemy.js';
import { ProjectileManager } from '../entities/projectiles.js';
import { PickupManager } from '../entities/pickups.js';
import { WEAPONS, WEAPON_BY_ID, UPGRADES, buildViewModel } from './weapons.js';
import { Pathfinder } from '../ai/pathfind.js';

const INTERMISSION_TIME = 30;
const TOTAL_WAVES = 12;

/** Wave composition table. `cost` is the spawn budget spent on enemy types. */
const WAVE_TABLE = [
  { types: ['crawler'], cost: 5, maxAlive: 14, hp: 1.0, speed: 1.0, dmg: 1.0 },
  { types: ['crawler', 'spitter'], cost: 8, maxAlive: 16, hp: 1.06, speed: 1.02, dmg: 1.05 },
  { types: ['crawler', 'spitter', 'drone'], cost: 12, maxAlive: 19, hp: 1.12, speed: 1.04, dmg: 1.1 },
  { types: ['crawler', 'stalker', 'drone'], cost: 15, maxAlive: 22, hp: 1.2, speed: 1.07, dmg: 1.16 },
  { types: ['crawler', 'stalker', 'spitter', 'shield'], cost: 19, maxAlive: 24, hp: 1.3, speed: 1.1, dmg: 1.22 },
  { types: ['crawler', 'brute', 'drone', 'spitter'], cost: 23, maxAlive: 24, hp: 1.42, speed: 1.12, dmg: 1.28, boss: 'warden' },
  { types: ['stalker', 'drone', 'shield', 'brute'], cost: 27, maxAlive: 26, hp: 1.56, speed: 1.15, dmg: 1.34 },
  { types: ['crawler', 'stalker', 'spitter', 'shield', 'brute'], cost: 32, maxAlive: 28, hp: 1.72, speed: 1.18, dmg: 1.42 },
  { types: ['drone', 'shield', 'brute', 'stalker'], cost: 37, maxAlive: 30, hp: 1.9, speed: 1.2, dmg: 1.5 },
  { types: ['crawler', 'stalker', 'drone', 'spitter', 'brute', 'shield'], cost: 43, maxAlive: 32, hp: 2.1, speed: 1.24, dmg: 1.6, boss: 'warden' },
  { types: ['stalker', 'brute', 'shield', 'drone', 'spitter'], cost: 50, maxAlive: 34, hp: 2.35, speed: 1.28, dmg: 1.7 },
  { types: ['crawler', 'stalker', 'drone', 'brute', 'shield', 'spitter'], cost: 60, maxAlive: 36, hp: 2.6, speed: 1.32, dmg: 1.85, boss: 'overloader', final: true },
];

const SPAWN_COST = { crawler: 1, spitter: 2, drone: 2.5, stalker: 3, brute: 5, shield: 5, warden: 22, overloader: 40 };

export class Director {
  constructor({ scene, camera, world, level, player, hud, fx, audio, input, settings, ui }) {
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.level = level;
    this.player = player;
    this.hud = hud;
    this.fx = fx;
    this.audio = audio;
    this.input = input;
    this.settings = settings;
    this.ui = ui;

    this.pf = new Pathfinder(level, world);
    this.projectiles = new ProjectileManager(scene);
    this.pickups = new PickupManager(scene);
    this.enemies = [];

    this.state = 'menu';       // menu | combat | intermission | gameover | victory
    this.wave = 0;
    this.score = 0;
    this.credits = 600;
    this.kills = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.timePlayed = 0;
    this.waveTime = 0;
    this.intermissionT = 0;
    this.spawnTimer = 0;
    this.spawnQueue = [];
    this.combo = 1;
    this.comboT = 0;
    this.comboMaxT = 6;
    this.runCreditsEarned = 0;
    this.boss = null;
    this.powerups = new Map();
    this.lastStandUsed = false;
    this.log = [];
    this.settings = settings || {};
    this.settings.fov = this.settings.fov ?? 78;

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._shootScratch = [];
    this.hitStop = 0;
    this.screenShake = 0;
    this.timeScale = 1;
  }

  buildViewModel(id) { return buildViewModel(id); }

  // ------------------------------------------------------------------ control
  startRun() {
    this.state = 'combat';
    this.wave = 0;
    this.score = 0;
    this.credits = 600;
    this.kills = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.timePlayed = 0;
    this.combo = 1;
    this.comboT = 0;
    this.runCreditsEarned = 0;
    this.lastStandUsed = false;
    this.log.length = 0;
    this.powerups.clear();
    this.clearEnemies();
    this.projectiles.clear();
    this.pickups.clear();
    this.fx.clear();
    for (const w of Object.values(this.player.weapons)) {
      w.owned = w.def.id === 'rifle';
      w.ammo = w.magSize;
      w.reserve = Math.min(w.reserveMax, Math.round((w.def.startReserve ?? w.magSize * 2) * this.player.mods.reserve));
      w.cancelReload();
    }
    this.player.loadout = ['rifle'];
    this.player.upgrades.clear();
    this.player.mods = { damage: 1, rpm: 1, mag: 1, reserve: 1, reload: 1, recoil: 1, spread: 1, speed: 1, headMul: 1, regen: 0, lifesteal: 0, luck: 1 };
    this.player.stats.maxHealth = 100;
    this.player.stats.maxArmor = 50;
    this.player.grenades = 3;
    const spawn = this.level.nearestWalkable(
      this.level.tileToWorld(18, 10).x + 6,
      this.level.tileToWorld(18, 10).y + 3,
    ) || { x: 0, z: 0 };
    this.player.respawnAt({ x: spawn.x, y: 0, z: spawn.z });
    this.player.equip('rifle', true);
    this.startWave(1);
    this.audio?.startAmbient();
  }

  startWave(n) {
    this.wave = n;
    this.waveTime = 0;
    this.state = 'combat';
    this.spawnQueue = [];
    this.buildWave(n);
    this.audio?.play('waveStart');
    this.hud?.announce(`第 ${n} 波`, n === TOTAL_WAVES ? 'FINAL WAVE — 过载核心' : `WAVE ${n} / ${TOTAL_WAVES}`, 2.8);
    this.audio?.setIntensity(Math.min(1, 0.25 + n / TOTAL_WAVES));
    // guaranteed supply drop for the new wave
    this.spawnSupplyDrop(2 + Math.floor(n / 3));
  }

  buildWave(n) {
    const cfg = WAVE_TABLE[Math.min(WAVE_TABLE.length - 1, n - 1)];
    let budget = cfg.cost;
    const queue = [];
    if (cfg.boss) {
      queue.push(cfg.boss);
      budget = Math.max(0, budget - SPAWN_COST[cfg.boss] * 0.45);
    }
    const pool = cfg.types;
    let guard = 0;
    while (budget > 1 && guard++ < 400) {
      const type = pool[(Math.random() * pool.length) | 0];
      const cost = SPAWN_COST[type];
      if (cost > budget + 1.5) {
        // buy the cheapest instead of wasting the budget
        const cheapest = pool.reduce((a, b) => (SPAWN_COST[a] < SPAWN_COST[b] ? a : b));
        if (SPAWN_COST[cheapest] > budget) break;
        queue.push(cheapest);
        budget -= SPAWN_COST[cheapest];
        continue;
      }
      queue.push(type);
      budget -= cost;
    }
    // shuffle so waves do not arrive in a fixed order
    for (let i = queue.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = queue[i];
      queue[i] = queue[j];
      queue[j] = t;
    }
    this.spawnQueue = queue;
    this.waveCfg = cfg;
    this.waveTotal = queue.length;
  }

  endWave() {
    this.state = 'intermission';
    this.intermissionT = INTERMISSION_TIME;
    const bonus = 250 + this.wave * 180;
    this.addScore(bonus);
    const creditBonus = 300 + this.wave * 140;
    this.addCredits(creditBonus);
    this.audio?.play('waveClear');
    this.audio?.setIntensity(0.15);
    this.hud?.announce(`第 ${this.wave} 波已清除`, `奖励 +${bonus} 分 / +${creditBonus} 信用点`, 3.4);
    this.spawnSupplyDrop(4);
    this.player.stats.armor = Math.min(this.player.stats.maxArmor, this.player.stats.armor + 15);
    if (this.wave >= TOTAL_WAVES && !this.endless) {
      this.victory();
    }
  }

  victory() {
    this.state = 'victory';
    this.audio?.stopAmbient();
    this.ui?.showVictory(this.stats());
  }

  gameOver() {
    this.state = 'gameover';
    this.audio?.stopAmbient();
    this.ui?.showGameOver(this.stats());
  }

  stats() {
    return {
      wave: this.wave,
      score: Math.round(this.score),
      kills: this.kills,
      headshots: this.headshots,
      accuracy: this.shotsFired > 0 ? (this.shotsHit / this.shotsFired) * 100 : 0,
      damageDealt: Math.round(this.damageDealt),
      damageTaken: Math.round(this.damageTaken),
      time: this.timePlayed,
      credits: this.credits,
    };
  }

  addScore(n) {
    this.score += n * (1 + (this.combo - 1) * 0.5);
  }

  addCredits(n) {
    const amount = Math.round(n * this.player.mods.luck);
    this.credits += amount;
    this.runCreditsEarned += amount;
    return amount;
  }

  // ---------------------------------------------------------------- spawning
  aliveCount() {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  spawnEnemy(type, opts = {}) {
    const cfg = this.waveCfg || WAVE_TABLE[0];
    const spot = opts.spot || chooseSpawn(this.level, this.player.pos, {
      minDistance: opts.minDistance ?? (ENEMY_TYPES[type].boss ? 26 : 20),
      preferRegions: opts.preferRegions,
    });
    const e = new Enemy({
      type,
      x: spot.x,
      z: spot.z,
      y: ENEMY_TYPES[type].hover ? ENEMY_TYPES[type].hover : 0.05,
      level: this.level,
      world: this.world,
      pathfinder: this.pf,
      fx: this.fx,
      audio: this.audio,
      hpScale: cfg.hp * (this.endless ? 1.35 : 1),
      speedScale: cfg.speed,
      damageScale: cfg.dmg,
    });
    e.wave = this.wave;
    this.enemies.push(e);
    this.scene.add(e.root);
    if (ENEMY_TYPES[type].boss) {
      this.boss = e;
      this.audio?.play('bossSpawn');
      this.hud?.announce(ENEMY_TYPES[type].name, 'BOSS ENGAGED', 3.2);
      this.fx?.explosion(e.center, 2.5);
    } else {
      this.fx?.particles.burst(e.center, new THREE.Vector3(0, 1, 0), {
        count: 18, speed: 4, spread: 1, life: 0.6, size: 0.16,
        color: [[0.6, 0.2, 0.9], [1, 0.4, 0.7]], gravity: 0, drag: 2.5,
      });
    }
    return e;
  }

  spawnSupplyDrop(count) {
    const types = ['health', 'ammo', 'armor', 'credits', 'grenade'];
    for (let i = 0; i < count; i++) {
      const type = types[(Math.random() * types.length) | 0];
      const spot = chooseSpawn(this.level, this.player.pos, { minDistance: 8 });
      this.pickups.spawn(type, spot.x, 0.05, spot.z, {
        amount: type === 'credits' ? 40 + this.wave * 15 : undefined,
      });
    }
  }

  updateSpawning(dt) {
    const cfg = this.waveCfg || WAVE_TABLE[0];
    this.spawnTimer -= dt;
    const alive = this.aliveCount();
    if (this.spawnQueue.length && this.spawnTimer <= 0 && alive < cfg.maxAlive) {
      const type = this.spawnQueue.shift();
      this.spawnEnemy(type);
      // spawn in small packs, faster as the wave progresses
      this.spawnTimer = ENEMY_TYPES[type].boss ? 3.0 : Math.max(0.22, 1.1 - this.wave * 0.07);
    }
    if (!this.spawnQueue.length && alive === 0) {
      this.endWave();
    }
  }

  // ----------------------------------------------------------------- combat
  /**
   * Resolve one trigger pull. Hitscan weapons walk the ray through enemies and
   * walls; projectile weapons spawn a bolt instead.
   */
  fireWeapon({ def, origin, dir, spread, pellets, damage, range, falloff, pierce, headMul, projectile }) {
    this.shotsFired += pellets > 1 ? 1 : 1;
    // muzzle smoke + shell
    this.fx?.muzzleSmoke(origin, dir);

    if (projectile) {
      const d = dir.clone();
      d.x += (Math.random() - 0.5) * spread * 2;
      d.y += (Math.random() - 0.5) * spread * 2;
      d.z += (Math.random() - 0.5) * spread * 2;
      d.normalize();
      this.projectiles.addBolt({
        origin: origin.clone().addScaledVector(d, 0.5),
        dir: d,
        speed: projectile.speed,
        damage,
        splash: projectile.splash,
        splashDamage: projectile.splashDamage,
        gravity: projectile.gravity || 0,
        kind: 'plasma',
        owner: 'player',
      });
      return;
    }

    let anyHit = false;
    let anyKill = false;
    let anyHead = false;

    for (let p = 0; p < pellets; p++) {
      const d = dir.clone();
      if (spread > 0) {
        // uniform disc sample inside the cone
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * spread;
        const up = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(d, up).normalize();
        const realUp = new THREE.Vector3().crossVectors(right, d).normalize();
        d.addScaledVector(right, Math.cos(a) * r).addScaledVector(realUp, Math.sin(a) * r).normalize();
      }
      const result = this.castBullet(origin, d, { damage, range, falloff, pierce, headMul, tracerKind: def.id === 'rail' ? 'rail' : 'bullet' });
      if (result.hit) anyHit = true;
      if (result.kill) anyKill = true;
      if (result.head) anyHead = true;
    }

    if (anyHit) {
      this.shotsHit++;
      this.hud?.hitmarker(anyKill);
      this.audio?.play(anyHead ? 'headshot' : 'hitmarker');
      if (anyHead) this.hud?.addKill(`<b>爆头</b> ${anyKill ? '击杀' : '命中'}`, { headshot: true });
    }
  }

  /**
   * Ray vs enemies + world, with piercing. Returns {hit, kill, head}.
   * Enemies already pierced are skipped so one bullet cannot double-dip.
   */
  castBullet(origin, dir, opts) {
    const { damage, range, falloff, pierce, headMul, tracerKind } = opts;
    let remaining = Math.max(0, pierce | 0);
    let cursor = origin.clone();
    let travelled = 0;
    let hitAny = false;
    let killed = false;
    let headshot = false;
    const skip = this._shootScratch;
    skip.length = 0;

    const maxSegment = 42; // subdivide long rays so enemy tests stay accurate
    let guard = 0;
    while (travelled < range && guard++ < 12) {
      const segLen = Math.min(maxSegment, range - travelled);
      const wallHit = this.world.raycast(cursor, dir, segLen);

      // Nearest enemy along the full segment, then compare against the wall.
      // Testing the capsule with maxT = wallHit.t looks equivalent but is not:
      // when a creature stands right against cover the capsule surface is a few
      // centimetres *behind* the wall's collision plane, so the whole capsule
      // gets rejected and the shot silently does nothing.
      let bestT = segLen;
      let bestEnemy = null;
      let bestPoint = null;
      for (const e of this.enemies) {
        if (!e.alive || skip.includes(e)) continue;
        // Full-height capsule instead of a sphere at the waist: a sphere test
        // let centre-mass shots pass underneath the creature.
        const t = rayCapsule(cursor, dir, e, segLen);
        if (t !== null && t < bestT) {
          bestT = t;
          bestEnemy = e;
          bestPoint = cursor.clone().addScaledVector(dir, t);
        }
      }
      if (wallHit && wallHit.t < bestT) { bestEnemy = null; bestPoint = null; }

      if (bestEnemy) {
        hitAny = true;
        const point = bestPoint;
        const headY = bestEnemy.pos.y + bestEnemy.eyeHeight;
        const isHead = point.y >= headY - 0.22 && point.y <= headY + 0.28;
        if (isHead) headshot = true;
        const dist = travelled + bestT;
        const falloffMul = falloff > 0 ? Math.max(0.35, 1 - (dist / range) * falloff) : 1;
        const dmg = damage * falloffMul * (isHead ? headMul : 1);
        const fromDir = dir.clone().setY(0).normalize();
        const applied = bestEnemy.takeDamage(dmg, {
          sourcePos: origin,
          fromDir,
          headshot: isHead,
          headMul: 1,
          stagger: isHead ? 0.22 : 0.1,
        });
        this.damageDealt += applied;
        this.fx?.numbers.spawn(point, Math.round(applied).toString(), isHead ? 'head' : 'normal');
        this.fx?.impact(point, dir.clone().negate(), 'flesh');
        this.audio?.play('impact', { pos: point, surface: 'flesh' });
        skip.push(bestEnemy);
        if (!bestEnemy.alive) {
          killed = true;
          this.onEnemyKilled(bestEnemy, isHead);
        }
        // tracer for this leg
        this.fx?.tracers.fire(cursor, point, tracerKind || 'bullet', tracerKind === 'rail' ? 2.4 : 1);
        travelled += bestT;
        cursor.copy(point);
        if (remaining-- <= 0) return { hit: true, kill: killed, head: headshot };
        continue;
      }

      // nothing but (possibly) a wall
      const endPoint = wallHit ? wallHit.point : cursor.clone().addScaledVector(dir, segLen);
      this.fx?.tracers.fire(cursor, endPoint, tracerKind || 'bullet', tracerKind === 'rail' ? 2.4 : 1);
      if (wallHit) {
        const kind = wallHit.meta?.kind === 'floor' || wallHit.meta?.kind === 'ceiling' ? 'concrete' : 'metal';
        this.fx?.impact(wallHit.point, wallHit.normal, kind);
        this.audio?.play('impact', { pos: wallHit.point, surface: 'metal', volume: 0.5 });
        return { hit: hitAny, kill: killed, head: headshot };
      }
      travelled += segLen;
      cursor.copy(endPoint);
    }
    return { hit: hitAny, kill: killed, head: headshot };
  }

  enemyHitscan({ origin, dir, damage, tracer, owner }) {
    const wallHit = this.world.raycast(origin, dir, 80);
    const maxT = wallHit ? wallHit.t : 80;
    const p = this.player;
    const cy = p.pos.y + p.eyeHeight * 0.85;
    const t = raySphere(origin, dir, p.pos.x, cy, p.pos.z, 0.5, maxT);
    const end = t !== null
      ? origin.clone().addScaledVector(dir, t)
      : (wallHit ? wallHit.point : origin.clone().addScaledVector(dir, maxT));
    this.fx?.tracers.fire(origin, end, tracer || 'enemy', 1.2);
    if (t !== null) {
      p.damage(damage, origin);
      this.damageTaken += damage;
      this.fx?.impact(end, dir.clone().negate(), 'flesh');
      // taking a hit knocks the kill-chain down rather than resetting it
      this.combo = Math.max(1, this.combo - 0.5);
      this.comboT = Math.min(this.comboT, 1.5);
    } else if (wallHit) {
      this.fx?.impact(wallHit.point, wallHit.normal, 'metal');
    }
  }

  meleeSwing(origin, dir, range, damage) {
    let best = null;
    let bestT = range;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const cy = e.pos.y + e.height * 0.5;
      const t = raySphere(origin, dir, e.pos.x, cy, e.pos.z, e.radius + 0.35, bestT);
      if (t !== null && t < bestT) { bestT = t; best = e; }
    }
    if (best) {
      const applied = best.takeDamage(damage, { sourcePos: origin, stagger: 0.3 });
      this.damageDealt += applied;
      this.fx?.numbers.spawn(best.center, Math.round(applied).toString(), 'normal');
      this.fx?.bloodSpray(best.center, dir);
      this.audio?.play('melee', { pos: best.center });
      if (!best.alive) this.onEnemyKilled(best, false);
    }
  }

  spawnGrenade(origin, velocity) {
    this.projectiles.addGrenade({ origin, velocity, fuse: 2.3, damage: 175, radius: 5.8 });
  }

  spawnEnemyProjectile(opts) {
    this.projectiles.addBolt({
      origin: opts.origin,
      dir: opts.dir,
      speed: opts.speed,
      damage: opts.damage,
      splash: opts.splash,
      splashDamage: opts.splashDamage,
      gravity: opts.gravity || 0,
      kind: opts.kind === 'acid' ? 'acid' : 'enemyBolt',
      owner: opts.owner,
      lifetime: 7,
    });
  }

  spawnShockwave(center, radius, damage) {
    this.projectiles.addWave({ center, maxRadius: radius, damage, owner: 'enemy', color: 0xff7a3c });
    this.fx?.explosion(center, radius * 0.7);
    this.audio?.play('explosion', { pos: center });
  }

  // ------------------------------------------------------------------ events
  onEnemyKilled(enemy, headshot) {
    this.kills++;
    if (headshot) this.headshots++;
    const def = enemy.def;
    const comboStep = def.boss ? 0.6 : 0.12;
    this.combo = Math.min(5, this.combo + comboStep);
    this.comboT = this.comboMaxT;
    this.addScore(def.score);
    const credits = this.addCredits(def.credits);
    this.hud?.addKill(
      `<b>+${def.score}</b> ${def.name}${headshot ? ' <b>爆头</b>' : ''} <b>+${credits}c</b>`,
      { headshot },
    );
    this.audio?.play('kill', { pos: enemy.pos });
    if (this.player.mods.lifesteal > 0) {
      const healed = this.player.heal(this.player.mods.lifesteal);
      if (healed > 0) this.fx?.healBurst(new THREE.Vector3(this.player.pos.x, this.player.pos.y + 1, this.player.pos.z));
    }
    // loot
    const roll = Math.random();
    const center = enemy.center;
    if (def.boss) {
      for (let i = 0; i < 6; i++) {
        this.pickups.dropAt(['health', 'armor', 'ammo', 'credits', 'grenade'][i % 5], center.x + (Math.random() - 0.5) * 3, 0, center.z + (Math.random() - 0.5) * 3, {
          amount: 60,
        }, this.level);
      }
      this.boss = null;
    } else if (roll < 0.16) {
      this.pickups.dropAt('health', center.x, 0, center.z, {}, this.level);
    } else if (roll < 0.34) {
      this.pickups.dropAt('ammo', center.x, 0, center.z, {}, this.level);
    } else if (roll < 0.42) {
      this.pickups.dropAt('armor', center.x, 0, center.z, {}, this.level);
    } else if (roll < 0.50) {
      this.pickups.dropAt('grenade', center.x, 0, center.z, {}, this.level);
    } else if (roll < 0.58) {
      this.pickups.dropAt('credits', center.x, 0, center.z, { amount: 20 + this.wave * 8 }, this.level);
    } else if (roll < 0.62) {
      this.pickups.dropAt(['adrenaline', 'shield', 'haste'][(Math.random() * 3) | 0], center.x, 0, center.z, {}, this.level);
    }
  }

  applyPowerup(kind, amount) {
    switch (kind) {
      case 'adrenaline':
        this.powerups.set('adrenaline', amount);
        this.player.slowmoT = amount;
        this.hud?.announce('肾上腺素', 'TIME DILATION', 1.6);
        break;
      case 'shield':
        this.powerups.set('shield', amount);
        this.player._god = false;
        this.player.shieldHp = amount;
        this.hud?.announce('护盾展开', 'SHIELD ONLINE', 1.6);
        break;
      case 'haste':
        this.powerups.set('haste', amount);
        this.player.mods.speed *= 1.5;
        this.hud?.announce('超频', 'OVERCLOCK', 1.6);
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ armoury
  shopItems() {
    const items = [];
    for (const w of WEAPONS) {
      if (w.price <= 0) continue;
      if (this.player.weapons[w.id].owned) continue;
      items.push({
        kind: 'weapon', id: w.id, name: w.name, tag: w.cls, price: w.price,
        desc: w.desc, stats: [`${w.damage} 伤害`, `${w.rpm} RPM`, `弹匣 ${w.magSize}`], tags: w.tags,
        affordable: this.credits >= w.price,
        action: () => {
          if (this.credits < w.price) return false;
          this.credits -= w.price;
          this.player.giveWeapon(w.id);
          this.player.equip(w.id);
          return true;
        },
      });
    }
    for (const u of UPGRADES) {
      if (this.player.upgrades.has(u.id)) continue;
      items.push({
        kind: 'upgrade', id: u.id, name: u.name, tag: '升级', price: u.price,
        desc: u.desc, stats: [], tags: ['永久'],
        affordable: this.credits >= u.price,
        action: () => {
          if (this.credits < u.price) return false;
          if (!this.player.buyUpgrade(u.id)) return false;
          this.credits -= u.price;
          return true;
        },
      });
    }
    // consumables
    const consumables = [
      {
        kind: 'consumable', id: 'ammo', name: '全弹药补给', tag: '消耗品', price: 350,
        desc: '所有已拥有武器弹药补满。', stats: [], tags: ['立即'],
        affordable: this.credits >= 350,
        action: () => {
          if (this.credits < 350) return false;
          for (const w of Object.values(this.player.weapons)) {
            if (!w.owned) continue;
            w.reserve = w.reserveMax;
            w.ammo = w.magSize;
            w.cancelReload();
          }
          this.credits -= 350;
          return true;
        },
      },
      {
        kind: 'consumable', id: 'repair', name: '紧急修复', tag: '消耗品', price: 450,
        desc: '立即回复全部生命与护甲。', stats: [], tags: ['立即'],
        affordable: this.credits >= 450,
        action: () => {
          if (this.credits < 450) return false;
          this.player.stats.health = this.player.stats.maxHealth;
          this.player.stats.armor = this.player.stats.maxArmor;
          this.player.stats.stamina = this.player.stats.maxStamina;
          this.credits -= 450;
          return true;
        },
      },
      {
        kind: 'consumable', id: 'grenades', name: '手雷补给', tag: '消耗品', price: 250,
        desc: '补充 3 枚手雷（上限 5）。', stats: [], tags: ['立即'],
        affordable: this.credits >= 250,
        action: () => {
          if (this.credits < 250) return false;
          this.player.grenades = Math.min(this.player.maxGrenades, this.player.grenades + 3);
          this.credits -= 250;
          return true;
        },
      },
    ];
    return items.concat(consumables);
  }

  buy(item) {
    if (!item || !item.affordable) {
      this.audio?.play('denied');
      return false;
    }
    const ok = item.action();
    this.audio?.play(ok ? 'buy' : 'denied');
    if (ok) this.hud?.toast(`已购买：${item.name}`, 'good');
    return ok;
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    const now = performance.now();
    this.timePlayed += dt;

    // powerup timers
    for (const [kind, t] of [...this.powerups]) {
      const left = t - dt;
      if (left <= 0) {
        this.powerups.delete(kind);
        if (kind === 'haste') this.player.mods.speed /= 1.5;
        if (kind === 'adrenaline') this.player.slowmoT = 0;
      } else {
        this.powerups.set(kind, left);
      }
    }

    // slow motion
    const slow = this.powerups.has('adrenaline') ? 0.42 : 1;
    this.timeScale = slow;
    const sdt = dt * slow;

    this.player.tickEffects(sdt);

    if (this.state === 'combat') {
      this.waveTime += dt;
      this.updateSpawning(dt);
    } else if (this.state === 'intermission') {
      this.intermissionT -= dt;
      if (this.intermissionT <= 0) this.startWave(this.wave + 1);
    }

    // combo decay
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 1;
    }

    // enemies
    const ctx = { player: this.player, enemies: this.enemies, level: this.level, director: this, fx: this.fx, audio: this.audio, world: this.world };
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.alive || e.dying) e.update(sdt, ctx);
      if (!e.alive && e.dying && e.deathT > (e.def.boss ? 2.4 : 1.0)) {
        e.dispose(this.scene);
        this.enemies.splice(i, 1);
      }
    }

    // projectiles, pickups
    this.projectiles.update(sdt, ctx);
    this.pickups.update(sdt, ctx);

    // player death
    if (!this.player.alive && this.state === 'combat') {
      this.state = 'gameover';
      setTimeout(() => this.gameOver(), 1400);
    }

    // last-stand: one emergency save per run at low health
    if (!this.lastStandUsed && this.player.alive && this.player.stats.health < this.player.stats.maxHealth * 0.22) {
      this.lastStandUsed = true;
      this.player.stats.armor = Math.min(this.player.stats.maxArmor, this.player.stats.armor + 25);
      this.hud?.announce('生命维持系统启动', 'LAST STAND', 2.2);
      this.audio?.play('damageAlarm');
    }

    // screen shake decay
    this.screenShake *= Math.exp(-dt * 6);
  }

  clearEnemies() {
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies.length = 0;
    this.boss = null;
  }

  /** State bundle consumed by the HUD each frame. */
  hudState(dt, extra = {}) {
    const p = this.player;
    const w = p.weapon;
    return {
      dt,
      region: this.level.regionNameAt(p.pos.x, p.pos.z),
      objective: this.objectiveText(),
      wave: this.wave,
      enemiesLeft: this.aliveCount() + this.spawnQueue.length,
      score: Math.round(this.score),
      credits: Math.round(this.credits),
      health: p.stats.health,
      maxHealth: p.stats.maxHealth,
      armor: p.stats.armor,
      maxArmor: p.stats.maxArmor,
      stamina: p.stats.stamina,
      maxStamina: p.stats.maxStamina,
      weaponName: w.def.name,
      weaponId: p.currentId,
      loadout: p.loadout,
      ammo: w.ammo,
      magSize: w.magSize,
      reserve: w.reserve,
      reloading: w.reloading,
      combo: this.combo,
      comboT: Math.max(0, this.comboT),
      comboMaxT: this.comboMaxT,
      spread: w.spreadFor({ ads: p.ads > 0.5, moving: Math.hypot(p.vel.x, p.vel.z) > 2.4, crouch: p.crouch > 0.5 }),
      ads: p.ads,
      damageFlash: p.damageFlash,
      slowmo: this.powerups.has('adrenaline'),
      boss: this.boss && this.boss.alive ? { name: this.boss.def.name, hp: this.boss.health, maxHp: this.boss.maxHealth } : null,
      level: this.level,
      enemies: this.enemies,
      pickups: this.pickups.items,
      playerPos: p.pos,
      playerYaw: p.yaw,
      ...extra,
    };
  }

  objectiveText() {
    switch (this.state) {
      case 'combat': {
        const left = this.aliveCount() + this.spawnQueue.length;
        return `清除敌对单位 — 剩余 ${left}`;
      }
      case 'intermission':
        return `前往军械库整备 — ${Math.ceil(this.intermissionT)}s`;
      case 'victory':
        return '撤离成功';
      case 'gameover':
        return '任务失败';
      default:
        return '准备中…';
    }
  }
}

function raySphere(origin, dir, cx, cy, cz, radius, maxT) {
  const ox = origin.x - cx;
  const oy = origin.y - cy;
  const oz = origin.z - cz;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxT) return null;
  return t;
}

/**
 * Ray vs an enemy's vertical capsule (cylinder body plus a rounded top).
 *
 * Three.js' Ray.intersectsCapsule does not exist, and a sphere at the waist
 * misses legs and torso, so this does the work directly: a slab clamp for the
 * cylinder plus a sphere cap.
 */
function rayCapsule(origin, dir, enemy, maxT) {
  const r = enemy.radius;
  const x = enemy.pos.x;
  const z = enemy.pos.z;
  const y0 = enemy.pos.y;
  const y1 = enemy.pos.y + enemy.height;

  const ox = origin.x - x;
  const oz = origin.z - z;
  const a = dir.x * dir.x + dir.z * dir.z;
  let best = null;

  if (a > 1e-8) {
    // infinite cylinder around the enemy's vertical axis
    const bHalf = ox * dir.x + oz * dir.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = bHalf * bHalf - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t0 = (-bHalf - sq) / a;
      const t1 = (-bHalf + sq) / a;
      for (const t of [t0, t1]) {
        if (t < 0 || t > maxT) continue;
        const hy = origin.y + dir.y * t;
        if (hy >= y0 && hy <= y1) { best = t; break; }
      }
      // The ray may enter through the top or bottom cap while the cylinder
      // crossing itself lies outside the vertical span.
      if (best === null) {
        for (const [ty, tc] of [[y0, y0], [y1, y1]]) {
          if (Math.abs(dir.y) < 1e-8) continue;
          const t = (tc - origin.y) / dir.y;
          if (t < 0 || t > maxT) continue;
          const hx = origin.x + dir.x * t - x;
          const hz = origin.z + dir.z * t - z;
          if (hx * hx + hz * hz <= r * r) { best = t; break; }
        }
      }
    }
  } else if (Math.abs(dir.y) > 1e-8) {
    // vertical shot: only the caps can be hit
    const t = ((dir.y > 0 ? y1 : y0) - origin.y) / dir.y;
    if (t >= 0 && t <= maxT) {
      const hx = origin.x + dir.x * t - x;
      const hz = origin.z + dir.z * t - z;
      if (hx * hx + hz * hz <= r * r) best = t;
    }
  }

  // rounded head so grazing the top still registers
  const headT = raySphere(origin, dir, x, y1 - r * 0.4, z, r, maxT);
  if (headT !== null && (best === null || headT < best)) best = headT;
  return best;
}
