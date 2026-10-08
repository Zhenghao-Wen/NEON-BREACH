/**
 * enemy.js — hostile units and their AI.
 *
 * A steering + state-machine agent: idle scan -> alert -> chase (A* with
 * straight-line smoothing) -> attack -> stagger -> death. Every variant shares
 * one update loop and differs by stats, attack behaviour and model.
 *
 * Models are built from primitives once per variant and shared across all
 * instances; per-instance state lives in the transform and materials.
 */
import * as THREE from 'three';
import { makeMaterial } from '../gfx/textures.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Unit XZ direction from a position to a waypoint. */
function dirTo(pos, wp) {
  const dx = wp.x - pos.x;
  const dz = wp.z - pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return new THREE.Vector3();
  return new THREE.Vector3(dx / len, 0, dz / len);
}

/**
 * Navigation counters. The offline verification tools read these to spot agents
 * that fail to route; the cost in the game loop is a few integer increments.
 */
export const ENEMY_DEBUG = { pathOk: 0, pathFail: 0, unstuck: 0, direct: 0, total: 0 };

// ---------------------------------------------------------------------------
// variants
// ---------------------------------------------------------------------------
export const ENEMY_TYPES = {
  crawler: {
    name: '爬行体 CRAWLER', hp: 46, speed: 3.6, radius: 0.42, height: 1.05, mass: 0.7,
    damage: 11, attackRange: 1.9, attackCd: 0.95, windup: 0.28, threat: 1, score: 60, credits: 12,
    accel: 16, turn: 7.5, color: 0x7a3aa0, glow: 0xff5ad0, melee: true, headHeight: 0.75,
    desc: '快速接近的群体单位，成群出现。',
  },
  spitter: {
    name: '喷酸体 SPITTER', hp: 62, speed: 2.4, radius: 0.46, height: 1.35, mass: 0.9,
    damage: 8, attackRange: 22, attackCd: 2.4, windup: 0.55, threat: 2, score: 95, credits: 18,
    accel: 10, turn: 4.2, color: 0x5fa03a, glow: 0xaaff3c, projectile: { speed: 20, splash: 2.0, splashDamage: 18, gravity: 5, kind: 'acid' },
    preferRange: [7, 18], headHeight: 1.0,
    desc: '抛射酸液弹，逼迫玩家离开掩体。',
  },
  drone: {
    name: '巡飞机 DRONE', hp: 78, speed: 3.0, radius: 0.45, height: 1.5, mass: 0.8, hover: 1.55,
    damage: 9, attackRange: 26, attackCd: 1.5, windup: 0.42, threat: 2, score: 120, credits: 22,
    accel: 12, turn: 5.0, color: 0x2f6f9e, glow: 0x53d8ff, hitscan: { count: 3, spread: 0.045, tracer: 'enemy' },
    preferRange: [9, 22], headHeight: 1.55,
    desc: '悬浮射击平台，三轮点射压制。',
  },
  brute: {
    name: '重压者 BRUTE', hp: 320, speed: 2.75, radius: 0.72, height: 2.3, mass: 2.4,
    damage: 32, attackRange: 2.9, attackCd: 1.7, windup: 0.62, threat: 4, score: 300, credits: 55,
    accel: 9, turn: 3.4, color: 0x8e3626, glow: 0xff7a2a, melee: true, charge: { speed: 7.4, range: 12, duration: 1.1 },
    headHeight: 2.0, knockbackResist: 0.75,
    desc: '披甲冲锋单位，蓄力后高速撞击。',
  },
  stalker: {
    name: '潜猎者 STALKER', hp: 96, speed: 5.0, radius: 0.42, height: 1.15, mass: 0.6,
    damage: 19, attackRange: 2.1, attackCd: 0.8, windup: 0.2, threat: 3, score: 180, credits: 30,
    accel: 22, turn: 9.5, color: 0x9e2f52, glow: 0xff4d7a, melee: true, blink: 5.5,
    headHeight: 0.85, knockbackResist: 0.3,
    desc: '短距瞬移突袭的猎手，难以预判。',
  },
  shield: {
    name: '护盾兵 BULWARK', hp: 210, speed: 2.2, radius: 0.6, height: 1.95, mass: 1.8,
    damage: 14, attackRange: 24, attackCd: 1.9, windup: 0.5, threat: 4, score: 260, credits: 48,
    accel: 9, turn: 3.6, color: 0x3d5a8e, glow: 0x8fb6ff, hitscan: { count: 2, spread: 0.02, tracer: 'enemy' },
    frontArmor: 0.65, preferRange: [8, 20], headHeight: 1.72, knockbackResist: 0.6,
    desc: '正面装甲减伤 65%，攻击其背部或腿部。',
  },
  warden: {
    name: '典狱长 WARDEN', hp: 1500, speed: 2.6, radius: 1.0, height: 3.2, mass: 6,
    damage: 22, attackRange: 30, attackCd: 1.1, windup: 0.4, threat: 8, score: 1500, credits: 240,
    accel: 9, turn: 3.0, color: 0x5a4a8e, glow: 0xc07aff, boss: true,
    hitscan: { count: 4, spread: 0.03, tracer: 'enemy' },
    altAttack: { kind: 'slam', range: 6.5, damage: 46, cd: 5.5, windup: 0.9, radius: 6.0 },
    preferRange: [6, 20], headHeight: 2.8, knockbackResist: 0.95,
    desc: '双联重炮与震荡踏击。优先击杀。',
  },
  overloader: {
    name: '过载核心 OVERLOADER', hp: 4200, speed: 2.1, radius: 1.4, height: 4.4, mass: 12,
    damage: 30, attackRange: 34, attackCd: 0.9, windup: 0.5, threat: 12, score: 5000, credits: 800,
    accel: 7, turn: 2.4, color: 0x8e2f2f, glow: 0xffcc33, boss: true, finalBoss: true,
    hitscan: { count: 6, spread: 0.05, tracer: 'red' },
    altAttack: { kind: 'ring', range: 40, damage: 26, cd: 7.5, windup: 1.2, count: 14 },
    preferRange: [8, 26], headHeight: 3.9, knockbackResist: 1,
    desc: '站点的核心防卫体。弹幕、冲击波与召唤。',
  },
};

// ---------------------------------------------------------------------------
// shared materials
// ---------------------------------------------------------------------------
let MATS = null;
function enemyMaterials() {
  if (MATS) return MATS;
  MATS = {
    flesh: makeMaterial('organic', { repeat: [2, 2] }),
    armor: makeMaterial('metalplate', { repeat: [2, 2], color: 0x9098a8 }),
    darkMetal: makeMaterial('gunmetal', { repeat: [1, 1], color: 0x3a4048 }),
    eye: makeMaterial('energy', { repeat: [1, 1], emissiveIntensity: 4.0 }),
  };
  return MATS;
}

