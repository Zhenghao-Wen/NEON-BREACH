/**
 * weapons.js — weapon definitions, procedural first-person viewmodels and the
 * animation rig that drives them.
 *
 * Stats are deliberately differentiated so each weapon has a role:
 *   rifle   all-rounder      smg     close-quarters spray
 *   shotgun burst at range    magnum  precision hand-cannon
 *   rail    pierce + 1-shot   plasma  explosive projectiles
 *   minigun sustained damage  grenade utility
 */
import * as THREE from 'three';
import { makeMaterial } from '../gfx/textures.js';

// ---------------------------------------------------------------------------
// stat table
// ---------------------------------------------------------------------------
export const WEAPONS = [
  {
    id: 'rifle', slot: 1, name: 'PULSE RIFLE', short: 'RIFLE', cls: '突击步枪',
    damage: 26, rpm: 620, auto: true, pellets: 1, magSize: 30, reserveMax: 300, startReserve: 180,
    spread: 0.010, adsSpread: 0.0022, moveSpread: 0.020, recoil: 0.90, recoilKick: 0.055,
    reloadTime: 2.05, range: 90, falloff: 0.55, pierce: 0, headMul: 2.4,
    adsFov: 55, adsZoom: 1.45, moveMul: 1.0, price: 0, tier: 0,
    desc: '可靠的中距离主力武器。全自动，后坐力可控，弹药充足。',
    tags: ['全自动', '中距离', '通用'],
  },
  {
    id: 'smg', slot: 2, name: 'WASP SMG', short: 'SMG', cls: '冲锋枪',
    damage: 16, rpm: 1000, auto: true, pellets: 1, magSize: 42, reserveMax: 420, startReserve: 210,
    spread: 0.022, adsSpread: 0.0075, moveSpread: 0.016, recoil: 0.55, recoilKick: 0.035,
    reloadTime: 1.65, range: 55, falloff: 0.75, pierce: 0, headMul: 2.1,
    adsFov: 62, adsZoom: 1.25, moveMul: 1.06, price: 900, tier: 1,
    desc: '极高射速，近距离撕碎蜂群。扩散较大，请贴近作战。',
    tags: ['高射速', '近距离', '机动'],
  },
  {
    id: 'shotgun', slot: 3, name: 'BREACHER 12', short: 'SHOTGUN', cls: '霰弹枪',
    damage: 17, rpm: 78, auto: false, pellets: 9, magSize: 7, reserveMax: 90, startReserve: 42,
    spread: 0.075, adsSpread: 0.048, moveSpread: 0.02, recoil: 2.6, recoilKick: 0.19,
    reloadTime: 2.7, range: 26, falloff: 2.1, pierce: 0, headMul: 1.6,
    adsFov: 68, adsZoom: 1.1, moveMul: 0.94, price: 1500, tier: 1,
    desc: '泵动式霰弹枪，一发九弹丸。距离越近伤害越恐怖。',
    tags: ['九弹丸', '爆发', '近距离'],
  },
  {
    id: 'magnum', slot: 4, name: 'JUDGE .50', short: 'MAGNUM', cls: '大口径手枪',
    damage: 74, rpm: 150, auto: false, pellets: 1, magSize: 8, reserveMax: 120, startReserve: 48,
    spread: 0.006, adsSpread: 0.0009, moveSpread: 0.030, recoil: 2.1, recoilKick: 0.15,
    reloadTime: 2.15, range: 120, falloff: 0.25, pierce: 1, headMul: 3.0,
    adsFov: 50, adsZoom: 1.6, moveMul: 0.98, price: 2200, tier: 2,
    desc: '精准、致命、贯穿一个目标。爆头伤害极高，适合精英单位。',
    tags: ['高精度', '贯穿', '爆头'],
  },
  {
    id: 'rail', slot: 5, name: 'ARC RAILGUN', short: 'RAILGUN', cls: '轨道炮',
    damage: 260, rpm: 42, auto: false, pellets: 1, magSize: 4, reserveMax: 60, startReserve: 24,
    spread: 0.0012, adsSpread: 0.0002, moveSpread: 0.05, recoil: 3.2, recoilKick: 0.26,
    reloadTime: 3.3, range: 200, falloff: 0, pierce: 6, headMul: 1.8,
    adsFov: 38, adsZoom: 2.6, moveMul: 0.86, price: 4200, tier: 3,
    desc: '穿透整条走廊的充能弹。可一枪贯穿数个敌人。',
    tags: ['穿透6', '超远程', '蓄力'],
  },
  {
    id: 'plasma', slot: 6, name: 'HELIX PLASMA', short: 'PLASMA', cls: '等离子发射器',
    damage: 95, rpm: 130, auto: true, pellets: 1, magSize: 12, reserveMax: 120, startReserve: 60,
    spread: 0.008, adsSpread: 0.003, moveSpread: 0.024, recoil: 1.2, recoilKick: 0.09,
    reloadTime: 2.5, range: 70, falloff: 0, pierce: 0, headMul: 1.5,
    price: 5200, tier: 3, projectile: { speed: 44, splash: 3.2, splashDamage: 74, gravity: 0 },
    adsFov: 60, adsZoom: 1.3, moveMul: 0.9,
    desc: '发射等离子球，命中后范围爆炸。对付成群敌人极其有效。',
    tags: ['爆炸', '范围伤害', '弹道'],
  },
  {
    id: 'minigun', slot: 7, name: 'VULCAN M6', short: 'MINIGUN', cls: '加特林',
    damage: 15, rpm: 1300, auto: true, pellets: 1, magSize: 160, reserveMax: 800, startReserve: 320,
    spread: 0.030, adsSpread: 0.016, moveSpread: 0.026, recoil: 0.42, recoilKick: 0.026,
    reloadTime: 4.4, range: 80, falloff: 0.6, pierce: 0, headMul: 1.7,
    spinUp: 0.55, moveMul: 0.8, price: 8200, tier: 4,
    adsFov: 64, adsZoom: 1.2,
    desc: '旋转枪管预热后倾泻弹雨。移动缓慢，但清场能力无与伦比。',
    tags: ['超高射速', '预热', '重火力'],
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export const STARTING_WEAPON = 'rifle';

// weapon upgrades purchasable in the armoury
export const UPGRADES = [
  { id: 'dmg1', name: '高压弹头 I', price: 1200, desc: '所有武器伤害 +12%', apply: (p) => { p.mods.damage *= 1.12; } },
  { id: 'dmg2', name: '高压弹头 II', price: 2600, desc: '所有武器伤害再 +15%', apply: (p) => { p.mods.damage *= 1.15; } },
  { id: 'rate1', name: '冷却回路 I', price: 1400, desc: '射速 +10%', apply: (p) => { p.mods.rpm *= 1.10; } },
  { id: 'rate2', name: '冷却回路 II', price: 3200, desc: '射速再 +12%', apply: (p) => { p.mods.rpm *= 1.12; } },
  { id: 'mag1', name: '扩容弹匣 I', price: 1100, desc: '弹匣容量 +30%', apply: (p) => { p.mods.mag *= 1.30; } },
  { id: 'mag2', name: '扩容弹匣 II', price: 2400, desc: '弹匣容量 +40%，备弹 +25%', apply: (p) => { p.mods.mag *= 1.40; p.mods.reserve *= 1.25; } },
  { id: 'reload1', name: '快速装填', price: 1300, desc: '换弹时间 -25%', apply: (p) => { p.mods.reload *= 0.75; } },
  { id: 'stable', name: '稳定枪机', price: 1600, desc: '后坐力 -30%，扩散 -20%', apply: (p) => { p.mods.recoil *= 0.70; p.mods.spread *= 0.80; } },
  { id: 'armor1', name: '复合装甲板', price: 1500, desc: '最大护甲 +40', apply: (p) => { p.stats.maxArmor += 40; p.stats.armor = Math.min(p.stats.maxArmor, p.stats.armor + 40); } },
  { id: 'health1', name: '强化生体', price: 2000, desc: '最大生命 +30 并立即治疗', apply: (p) => { p.stats.maxHealth += 30; p.stats.health = Math.min(p.stats.maxHealth, p.stats.health + 30); } },
  { id: 'speed1', name: '伺服外骨骼', price: 1700, desc: '移动速度 +12%', apply: (p) => { p.mods.speed *= 1.12; } },
  { id: 'crit1', name: '瞄准辅助芯片', price: 2300, desc: '爆头倍率 +50%，扩散 -15%', apply: (p) => { p.mods.headMul *= 1.5; p.mods.spread *= 0.85; } },
  { id: 'regen', name: '纳米修复器', price: 3000, desc: '每秒回复 1.2 点生命', apply: (p) => { p.mods.regen += 1.2; } },
  { id: 'vampire', name: '生命汲取', price: 3600, desc: '击杀回复 6 点生命', apply: (p) => { p.mods.lifesteal += 6; } },
  { id: 'lucky', name: '拾荒者协议', price: 1500, desc: '掉落与信用点收益 +40%', apply: (p) => { p.mods.luck *= 1.4; } },
];

// ---------------------------------------------------------------------------
// materials (shared across every viewmodel)
// ---------------------------------------------------------------------------
let MATS = null;
export function weaponMaterials() {
  if (MATS) return MATS;
  MATS = {
    body: makeMaterial('gunmetal', { repeat: [1, 1], color: 0x8d949e }),
    dark: makeMaterial('gunmetal', { repeat: [1, 1], color: 0x41464e, strength: 2.0 }),
    polymer: makeMaterial('crate', { repeat: [1, 1], color: 0x4c5560 }),
    grip: makeMaterial('organic', { repeat: [1, 1], color: 0x2f343b }),
    brass: makeMaterial('metalplate', { repeat: [1, 1], color: 0xd8a44a, metalScale: 1.2 }),
    glow: makeMaterial('energy', { repeat: [1, 1], color: 0x35e8ff, emissiveIntensity: 3.2 }),
    glowRed: makeMaterial('energy', { repeat: [1, 1], color: 0xff4a3c, emissiveIntensity: 3.0 }),
    glowViolet: makeMaterial('energy', { repeat: [1, 1], color: 0xb066ff, emissiveIntensity: 3.0 }),
    glowAmber: makeMaterial('energy', { repeat: [1, 1], color: 0xffb03a, emissiveIntensity: 3.0 }),
    glowGreen: makeMaterial('energy', { repeat: [1, 1], color: 0x3cff8a, emissiveIntensity: 3.0 }),
  };
  return MATS;
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 10, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

function part(group, geo, mat, x, y, z, rot = null) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  m.castShadow = false;
  m.receiveShadow = false;
  group.add(m);
  return m;
}

/**
 * Build a first-person viewmodel. Convention: the model points down -Z,
 * the origin sits at the grip, so the muzzle is around z = -0.6.
 */
export function buildViewModel(id) {
  const M = weaponMaterials();
  const root = new THREE.Group();
  root.name = 'viewmodel:' + id;
  const rig = { root, parts: {}, muzzle: new THREE.Object3D(), eject: new THREE.Object3D() };

  switch (id) {
    case 'rifle': {
      part(root, box(0.075, 0.085, 0.62), M.body, 0, 0, -0.20);          // receiver
      part(root, box(0.052, 0.05, 0.42), M.dark, 0, 0.055, -0.44);       // upper rail
      part(root, box(0.03, 0.026, 0.3), M.glow, 0, 0.083, -0.34);        // energy conduit
      part(root, cyl(0.021, 0.024, 0.30, 12), M.dark, 0, 0.008, -0.66, [Math.PI / 2, 0, 0]); // barrel
      part(root, cyl(0.030, 0.030, 0.07, 12), M.body, 0, 0.008, -0.80, [Math.PI / 2, 0, 0]); // muzzle brake
      part(root, box(0.06, 0.15, 0.085), M.dark, 0, -0.10, -0.06);       // magwell
      part(root, box(0.052, 0.20, 0.075), M.dark, 0, -0.20, -0.04, [0.22, 0, 0]); // magazine
      part(root, box(0.045, 0.13, 0.06), M.polymer, 0, -0.085, 0.10, [-0.28, 0, 0]); // grip
      part(root, box(0.05, 0.06, 0.16), M.polymer, 0, 0.0, 0.16);        // stock
      part(root, box(0.055, 0.055, 0.11), M.gunmetal, 0, 0.085, -0.14);  // optic housing
      part(root, cyl(0.019, 0.019, 0.10, 12, true), M.glowViolet, 0, 0.085, -0.15, [Math.PI / 2, 0, 0]); // lens
      rig.parts.magazine = root.children[6];
      rig.parts.charging = part(root, box(0.02, 0.03, 0.09), M.brass, -0.052, 0.03, -0.16);
      break;
    }
    case 'smg': {
      part(root, box(0.068, 0.075, 0.40), M.dark, 0, 0, -0.14);
      part(root, box(0.042, 0.04, 0.26), M.body, 0, 0.05, -0.30);
      part(root, cyl(0.017, 0.019, 0.22, 10), M.body, 0, 0.008, -0.44, [Math.PI / 2, 0, 0]);
      part(root, cyl(0.026, 0.026, 0.06, 10), M.glowAmber, 0, 0.008, -0.56, [Math.PI / 2, 0, 0]);
      part(root, box(0.05, 0.055, 0.09), M.glow, 0, 0.055, -0.10);
      part(root, box(0.048, 0.145, 0.065), M.dark, 0, -0.16, -0.08, [0.14, 0, 0]);
      part(root, box(0.04, 0.12, 0.055), M.polymer, 0, -0.08, 0.06, [-0.3, 0, 0]);
      part(root, box(0.045, 0.075, 0.10), M.polymer, 0, -0.02, 0.14);
      part(root, box(0.02, 0.02, 0.16), M.dark, 0.036, 0.055, -0.22);   // side rail
      rig.parts.magazine = root.children[5];
      break;
    }
    case 'shotgun': {
      part(root, box(0.085, 0.095, 0.48), M.polymer, 0, 0, -0.16);
      part(root, cyl(0.030, 0.030, 0.62, 12), M.dark, -0.028, 0.012, -0.60, [Math.PI / 2, 0, 0]);
      part(root, cyl(0.026, 0.026, 0.60, 12), M.body, 0.030, 0.012, -0.58, [Math.PI / 2, 0, 0]);
      const pump = part(root, box(0.10, 0.07, 0.16), M.grip, 0, -0.03, -0.46);
      pump.add(new THREE.Mesh(box(0.11, 0.012, 0.15), M.brass));
      rig.parts.pump = pump;
      part(root, box(0.055, 0.10, 0.09), M.dark, 0, -0.09, 0.02);
      part(root, box(0.05, 0.10, 0.20), M.polymer, 0, -0.06, 0.20, [0.1, 0, 0]);
      part(root, box(0.02, 0.02, 0.05), M.brass, 0, 0.06, -0.34);       // front bead
      part(root, box(0.016, 0.02, 0.03), M.brass, 0, 0.06, -0.02);
      break;
    }
    case 'magnum': {
      part(root, box(0.055, 0.075, 0.30), M.body, 0, 0.005, -0.14);
      part(root, cyl(0.031, 0.031, 0.14, 14), M.dark, 0, 0.005, -0.06, [Math.PI / 2, 0, 0]); // cylinder
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        part(root, cyl(0.008, 0.008, 0.145, 6), M.brass, Math.cos(a) * 0.019, 0.005 + Math.sin(a) * 0.019, -0.06, [Math.PI / 2, 0, 0]);
      }
      part(root, cyl(0.020, 0.022, 0.20, 12), M.dark, 0, 0.012, -0.32, [Math.PI / 2, 0, 0]);
      part(root, box(0.022, 0.03, 0.05), M.glowRed, 0, 0.055, -0.22);
      part(root, box(0.042, 0.14, 0.07), M.grip, 0, -0.10, 0.045, [-0.22, 0, 0]);
      part(root, box(0.014, 0.014, 0.14), M.dark, 0, 0.05, -0.20);       // vent rib
      rig.parts.cylinder = root.children[1];
      break;
    }
    case 'rail': {
      part(root, box(0.07, 0.09, 0.70), M.dark, 0, 0, -0.22);
      part(root, box(0.05, 0.05, 0.66), M.body, -0.042, 0.02, -0.24);
      part(root, box(0.05, 0.05, 0.66), M.body, 0.042, 0.02, -0.24);
      for (let i = 0; i < 5; i++) {
        part(root, box(0.10, 0.014, 0.03), M.glow, 0, 0.055, -0.14 - i * 0.12);
        part(root, box(0.10, 0.014, 0.03), M.glow, 0, -0.055, -0.14 - i * 0.12);
      }
      part(root, box(0.10, 0.10, 0.10), M.glowViolet, 0, 0, -0.60);
      part(root, cyl(0.016, 0.016, 0.34, 8), M.glowViolet, 0, 0, -0.78, [Math.PI / 2, 0, 0]);
      part(root, box(0.05, 0.06, 0.16), M.dark, 0, -0.06, 0.08);
      part(root, box(0.045, 0.13, 0.06), M.polymer, 0, -0.10, 0.10, [-0.2, 0, 0]);
      part(root, box(0.035, 0.035, 0.20), M.glowGreen, 0, 0.075, -0.18);
      rig.parts.coil = root.children[12];
      break;
    }
    case 'plasma': {
      part(root, box(0.09, 0.10, 0.52), M.polymer, 0, 0, -0.16);
      part(root, cyl(0.05, 0.055, 0.20, 14), M.dark, 0, 0, -0.50, [Math.PI / 2, 0, 0]);
      for (let i = 0; i < 3; i++) {
        part(root, new THREE.TorusGeometry(0.058 + i * 0.006, 0.008, 6, 16), M.glowGreen, 0, 0, -0.42 - i * 0.05, [0, 0, 0]);
      }
      part(root, cyl(0.030, 0.030, 0.24, 12), M.glowGreen, 0, 0, -0.68, [Math.PI / 2, 0, 0]);
      part(root, box(0.11, 0.11, 0.13), M.dark, 0, 0, -0.02);          // cell housing
      part(root, cyl(0.042, 0.042, 0.13, 12), M.glow, 0, 0.075, -0.02); // visible cell
      part(root, box(0.05, 0.13, 0.07), M.grip, 0, -0.10, 0.07, [-0.24, 0, 0]);
      part(root, box(0.06, 0.06, 0.16), M.polymer, 0, 0.0, 0.14);
      rig.parts.cell = root.children[7];
      break;
    }
    case 'minigun': {
      part(root, box(0.13, 0.13, 0.34), M.dark, 0, 0, -0.10);
      const spin = new THREE.Group();
      spin.position.set(0, 0, -0.40);
      root.add(spin);
      part(spin, cyl(0.055, 0.055, 0.06, 14), M.body, 0, 0, 0, [Math.PI / 2, 0, 0]);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        part(spin, cyl(0.014, 0.014, 0.62, 8), M.dark, Math.cos(a) * 0.042, Math.sin(a) * 0.042, 0.30, [Math.PI / 2, 0, 0]);
      }
      part(spin, cyl(0.062, 0.070, 0.07, 14), M.body, 0, 0, 0.60, [Math.PI / 2, 0, 0]);
      rig.parts.spin = spin;
      part(root, box(0.16, 0.16, 0.20), M.dark, 0, -0.10, 0.06);        // ammo box
      part(root, box(0.05, 0.14, 0.07), M.grip, -0.09, -0.09, 0.16, [-0.2, 0, 0]);
      part(root, box(0.05, 0.14, 0.07), M.grip, 0.09, -0.09, 0.16, [-0.2, 0, 0]);
      part(root, box(0.04, 0.035, 0.24), M.glowAmber, 0, 0.085, -0.10);
      break;
    }
    default: {
      part(root, box(0.07, 0.08, 0.4), M.body, 0, 0, -0.16);
    }
  }

  // muzzle / eject anchor points differ per weapon
  const muzzleZ = { rifle: -0.86, smg: -0.60, shotgun: -0.92, magnum: -0.44, rail: -0.96, plasma: -0.82, minigun: -0.78 }[id] ?? -0.7;
  rig.muzzle.position.set(0, 0.01, muzzleZ);
  root.add(rig.muzzle);
  rig.eject.position.set(0.06, 0.03, id === 'shotgun' ? -0.2 : -0.1);
  root.add(rig.eject);

  root.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; } });
  return rig;
}