/** Per-variant tinted clones so one shared texture serves every creature. */
function tintedMaterial(baseKey, color, glow) {
  const base = enemyMaterials()[baseKey];
  const m = base.clone();
  if (m.color) m.color = new THREE.Color(color);
  if (glow && m.emissive) m.emissive = new THREE.Color(glow);
  m.userData.shared = true;
  return m;
}

// ---------------------------------------------------------------------------
// model builders (cached per variant)
// ---------------------------------------------------------------------------
const MODEL_CACHE = new Map();

export function buildEnemyModel(type) {
  if (MODEL_CACHE.has(type)) return MODEL_CACHE.get(type);
  const def = ENEMY_TYPES[type];
  const root = new THREE.Group();
  const flesh = tintedMaterial('flesh', def.color, def.glow);
  const armor = tintedMaterial('armor', def.color, def.glow);
  const eye = tintedMaterial('eye', 0x111111, def.glow);
  const dark = enemyMaterials().darkMetal;

  const add = (geo, mat, x, y, z, rot) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
    root.add(m);
    return m;
  };

  switch (type) {
    case 'crawler': {
      const body = new THREE.SphereGeometry(0.34, 12, 9);
      body.scale(1.25, 0.75, 1.0);
      add(body, flesh, 0, 0.52, 0);
      const head = new THREE.SphereGeometry(0.2, 10, 8);
      add(head, flesh, 0, 0.5, -0.42);
      add(new THREE.SphereGeometry(0.075, 8, 6), eye, -0.09, 0.55, -0.55);
      add(new THREE.SphereGeometry(0.075, 8, 6), eye, 0.09, 0.55, -0.55);
      for (let i = 0; i < 3; i++) {
        for (const s of [-1, 1]) {
          const leg = new THREE.CylinderGeometry(0.035, 0.02, 0.62, 6);
          const lm = add(leg, dark, s * 0.34, 0.38, -0.18 + i * 0.24, [0, 0, s * 1.0]);
          lm.userData.leg = { phase: i * 1.1 + (s > 0 ? 0 : Math.PI), side: s };
        }
      }
      const tail = new THREE.ConeGeometry(0.08, 0.5, 6);
      add(tail, flesh, 0, 0.52, 0.5, [Math.PI / 2.1, 0, 0]);
      break;
    }
    case 'spitter': {
      const sac = new THREE.SphereGeometry(0.42, 12, 10);
      sac.scale(1, 1.15, 1);
      add(sac, flesh, 0, 0.82, 0.06);
      add(new THREE.SphereGeometry(0.24, 10, 8), flesh, 0, 0.9, -0.4);
      add(new THREE.SphereGeometry(0.09, 8, 6), eye, 0, 1.0, -0.58);
      for (const s of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const leg = new THREE.CylinderGeometry(0.05, 0.03, 0.82, 6);
          add(leg, dark, s * 0.38, 0.42, -0.1 + i * 0.36, [0, 0, s * 0.85]);
        }
      }
      add(new THREE.ConeGeometry(0.09, 0.42, 7), enemyMaterials().armor, 0, 1.12, -0.5, [-1.1, 0, 0]);
      break;
    }
    case 'drone': {
      const core = new THREE.OctahedronGeometry(0.34, 0);
      add(core, armor, 0, 0, 0);
      add(new THREE.TorusGeometry(0.44, 0.05, 6, 16), dark, 0, 0, 0, [Math.PI / 2, 0, 0]);
      add(new THREE.SphereGeometry(0.13, 10, 8), eye, 0, 0, -0.34);
      for (const s of [-1, 1]) {
        add(new THREE.BoxGeometry(0.1, 0.1, 0.34), dark, s * 0.36, -0.06, -0.1);
        add(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), armor, s * 0.36, -0.06, -0.3, [Math.PI / 2, 0, 0]);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        add(new THREE.BoxGeometry(0.3, 0.03, 0.1), dark, Math.cos(a) * 0.5, 0.14, Math.sin(a) * 0.5, [0, -a, 0.2]);
      }
      break;
    }
    case 'brute': {
      const torso = new THREE.BoxGeometry(1.05, 1.0, 0.66);
      add(torso, armor, 0, 1.45, 0);
      add(new THREE.BoxGeometry(0.7, 0.5, 0.6), flesh, 0, 0.95, 0);
      add(new THREE.SphereGeometry(0.34, 12, 10), flesh, 0, 2.05, -0.16);
      add(new THREE.BoxGeometry(0.66, 0.14, 0.2), armor, 0, 2.16, -0.3);
      add(new THREE.SphereGeometry(0.1, 8, 6), eye, -0.15, 2.06, -0.44);
      add(new THREE.SphereGeometry(0.1, 8, 6), eye, 0.15, 2.06, -0.44);
      for (const s of [-1, 1]) {
        add(new THREE.BoxGeometry(0.34, 0.42, 0.38), armor, s * 0.72, 1.72, -0.06);
        add(new THREE.CylinderGeometry(0.19, 0.15, 0.46, 8), armor, s * 0.72, 1.24, -0.06);
        const arm = new THREE.BoxGeometry(0.3, 0.82, 0.3);
        add(arm, flesh, s * 0.72, 1.0, -0.12);
        add(new THREE.BoxGeometry(0.42, 0.42, 0.42), armor, s * 0.74, 0.62, -0.2);
        add(new THREE.BoxGeometry(0.42, 0.62, 0.52), armor, s * 0.34, 0.32, 0.02);
      }
      add(new THREE.BoxGeometry(0.8, 0.5, 0.3), armor, 0, 1.55, 0.4);
      break;
    }
    case 'stalker': {
      const body = new THREE.SphereGeometry(0.3, 12, 9);
      body.scale(1.1, 0.8, 1.5);
      add(body, flesh, 0, 0.78, 0);
      add(new THREE.ConeGeometry(0.2, 0.44, 8), flesh, 0, 0.8, -0.5, [-1.4, 0, 0]);
      for (let i = 0; i < 4; i++) {
        for (const s of [-1, 1]) {
          const leg = new THREE.CylinderGeometry(0.04, 0.018, 0.95, 6);
          const lm = add(leg, dark, s * 0.3, 0.52, -0.34 + i * 0.24, [0, 0, s * 1.15]);
          lm.userData.leg = { phase: i * 0.8 + (s > 0 ? 0 : Math.PI), side: s };
        }
      }
      add(new THREE.SphereGeometry(0.09, 8, 6), eye, 0, 0.92, -0.62);
      add(new THREE.SphereGeometry(0.05, 6, 5), eye, -0.12, 0.86, -0.5);
      add(new THREE.SphereGeometry(0.05, 6, 5), eye, 0.12, 0.86, -0.5);
      break;
    }
    case 'shield': {
      add(new THREE.BoxGeometry(0.86, 1.3, 0.56), armor, 0, 1.35, 0);
      add(new THREE.SphereGeometry(0.28, 12, 10), flesh, 0, 2.15, -0.08);
      add(new THREE.BoxGeometry(0.5, 0.1, 0.16), eye, 0, 2.22, -0.28);
      const shield = add(new THREE.BoxGeometry(1.35, 1.75, 0.14), armor, 0, 1.3, -0.62);
      shield.userData.shield = true;
      add(new THREE.BoxGeometry(1.2, 0.1, 0.16), eye, 0, 1.85, -0.7);
      for (const s of [-1, 1]) {
        add(new THREE.CylinderGeometry(0.16, 0.13, 0.42, 8), armor, s * 0.6, 1.0, -0.02);
        add(new THREE.BoxGeometry(0.3, 0.92, 0.34), armor, s * 0.32, 0.46, 0.02);
        add(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 8), dark, s * 0.62, 0.9, -0.42, [Math.PI / 2, 0, 0]);
      }
      break;
    }
    case 'warden':
    case 'overloader': {
      const big = type === 'overloader';
      const S = big ? 1.45 : 1.0;
      add(new THREE.BoxGeometry(1.5 * S, 1.5 * S, 0.95 * S), armor, 0, 1.9 * S, 0);
      add(new THREE.CylinderGeometry(0.62 * S, 0.5 * S, 0.7 * S, 12), flesh, 0, 1.05 * S, 0);
      add(new THREE.SphereGeometry(0.46 * S, 14, 10), armor, 0, 2.95 * S, -0.1);
      add(new THREE.BoxGeometry(0.9 * S, 0.16 * S, 0.3 * S), eye, 0, 3.02 * S, -0.42 * S);
      // shoulder cannons
      for (const s of [-1, 1]) {
        add(new THREE.BoxGeometry(0.5 * S, 0.5 * S, 0.5 * S), armor, s * 1.0 * S, 2.4 * S, -0.05);
        add(new THREE.CylinderGeometry(0.14 * S, 0.16 * S, 1.0 * S, 10), dark, s * 1.0 * S, 2.36 * S, -0.55 * S, [Math.PI / 2, 0, 0]);
        add(new THREE.CylinderGeometry(0.1 * S, 0.1 * S, 0.24 * S, 8), eye, s * 1.0 * S, 2.36 * S, -1.02 * S, [Math.PI / 2, 0, 0]);
        const arm = add(new THREE.BoxGeometry(0.4 * S, 1.3 * S, 0.4 * S), flesh, s * 1.05 * S, 1.55 * S, -0.1);
        arm.rotation.z = s * 0.14;
        add(new THREE.BoxGeometry(0.56 * S, 0.56 * S, 0.56 * S), armor, s * 1.05 * S, 0.85 * S, -0.15);
        add(new THREE.BoxGeometry(0.62 * S, 1.0 * S, 0.8 * S), armor, s * 0.46 * S, 0.5 * S, 0.02);
      }
      // back vents / core
      add(new THREE.CylinderGeometry(0.3 * S, 0.3 * S, 0.4 * S, 12), eye, 0, 1.9 * S, 0.6 * S, [Math.PI / 2, 0, 0]);
      if (big) {
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          add(new THREE.CylinderGeometry(0.12, 0.16, 1.4, 8), dark, Math.cos(a) * 0.9, 2.4, Math.sin(a) * 0.9, [0.3 * Math.sin(a), 0, -0.3 * Math.cos(a)]);
        }
      }
      break;
    }
    default: {
      add(new THREE.BoxGeometry(0.5, 1, 0.5), flesh, 0, 0.5, 0);
    }
  }

  root.userData.materials = { flesh, armor, eye, dark };
  MODEL_CACHE.set(type, root);
  return root;
}