// ---------------------------------------------------------------------------
// runtime weapon instance: ammo, firing cadence, animation state
// ---------------------------------------------------------------------------
export class WeaponInstance {
  constructor(def, mods = null) {
    this.def = def;
    this.mods = mods || { damage: 1, rpm: 1, mag: 1, reserve: 1, reload: 1, recoil: 1, spread: 1, speed: 1, headMul: 1 };
    this.magSize = Math.round(def.magSize * this.mods.mag);
    this.reserveMax = Math.round(def.reserveMax * this.mods.reserve);
    this.ammo = this.magSize;
    this.reserve = Math.min(this.reserveMax, Math.round((def.startReserve ?? def.magSize * 3) * this.mods.reserve));
    this.owned = false;
    this.upgradeLevel = 0;
    // animation state
    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.spin = 0;
    this.kick = 0;
    this.kickVel = 0;
    this.heat = 0;
    this.lastShot = -99;
  }

  get rpm() { return this.def.rpm * this.mods.rpm; }
  get damage() { return this.def.damage * this.mods.damage; }
  get reloadTime() { return this.def.reloadTime * this.mods.reload; }
  get canFire() { return this.ammo > 0 && !this.reloading && this.cooldown <= 0; }
  get needsReload() { return this.ammo <= 0 || (this.ammo < this.magSize * 0.25 && this.reserve > 0); }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.heat = Math.max(0, this.heat - dt * 0.7);
    if (this.reloading) {
      this.reloadT += dt;
      if (this.reloadT >= this.reloadTime) {
        const need = this.magSize - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloading = false;
        this.reloadT = 0;
        return 'reloaded';
      }
    }
    // recoil spring
    this.kickVel += -this.kick * 240 * dt;
    this.kickVel *= Math.exp(-dt * 12);
    this.kick += this.kickVel * dt;
    if (Math.abs(this.kick) < 1e-5 && Math.abs(this.kickVel) < 1e-4) { this.kick = 0; this.kickVel = 0; }
    return null;
  }

  /** Returns true when a shot was actually fired. */
  tryFire() {
    if (!this.canFire) return false;
    this.ammo--;
    this.cooldown = 60 / this.rpm;
    this.kickVel += this.def.recoilKick * 6.5;
    this.heat = Math.min(1, this.heat + 0.08);
    return true;
  }

  beginReload() {
    if (this.reloading || this.ammo >= this.magSize || this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadT = 0;
    return true;
  }

  cancelReload() { this.reloading = false; this.reloadT = 0; }

  addAmmo(frac = 0.5) {
    const add = Math.round(this.reserveMax * frac);
    const before = this.reserve;
    this.reserve = Math.min(this.reserveMax, this.reserve + add);
    return this.reserve - before;
  }

  /** Spread cone in radians for the current stance. */
  spreadFor({ ads = false, moving = false, crouch = false } = {}) {
    let s = ads ? this.def.adsSpread : this.def.spread;
    if (moving) s += this.def.moveSpread;
    if (crouch) s *= 0.62;
    s *= this.mods.spread;
    s *= 1 + this.heat * 0.8;
    return s;
  }
}