// ---------------------------------------------------------------------------
// the agent
// ---------------------------------------------------------------------------
let ENEMY_ID = 0;

export class Enemy {
  constructor({ type, x, z, y = 0, level, world, pathfinder, fx, audio, hpScale = 1, speedScale = 1, damageScale = 1 }) {
    this.id = ++ENEMY_ID;
    this.type = type;
    this.def = ENEMY_TYPES[type];
    this.level = level;
    this.world = world;
    this.pf = pathfinder;
    this.fx = fx;
    this.audio = audio;
    this.hpScale = hpScale;
    this.speedScale = speedScale;
    this.damageScale = damageScale;

    this.maxHealth = Math.round(this.def.hp * hpScale);
    this.health = this.maxHealth;
    this.radius = this.def.radius;
    this.height = this.def.height;
    this.eyeHeight = this.def.headHeight ?? this.height * 0.85;
    this.alive = true;
    this.dying = false;
    this.deathT = 0;

    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.onGround = false;
    this.state = 'idle';
    this.stateT = 0;
    this.attackT = 0;
    this.altT = 0;
    this.staggerT = 0;
    this.flashT = 0;
    this.blinkT = 2 + Math.random() * 3;
    this.chargeT = 0;
    this.chargeDir = new THREE.Vector3();
    this.alerted = false;
    this.path = null;
    this.pathIdx = 0;
    this.repathT = 0;
    this.lastSeen = new THREE.Vector3();
    this.knownPlayerPos = new THREE.Vector3();
    this.hasLos = false;
    this.losT = 0;
    this.separation = new THREE.Vector3();
    this.drive = new THREE.Vector3();      // desired velocity, pre-collision
    this.stuckT = 0;
    this.lastPos = new THREE.Vector3(x, y, z);
    this.growlT = 2 + Math.random() * 5;
    this.footT = 0;
    // progress watchdog: the last resort against wedging
    this.progressT = 0;
    this.progressDist = Infinity;
    this.warpCooldown = 0;
    this.hitFlash = 0;
    this.damageTaken = 0;

    // model
    this.root = buildEnemyModel(type).clone(true);
    this.root.position.copy(this.pos);
    const mats = buildEnemyModel(type).userData.materials;
    // clone materials per instance so hit flashes do not affect siblings
    this.ownMats = [];
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      this.ownMats.push({ mesh: o, base: o.material.emissive ? o.material.emissive.clone() : null, mat: o.material });
    });
    this.mats = mats;
    // expose named parts for animation
    this.legs = [];
    this.root.traverse((o) => { if (o.userData && o.userData.leg) this.legs.push(o); });
    this.baseY = this.def.hover || 0;
  }

  get center() {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.height * 0.55, this.pos.z);
  }

  headPos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  // ------------------------------------------------------------------ senses
  canSee(target) {
    const a = this.headPos(this._a || (this._a = new THREE.Vector3()));
    const b = target.clone ? target.clone() : new THREE.Vector3(target.x, target.y, target.z);
    b.y = Math.max(b.y, 0.3);
    return this.world.lineOfSight(a, b);
  }

  distanceTo(p) {
    return Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
  }

  // ----------------------------------------------------------------- damage
  takeDamage(amount, opts = {}) {
    if (!this.alive) return 0;
    let dmg = amount;
    // directional armour (bulwark)
    if (this.def.frontArmor && opts.fromDir) {
      const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const dot = forward.dot(opts.fromDir);
      if (dot > 0.25) dmg *= 1 - this.def.frontArmor;
    }
    if (opts.headshot) dmg *= opts.headMul ?? 2.0;
    if (this.def.boss && opts.headshot) dmg *= 0.7;
    this.health -= dmg;
    this.damageTaken += dmg;
    this.hitFlash = 0.14;
    this.alert(opts.sourcePos);
    if (this.health <= 0) {
      this.health = 0;
      this.die(opts);
    } else if (!opts.silent) {
      this.staggerT = Math.min(0.3, this.staggerT + (opts.stagger ?? 0.06) * (1 - (this.def.knockbackResist || 0)));
    }
    return dmg;
  }

  alert(sourcePos) {
    if (sourcePos) this.knownPlayerPos.copy(sourcePos);
    if (!this.alerted) {
      this.alerted = true;
      this.state = 'alert';
      this.stateT = 0;
      this.audio?.play('enemyAlert', { pos: this.pos });
    }
  }

  die(opts = {}) {
    this.alive = false;
    this.dying = true;
    this.deathT = 0;
    this.vel.multiplyScalar(0.35);
    this.audio?.play('enemyDeath', { pos: this.pos });
    this.fx?.bloodSpray(this.center, new THREE.Vector3(0, 1, 0));
    this.fx?.particles.burst(this.center, new THREE.Vector3(0, 1, 0), {
      count: this.def.boss ? 60 : 20, speed: 6, spread: 1.0, life: 0.9, size: 0.16,
      color: [[0.9, 0.15, 0.2], [0.4, 0.05, 0.1]], gravity: 9, drag: 2,
    });
    if (this.def.boss) this.fx?.explosion(this.center, 3);
  }

  // -------------------------------------------------------------- behaviour
  update(dt, ctx) {
    const { player, enemies } = ctx;
    this.stateT += dt;
    this.attackT = Math.max(0, this.attackT - dt);
    this.altT = Math.max(0, this.altT - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.flashT = Math.max(0, this.flashT - dt);

    if (this.dying) {
      this.updateDeath(dt);
      return;
    }

    // hit flash
    const flashK = this.hitFlash > 0 ? 1 - this.hitFlash / 0.14 : 0;
    for (const m of this.ownMats) {
      if (!m.base) continue;
      m.mat.emissive.copy(m.base).lerp(new THREE.Color(0xffffff), flashK * 0.85);
    }

    // periodic line of sight check
    this.losT -= dt;
    if (this.losT <= 0) {
      this.losT = 0.1 + Math.random() * 0.08;
      const target = this._target || (this._target = new THREE.Vector3());
      target.set(player.pos.x, player.pos.y + player.eyeHeight * 0.55, player.pos.z);
      this.hasLos = this.canSee(target);
      if (this.hasLos) {
        this.knownPlayerPos.copy(player.pos);
        this.lastSeen.copy(player.pos);
        if (!this.alerted && this.distanceTo(player.pos) < 30) this.alert(player.pos);
      }
    }

    const dist = this.distanceTo(player.pos);
    const engageRange = Math.min(this.def.attackRange, 30);
    const canEngage = this.hasLos && dist <= engageRange;

    // Latching aggro with hysteresis: enemies commit to a fight once they see
    // the intruder, and only give up after several seconds without contact.
    // Nearest units are always aware - the station's grid tracks the player.
    if (!this.alerted) {
      if (canEngage || dist < 13) this.alert(player.pos);
    } else if (canEngage) {
      this.lostContactT = 0;
      this.knownPlayerPos.copy(player.pos);
    } else {
      this.lostContactT = (this.lostContactT || 0) + dt;
      if (this.lostContactT > 6 && dist > 26) {
        this.alerted = false;
        this.lostContactT = 0;
      }
    }

    if (!this.alerted) {
      this.hunt(dt, ctx);
    } else if (canEngage || dist <= this.def.attackRange + 2) {
      this.combat(dt, ctx, dist);
    } else {
      this.search(dt, ctx);
    }

    this.integrate(dt, ctx);
    this.animate(dt, ctx, dist);
    this.watchdog(dt, ctx, dist);

    // occasional vocalisation
    this.growlT -= dt;
    if (this.growlT <= 0) {
      this.growlT = 4 + Math.random() * 8;
      if (this.alerted && dist < 26) this.audio?.play('enemyGrowl', { pos: this.pos });
    }
  }

  /**
   * Advance towards the player before contact is made. Units path through the
   * facility (the station's grid tracks the intruder), so a wave always closes
   * in and can be cleared.
   */
  hunt(dt, ctx) {
    this.state = 'hunt';
    const player = ctx.player;
    if (!player.alive) {
      this.vel.x *= 0.9;
      this.vel.z *= 0.9;
      return;
    }
    const dist = this.distanceTo(player.pos);
    const band = this.def.preferRange;
    // ranged units break off slightly outside their band so they stop walking
    // straight into the player; melee units close all the way in
    const stopAt = band ? band[1] * 0.9 : Math.max(1.6, this.def.attackRange * 0.75);
    if (this.def.melee || dist > stopAt) {
      this.moveTowards(dt, player.pos.x, player.pos.z, this.def.speed);
    } else {
      this.vel.x *= 0.92;
      this.vel.z *= 0.92;
      this.faceTowards(player.pos, dt, this.def.turn);
    }
  }

  search(dt, ctx) {
    this.state = 'search';
    const target = this.lastSeen;
    const d = Math.hypot(target.x - this.pos.x, target.z - this.pos.z);
    if (d < 1.6) {
      this.vel.x *= 0.85;
      this.vel.z *= 0.85;
      this.yaw += dt * 1.2;
      if (this.stateT > 6) { this.alerted = false; this.stateT = 0; }
      return;
    }
    this.moveTowards(dt, target.x, target.z, this.def.speed * 0.8);
  }

  combat(dt, ctx, dist) {
    const { player } = ctx;
    // blink (stalker)
    if (this.def.blink) {
      this.blinkT -= dt;
      if (this.blinkT <= 0 && dist > 4 && dist < 16 && this.hasLos) {
        this.doBlink(player);
        return;
      }
    }

    // brute charge
    if (this.def.charge) {
      if (this.chargeT > 0) {
        this.chargeT -= dt;
        this.vel.x = this.chargeDir.x * this.def.charge.speed;
        this.vel.z = this.chargeDir.z * this.def.charge.speed;
        this.yaw = Math.atan2(this.chargeDir.x, this.chargeDir.z);
        if (dist < this.def.attackRange + 0.9) {
          this.meleeHit(ctx, this.def.damage * 1.4);
          this.chargeT = 0;
        }
        if (this.chargeT <= 0) this.attackT = Math.max(this.attackT, 1.0);
        return;
      }
      if (this.attackT <= 0 && dist > 4 && dist < this.def.charge.range && this.hasLos) {
        this.chargeDir.set(player.pos.x - this.pos.x, 0, player.pos.z - this.pos.z).normalize();
        this.chargeT = this.def.charge.duration;
        this.audio?.play('enemyGrowl', { pos: this.pos, volume: 1.3 });
        return;
      }
    }

    // boss alternate attack
    if (this.def.altAttack && this.altT <= 0 && dist < this.def.altAttack.range && this.hasLos) {
      this.doAltAttack(ctx);
      return;
    }

    const range = this.def.attackRange;
    const preferred = this.def.preferRange;
    const tooClose = preferred && dist < preferred[0];
    const tooFar = preferred && dist > preferred[1];

    if (this.def.melee) {
      this.state = 'chase';
      if (dist > range) {
        this.moveTowards(dt, player.pos.x, player.pos.z, this.def.speed);
      } else {
        this.faceTowards(player.pos, dt, 9);
        this.vel.x *= 0.82;
        this.vel.z *= 0.82;
        if (this.attackT <= 0) {
          this.state = 'attack';
          this.attackT = this.def.attackCd;
          this.windupT = this.def.windup;
        }
        if (this.windupT !== undefined) {
          this.windupT -= dt;
          if (this.windupT <= 0) {
            this.windupT = undefined;
            if (this.distanceTo(player.pos) < range + 0.7) this.meleeHit(ctx, this.def.damage);
          }
        }
      }
    } else {
      // ranged: keep preferred distance and shoot
      this.state = 'engage';
      if (tooClose) {
        this.moveTowards(dt, this.pos.x * 2 - player.pos.x, this.pos.z * 2 - player.pos.z, this.def.speed);
      } else if (tooFar || !this.hasLos) {
        this.moveTowards(dt, player.pos.x, player.pos.z, this.def.speed);
      } else {
        // strafe
        const side = Math.sin(this.stateT * 0.7 + this.id) > 0 ? 1 : -1;
        const dir = new THREE.Vector3(player.pos.x - this.pos.x, 0, player.pos.z - this.pos.z).normalize();
        const strafe = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(side * this.def.speed * 0.55);
        this.vel.x += (strafe.x - this.vel.x) * Math.min(1, dt * 6);
        this.vel.z += (strafe.z - this.vel.z) * Math.min(1, dt * 6);
        this.faceTowards(player.pos, dt, 6);
      }
      if (this.attackT <= 0 && this.hasLos && dist < range && !tooClose) {
        this.attackT = this.def.attackCd;
        this.pendingShot = this.def.windup;
      }
    }

    // delayed ranged shot (telegraph)
    if (this.pendingShot !== undefined) {
      this.pendingShot -= dt;
      if (this.pendingShot <= 0) {
        this.pendingShot = undefined;
        this.rangedAttack(ctx, dist);
      }
    }
  }

  doBlink(player) {
    this.blinkT = this.def.blink + Math.random() * 2;
    const dir = new THREE.Vector3(player.pos.x - this.pos.x, 0, player.pos.z - this.pos.z);
    const d = dir.length();
    if (d < 2) return;
    dir.normalize();
    const step = Math.min(d - 1.6, 5.5);
    const nx = this.pos.x + dir.x * step;
    const nz = this.pos.z + dir.z * step;
    if (this.world.overlaps(nx, this.pos.y + 0.1, nz, this.radius, this.height * 0.9)) return;
    this.fx?.particles.burst(this.center, new THREE.Vector3(0, 1, 0), {
      count: 14, speed: 4, spread: 1, life: 0.4, size: 0.14,
      color: [[0.7, 0.2, 0.9], [1, 0.4, 0.8]], gravity: 0, drag: 3,
    });
    this.pos.x = nx;
    this.pos.z = nz;
    this.audio?.play('teleport', { pos: this.pos });
    this.fx?.particles.burst(this.center, new THREE.Vector3(0, 1, 0), {
      count: 14, speed: 4, spread: 1, life: 0.4, size: 0.14,
      color: [[0.9, 0.3, 1], [1, 0.6, 0.9]], gravity: 0, drag: 3,
    });
    this.attackT = Math.min(this.attackT, 0.35);
  }

  doAltAttack(ctx) {
    const alt = this.def.altAttack;
    this.altT = alt.cd;
    this.state = 'altAttack';
    if (alt.kind === 'slam') {
      this.audio?.play('enemyGrowl', { pos: this.pos, volume: 1.6 });
      ctx.director?.spawnShockwave(this.pos.clone(), alt.radius, alt.damage * this.damageScale);
    } else if (alt.kind === 'ring') {
      this.audio?.play('bossSpawn', { volume: 0.7 });
      for (let i = 0; i < alt.count; i++) {
        const a = (i / alt.count) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        ctx.director?.spawnEnemyProjectile({
          origin: this.center.clone().addScaledVector(dir, 1.4),
          dir,
          speed: 13,
          damage: alt.damage * this.damageScale,
          splash: 1.6,
          splashDamage: 8,
          kind: 'plasma',
          owner: this,
        });
      }
    }
  }

  rangedAttack(ctx, dist) {
    const hs = this.def.hitscan;
    const target = ctx.player;
    const origin = this.headPos(new THREE.Vector3());
    const aim = new THREE.Vector3(target.pos.x, target.pos.y + target.eyeHeight * 0.7, target.pos.z)
      .sub(origin).normalize();
    if (this.def.projectile) {
      ctx.director?.spawnEnemyProjectile({
        origin,
        dir: aim.clone(),
        speed: this.def.projectile.speed,
        damage: this.def.damage * this.damageScale,
        splash: this.def.projectile.splash,
        splashDamage: this.def.projectile.splashDamage * this.damageScale,
        gravity: this.def.projectile.gravity,
        kind: this.def.projectile.kind,
        owner: this,
      });
      this.audio?.play('enemyShot', { pos: this.pos });
      return;
    }
    if (hs) {
      for (let i = 0; i < hs.count; i++) {
        const spread = hs.spread;
        const d = aim.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * spread * 2,
          (Math.random() - 0.5) * spread * 2,
          (Math.random() - 0.5) * spread * 2,
        )).normalize();
        ctx.director?.enemyHitscan({
          origin: origin.clone(),
          dir: d,
          damage: this.def.damage * this.damageScale,
          tracer: hs.tracer || 'enemy',
          owner: this,
        });
      }
      this.audio?.play('enemyShot', { pos: this.pos });
    }
  }

  meleeHit(ctx, damage) {
    const target = ctx.player;
    if (!target.alive) return;
    const d = this.distanceTo(target.pos);
    if (d > this.def.attackRange + 1.0) return;
    target.damage(damage * this.damageScale, this.pos);
    ctx.fx?.bloodSpray(
      new THREE.Vector3(target.pos.x, target.pos.y + 1.2, target.pos.z),
      new THREE.Vector3(0, 0.4, 0).normalize(),
    );
    this.audio?.play('melee', { pos: this.pos });
  }

  // ---------------------------------------------------------------- steering
  moveTowards(dt, tx, tz, speed) {
    this.repathT -= dt;
    const d = Math.hypot(tx - this.pos.x, tz - this.pos.z);
    // "Direct" means clear of both the nav grid AND solid props. Checking only
    // the grid let agents walk straight into crates and the atrium dais, where
    // they would wedge and stall.
    const useDirect = this.pf
      ? (this.pf.lineClear(this.pos.x, this.pos.z, tx, tz) && this.pf.worldLineClear(this.pos.x, this.pos.z, tx, tz, true))
      : true;

    if (useDirect) {
      this.path = null;

      const dir = new THREE.Vector3(tx - this.pos.x, 0, tz - this.pos.z);
      if (dir.lengthSq() > 1e-6) dir.normalize();
      this.applyDesired(dir, speed, dt);
      this.pathIdx = 0;
      return;
    }
    if (!this.path || this.repathT <= 0 || this.pathIdx >= (this.path?.length ?? 0)) {
      this.repathT = 0.42 + Math.random() * 0.35;
      // clear first so a failed search cannot leave a stale route behind us
      this.path = null;
      this.pathIdx = 0;
      const path = this.pf?.find(this.pos.x, this.pos.z, tx, tz);
      if (path && path.length) {
        this.path = path;
        this.pathIdx = 0;

      } else {
        this.path = null;

        const dir = new THREE.Vector3(tx - this.pos.x, 0, tz - this.pos.z);
        if (dir.lengthSq() > 1e-6) dir.normalize();
        this.applyDesired(dir, speed, dt);
        return;
      }
    }
    this.applyPath(dt, speed);
  }

  /**
   * Follow the current path.
   *
   * Waypoints already reached are skipped by advancing pathIdx (never by
   * discarding the whole route); a route is only dropped once we run off the
   * end of it. The first surviving waypoint is the steering target, and if we
   * cannot actually reach it in a straight line the route is stale, so we ask
   * for a fresh one.
   */
  applyPath(dt, speed) {
    const path = this.path;
    if (!path || !path.length) { this.path = null; return; }
    const pos = this.pos;
    let idx = this.pathIdx;
    let guard = 0;
    while (idx < path.length && guard++ < 64) {
      const wp = path[idx];
      const dx = wp.x - pos.x;
      const dz = wp.z - pos.z;
      if (Math.hypot(dx, dz) < 0.7) { idx++; continue; }
      const speedSq = this.vel.x * this.vel.x + this.vel.z * this.vel.z;
      // only treat a waypoint as passed when we are clearly moving away from it
      if (idx > this.pathIdx && speedSq > 1.2) {
        const d = Math.hypot(dx, dz);
        if ((dx * this.vel.x + dz * this.vel.z) / (d * Math.sqrt(speedSq)) < -0.5) { idx++; continue; }
      }
      break;
    }
    this.pathIdx = idx;
    if (idx >= path.length) { this.path = null; return; }
    const target = path[idx];
    // buildRoute() already guaranteed every leg is collision free; re-testing
    // with the grid-only lineClear here produced false negatives for targets
    // that sit in blocked-but-standable space (on the dais, under the pylons).
    if (this.pf && this.pf.world && !this.pf.worldLineClear(pos.x, pos.z, target.x, target.z, idx === path.length - 1)) {
      this.path = null;
      this.repathT = 0;
      return;
    }
    const dir = dirTo(pos, target);

    if (dir.lengthSq() > 1e-6) this.applyDesired(dir, speed, dt);
  }

  applyDesired(dir, speed, dt) {
    const targetVx = dir.x * speed * this.speedScale;
    const targetVz = dir.z * speed * this.speedScale;
    // remembered so stuck detection can tell "wants to move" from "is moving"
    this.drive.x = targetVx;
    this.drive.z = targetVz;
    const a = Math.min(1, this.def.accel * dt);
    this.vel.x += (targetVx - this.vel.x) * a;
    this.vel.z += (targetVz - this.vel.z) * a;
    if (speed > 0.1) this.faceTowards({ x: this.pos.x + dir.x, z: this.pos.z + dir.z }, dt, this.def.turn);
  }

  faceTowards(p, dt, speed) {
    const targetYaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
    let diff = targetYaw - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, speed * dt);
  }

  integrate(dt, ctx) {
    // separation from neighbours (cheap O(n^2) is fine at these counts)
    const sep = this.separation.set(0, 0, 0);
    if (ctx.enemies) {
      for (const other of ctx.enemies) {
        if (other === this || !other.alive) continue;
        const dx = this.pos.x - other.pos.x;
        const dz = this.pos.z - other.pos.z;
        const distSq = dx * dx + dz * dz;
        const minD = this.radius + other.radius;
        if (distSq < minD * minD && distSq > 1e-5) {
          const d = Math.sqrt(distSq);
          const push = (minD - d) / minD;
          sep.x += (dx / d) * push;
          sep.z += (dz / d) * push;
        }
      }
    }
    const sepStrength = this.def.melee ? 5.5 : 3.5;
    this.vel.x += sep.x * sepStrength * dt * 6;
    this.vel.z += sep.z * sepStrength * dt * 6;

    // gravity / hover
    const hover = this.def.hover;
    if (hover) {
      const targetY = hover + Math.sin(performance.now() * 0.0016 + this.id) * 0.12;
      this.pos.y += (targetY - this.pos.y) * Math.min(1, dt * 3.5);
      this.onGround = false;
    } else {
      this.vel.y -= 20 * dt;
    }

    // stagger slows movement
    if (this.staggerT > 0) {
      this.staggerT -= dt;
      this.vel.x *= 0.75;
      this.vel.z *= 0.75;
    }

    // collisions
    // Horizontal collision. Only the blocked component is cancelled — wiping
    // the whole velocity would make an agent grinding along a wall crawl at a
    // fraction of its speed and never build up enough displacement to trip the
    // stuck detector.
    const wantX = this.vel.x * dt;
    const dx = this.world.moveAxis(this.pos, this.radius, this.height, wantX, 'x');
    this.pos.x += dx;
    if (Math.abs(dx - wantX) > 1e-6) this.vel.x = dt > 0 ? dx / dt : 0;

    const wantZ = this.vel.z * dt;
    const dz = this.world.moveAxis(this.pos, this.radius, this.height, wantZ, 'z');
    this.pos.z += dz;
    if (Math.abs(dz - wantZ) > 1e-6) this.vel.z = dt > 0 ? dz / dt : 0;

    if (!hover) {
      const dy = this.world.moveAxis(this.pos, this.radius, this.height, this.vel.y * dt, 'y');
      this.pos.y += dy;
      if (dy !== this.vel.y * dt) this.vel.y = 0;
      const groundY = this.world.groundHeight(this.pos.x, this.pos.z, this.radius, this.pos.y + 0.6, 0.6);
      if (this.pos.y <= groundY + 0.02) { this.pos.y = groundY; this.vel.y = 0; this.onGround = true; }
      else this.onGround = false;
    }

    // Stuck detection. The *desired* velocity is what matters here: collision
    // resolution zeroes this.vel when a wall is hit, so comparing displacement
    // against this.vel would always look healthy and an agent wedged against
    // geometry would never trigger a recovery.
    const moved = Math.hypot(this.pos.x - this.lastPos.x, this.pos.z - this.lastPos.z);
    const wanted = Math.hypot(this.drive.x, this.drive.z) * dt;
    if (wanted > 0.01 && moved < wanted * 0.4) {
      this.stuckT += dt;
      if (this.stuckT > 0.5) {
        this.unstuck(ctx);
        this.stuckT = 0;
      }
    } else {
      this.stuckT = Math.max(0, this.stuckT - dt * 0.5);
    }
    this.lastPos.copy(this.pos);

    // never leave the facility
    const b = this.level.bounds;
    this.pos.x = Math.max(b.minX + 0.6, Math.min(b.maxX - 0.6, this.pos.x));
    this.pos.z = Math.max(b.minZ + 0.6, Math.min(b.maxZ - 0.6, this.pos.z));
  }

  /**
   * Progress watchdog — the last line of defence against an agent wedging
   * itself against the dais, a pylon or a crate cluster and stalling forever.
   *
   * Every other recovery path is local (steer out, recompute the route). When
   * none of them work, the unit is redeployed through the station's transit
   * grid: it re-appears at a valid spawn between 10 and 22 m from the player.
   * That fits the setting (the defence grid moves units around) and is
   * invisible in a fight with 30 creatures on screen.
   */
  watchdog(dt, ctx, dist) {
    this.warpCooldown = Math.max(0, this.warpCooldown - dt);
    if (!ctx.player.alive || this.dying) { this.progressT = 0; this.progressDist = Infinity; return; }
    if (dist < this.progressDist - 1.5) {
      this.progressDist = dist;
      this.progressT = 0;
      return;
    }
    if (dist < this.progressDist) this.progressDist = dist;
    this.progressT += dt;
    if (this.progressT < 7 || this.warpCooldown > 0) return;
    if (this.def.boss) { this.progressT = 0; this.warpCooldown = 8; return; }

    // Applies to any unit that is trying to reach the player, alerted or not —
    // an unalerted unit that cannot close the distance is just as stuck, and
    // without this a wave could stall on a single stranded creature.
    const spot = chooseSpawn(this.level, ctx.player.pos, { minDistance: 9, maxDistance: 20 });
    if (!spot) { this.progressT = 0; this.warpCooldown = 6; return; }
    this.fx?.particles.burst(this.center, new THREE.Vector3(0, 1, 0), {
      count: 10, speed: 3, spread: 1, life: 0.4, size: 0.14,
      color: [[0.7, 0.3, 0.9]], gravity: 0, drag: 3,
    });
    this.pos.set(spot.x, this.def.hover ? this.def.hover : 0.05, spot.z);
    this.vel.set(0, 0, 0);
    this.drive.set(0, 0, 0);
    this.path = null;
    this.pathIdx = 0;
    this.repathT = 0;
    this.lastPos.copy(this.pos);
    this.progressT = 0;
    this.progressDist = Infinity;
    this.warpCooldown = 7;
    this.fx?.particles.burst(this.center, new THREE.Vector3(0, 1, 0), {
      count: 10, speed: 3, spread: 1, life: 0.4, size: 0.14,
      color: [[0.9, 0.5, 1]], gravity: 0, drag: 3,
    });
  }

  /**
   * Deterministic recovery from a wedged state.
   *
   * Probes outward for the nearest genuinely free position. An earlier version
   * checked a body that was too short, so it "recovered" to a spot that was
   * still blocked and the loop repeated forever.
   */
  unstuck(ctx) {

    const solid = (b) => b.meta && (b.meta.kind === 'wall' || b.meta.kind === 'prop');
    // Embedded in geometry (bad spawn, a warp, a shove from the crowd)? Fix
    // that first. The overlap probe uses a slightly smaller body than the
    // collider test, so a creature can look free by that measure yet still
    // intersect a prop — which is what "embedded" in the simulation means.
    if (this.world.overlaps(this.pos.x, this.pos.y + 0.05, this.pos.z, this.radius, this.height, solid)) {
      const free = this.findFreeSpot(solid);
      if (free) {
        this.pos.x = free.x;
        this.pos.z = free.z;
        this.vel.set(0, 0, 0);
        this.drive.set(0, 0, 0);
        this.path = null;
        this.pathIdx = 0;
        this.repathT = 0;
        this.lastPos.copy(this.pos);
        return;
      }
    }
    if (ENEMY_DEBUG) ENEMY_DEBUG.unstuck++;
    const freeAt = (x, z) => !this.world.overlaps(x, this.pos.y + 0.2, z, this.radius, this.height * 0.9, solid) &&
      this.level.walkable(...this.level.worldToTile(x, z));

    let best = null;
    let bestDist = Infinity;
    for (const radius of [0.8, 1.4, 2.1, 3.0, 4.2]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + radius;
        const nx = this.pos.x + Math.cos(a) * radius;
        const nz = this.pos.z + Math.sin(a) * radius;
        if (!freeAt(nx, nz)) continue;
        const d = Math.hypot(nx - this.pos.x, nz - this.pos.z);
        if (d < bestDist) { bestDist = d; best = { x: nx, z: nz }; }
      }
      if (best) break;   // nearest ring with a free spot wins
    }
    if (!best) {
      const spot = this.level.nearestWalkable(this.pos.x, this.pos.z, 8);
      if (spot && freeAt(spot.x, spot.z)) best = spot;
    }
    if (best) {
      this.pos.x = best.x;
      this.pos.z = best.z;
      this.vel.set(0, this.vel.y, 0);
      this.path = null;
      this.pathIdx = 0;
      this.repathT = 0;
    }
  }

  /** Nearest position where the full body clears all solid geometry. */
  findFreeSpot(solid) {
    for (const radius of [0.6, 1.2, 2.0, 3.0, 4.5, 6.0]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + radius * 1.7;
        const x = this.pos.x + Math.cos(a) * radius;
        const z = this.pos.z + Math.sin(a) * radius;
        if (this.world.overlaps(x, this.pos.y + 0.05, z, this.radius, this.height, solid)) continue;
        if (!this.level.walkable(...this.level.worldToTile(x, z))) continue;
        return { x, z };
      }
    }
    const spot = this.level.nearestWalkable(this.pos.x, this.pos.z, 10);
    if (spot && !this.world.overlaps(spot.x, this.pos.y + 0.05, spot.z, this.radius, this.height, solid)) return spot;
    return null;
  }

  animate(dt, ctx, distToPlayer) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase = (this.walkPhase || 0) + dt * (2.5 + speed * 2.2);
    for (const leg of this.legs) {
      const info = leg.userData.leg;
      const swing = Math.sin(this.walkPhase + info.phase) * (0.12 + Math.min(0.5, speed * 0.12));
      leg.rotation.x = swing;
      leg.rotation.z = info.side * (1.0 + swing * 0.4);
    }
    // body bob / lean
    const bob = Math.sin(this.walkPhase * 2) * 0.03 * Math.min(1, speed / 3);
    this.root.position.set(this.pos.x, this.pos.y + bob + (this.def.hover ? 0 : 0), this.pos.z);
    this.root.rotation.y = this.yaw;
    const lean = Math.min(0.18, speed * 0.02);
    this.root.rotation.x = -lean;
    // attack telegraph: lean forward during windup
    if (this.state === 'attack' && this.windupT !== undefined) {
      this.root.rotation.x = -0.35;
      this.root.position.z += Math.sin(this.windupT * 12) * 0.02;
    }
    // eyes glow brighter when engaged
    const pulse = this.alerted ? 0.6 + 0.4 * Math.sin(performance.now() * 0.006 + this.id) : 0.25;
    for (const m of this.ownMats) {
      if (m.mat.emissiveIntensity !== undefined && m.mat.userData.shared !== false) {
        // only the eye materials have a strong emissive
        if (m.base && (m.base.r + m.base.g + m.base.b) > 0.4) {
          m.mat.emissiveIntensity = 1.5 + pulse * 2.5;
        }
      }
    }
    // footstep audio for ground units
    if (!this.def.hover && this.onGround && speed > 1.2) {
      this.footT -= dt * speed;
      if (this.footT <= 0) {
        this.footT = 3.2;
        this.audio?.play('footstep', { pos: this.pos, surface: this.level.regionNameAt(this.pos.x, this.pos.z), force: 0.6 });
      }
    }
  }

  updateDeath(dt) {
    this.deathT += dt;
    const t = Math.min(1, this.deathT / (this.def.boss ? 2.2 : 0.75));
    const fall = this.def.hover ? -1 : 1;
    this.root.rotation.x = fall * t * 1.3;
    this.root.position.y = this.pos.y - t * (this.def.hover ? 1.4 : 0.35);
    this.root.position.x = this.pos.x;
    this.root.position.z = this.pos.z;
    const s = 1 - t * 0.25;
    this.root.scale.setScalar(s);
    for (const m of this.ownMats) {
      if (!m.mat.transparent) { m.mat.transparent = true; }
      m.mat.opacity = 1 - t * 0.9;
    }
    if (this.deathT < 0.25 && Math.random() < 0.5) {
      this.fx?.particles.burst(this.center, new THREE.Vector3(0, 1, 0), {
        count: 3, speed: 3, spread: 1, life: 0.5, size: 0.14,
        color: [[0.8, 0.1, 0.15]], gravity: 8, drag: 2,
      });
    }
  }

  dispose(scene) {
    scene?.remove(this.root);
    this.root.traverse((o) => {
      if (o.isMesh && o.material && !o.material.userData?.shared) o.material.dispose?.();
    });
  }
}

/** Pick a spawn position far from the player, preferring unseen regions. */
export function chooseSpawn(level, playerPos, { minDistance = 16, maxDistance = Infinity, preferRegions = null } = {}) {
  const spots = level.openSpots.length ? level.openSpots : level.spawnPoints;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 44; i++) {
    const s = spots[(Math.random() * spots.length) | 0];
    const d = Math.hypot(s.x - playerPos.x, s.z - playerPos.z);
    if (d < minDistance || d > maxDistance) continue;
    // prefer the far end of the allowed band, then add jitter
    let score = Math.min(d, 45);
    if (preferRegions && preferRegions.includes(s.region)) score += 12;
    score += Math.random() * 10;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (!best) {
    // relax the constraints rather than failing to spawn
    for (let i = 0; i < 60; i++) {
      const s = spots[(Math.random() * spots.length) | 0];
      const d = Math.hypot(s.x - playerPos.x, s.z - playerPos.z);
      if (d < minDistance * 0.5 || d > maxDistance * 1.5) continue;
      if (d > bestScore) { bestScore = d; best = s; }
    }
  }
  return best || { x: playerPos.x, z: playerPos.z + 4, region: 'atrium' };
}
