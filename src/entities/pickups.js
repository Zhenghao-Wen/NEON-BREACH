/**
 * pickups.js — dropped and placed items.
 *
 * Each pickup is a small animated prop with a glow, a ground shadow ring and
 * proximity collection. Power-ups grant timed player buffs.
 */
import * as THREE from 'three';

export const PICKUP_TYPES = {
  health: { name: '医疗包', color: 0x4dffa1, icon: '✚', amount: 25, radius: 1.5, lifetime: 60, glyph: 'cross' },
  armor: { name: '护甲板', color: 0x4fe9ff, icon: '◈', amount: 25, radius: 1.5, lifetime: 60, glyph: 'plate' },
  ammo: { name: '弹药箱', color: 0xffb454, icon: '▮', amount: 0.4, radius: 1.6, lifetime: 75, glyph: 'box' },
  credits: { name: '信用点', color: 0xffd75a, icon: 'C', amount: 0, radius: 2.0, lifetime: 45, glyph: 'coin' },
  grenade: { name: '手雷', color: 0xff7a4d, icon: '◉', amount: 1, radius: 1.5, lifetime: 60, glyph: 'ball' },
  adrenaline: { name: '肾上腺素', color: 0xff4d7a, icon: '⚡', amount: 10, radius: 1.6, lifetime: 40, glyph: 'vial', timed: true },
  shield: { name: '护盾发生器', color: 0x9a7bff, icon: '⬡', amount: 100, radius: 1.6, lifetime: 45, glyph: 'hex', timed: true },
  haste: { name: '加速药剂', color: 0x4fe9ff, icon: '»', amount: 1.5, radius: 1.6, lifetime: 45, glyph: 'arrow', timed: true },
};

let MAT_CACHE = null;
function mats() {
  if (MAT_CACHE) return MAT_CACHE;
  MAT_CACHE = {};
  return MAT_CACHE;
}

function buildMesh(type) {
  const def = PICKUP_TYPES[type];
  const g = new THREE.Group();
  const glowMat = new THREE.MeshBasicMaterial({ color: def.color });
  const softMat = new THREE.MeshBasicMaterial({
    color: def.color, transparent: true, opacity: 0.24,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x2a3138, roughness: 0.45, metalness: 0.8,
    emissive: new THREE.Color(def.color).multiplyScalar(0.25),
  });

  switch (def.glyph) {
    case 'cross': {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.12), glowMat));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), glowMat));
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.22, 0.3), shellMat);
      box.position.y = -0.16;
      g.add(box);
      break;
    }
    case 'plate': {
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.1, 8), glowMat);
      g.add(sh);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.34), shellMat);
      b.position.y = -0.14;
      g.add(b);
      break;
    }
    case 'box': {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.26, 0.3), shellMat);
      g.add(b);
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.32), glowMat);
      l.position.y = 0.12;
      g.add(l);
      for (let i = 0; i < 3; i++) {
        const bl = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.18, 6), glowMat);
        bl.position.set(-0.1 + i * 0.1, 0.22, 0);
        g.add(bl);
      }
      break;
    }
    case 'coin': {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 8), glowMat);
      c.rotation.x = Math.PI / 2;
      g.add(c);
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.025, 6, 14), glowMat);
      g.add(r);
      break;
    }
    case 'ball': {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), shellMat));
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.02, 6, 12), glowMat);
      r.rotation.x = Math.PI / 2;
      g.add(r);
      break;
    }
    case 'vial': {
      const v = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 8), glowMat);
      g.add(v);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 8), shellMat);
      cap.position.y = 0.18;
      g.add(cap);
      break;
    }
    case 'hex': {
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 6), glowMat);
      h.rotation.x = Math.PI / 2;
      g.add(h);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.02, 6, 6), glowMat);
      g.add(ring);
      break;
    }
    case 'arrow': {
      g.add(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 6), glowMat));
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.2), glowMat);
      t.position.z = 0.2;
      g.add(t);
      break;
    }
    default: {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), glowMat));
    }
  }

  // soft halo + light
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), softMat);
  g.add(halo);
  const light = new THREE.PointLight(def.color, 3.2, 4.5, 2);
  g.add(light);
  g.userData.halo = halo;
  g.userData.spinTarget = g;
  return g;
}

export class Pickup {
  constructor(type, x, y, z, data = {}) {
    this.type = type;
    this.def = PICKUP_TYPES[type];
    this.pos = new THREE.Vector3(x, y, z);
    this.data = data;
    this.mesh = buildMesh(type);
    this.mesh.position.copy(this.pos);
    this.age = 0;
    this.life = data.lifetime ?? this.def.lifetime;
    this.alive = true;
    this.collected = false;
    this.phase = Math.random() * Math.PI * 2;
    this.spawnGrace = 0.35;
    this.baseY = y;
  }

  update(dt, ctx) {
    this.age += dt;
    this.life -= dt;
    this.spawnGrace = Math.max(0, this.spawnGrace - dt);
    if (this.life <= 0) this.alive = false;

    const bob = Math.sin(this.age * 2.1 + this.phase) * 0.09;
    this.mesh.position.y = this.baseY + 1.05 + bob;
    this.mesh.rotation.y += dt * (this.type === 'credits' ? 2.4 : 1.1);
    const halo = this.mesh.userData.halo;
    if (halo) {
      const pulse = 1 + Math.sin(this.age * 3 + this.phase) * 0.12;
      halo.scale.setScalar(pulse * (this.life < 5 ? (0.6 + 0.4 * Math.abs(Math.sin(this.age * 8))) : 1));
    }
    if (this.life < 5) {
      this.mesh.visible = Math.sin(this.age * 12) > -0.4;
    }

    // collection
    const p = ctx.player;
    if (!p || !p.alive || this.spawnGrace > 0) return;
    const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
    const dy = Math.abs((p.pos.y + 0.9) - this.mesh.position.y);
    if (d < this.def.radius + 0.4 && dy < 2.2) {
      this.collect(ctx);
    }
  }

  collect(ctx) {
    this.collected = true;
    this.alive = false;
    const p = ctx.player;
    const fx = ctx.fx;
    const audio = ctx.audio;
    const def = this.def;
    let text = '';

    switch (this.type) {
      case 'health': {
        const gained = p.heal(this.data.amount ?? def.amount);
        text = `+${Math.round(gained)} 生命`;
        fx?.healBurst(this.mesh.position);
        break;
      }
      case 'armor': {
        const gained = p.addArmor(this.data.amount ?? def.amount);
        text = `+${Math.round(gained)} 护甲`;
        fx?.shieldBurst(this.mesh.position);
        break;
      }
      case 'ammo': {
        let total = 0;
        for (const w of Object.values(p.weapons)) {
          if (!w.owned) continue;
          total += w.addAmmo(0.2);
        }
        text = `弹药补给 +${total}`;
        fx?.creditBurst(this.mesh.position);
        break;
      }
      case 'credits': {
        const amount = this.data.amount ?? 25;
        ctx.director?.addCredits(amount);
        text = `+${amount} 信用点`;
        fx?.creditBurst(this.mesh.position);
        audio?.play('credit');
        break;
      }
      case 'grenade': {
        p.grenades = Math.min(p.maxGrenades, p.grenades + (this.data.amount ?? 1));
        text = '获得手雷';
        fx?.creditBurst(this.mesh.position);
        break;
      }
      case 'adrenaline': {
        ctx.director?.applyPowerup('adrenaline', this.data.amount ?? 10);
        text = '肾上腺素：时间减缓';
        fx?.healBurst(this.mesh.position);
        break;
      }
      case 'shield': {
        ctx.director?.applyPowerup('shield', this.data.amount ?? 100);
        text = '护盾发生器启动';
        fx?.shieldBurst(this.mesh.position);
        break;
      }
      case 'haste': {
        ctx.director?.applyPowerup('haste', this.data.amount ?? 1.5);
        text = '加速药剂';
        fx?.healBurst(this.mesh.position);
        break;
      }
      default: break;
    }
    ctx.onToast?.(text, 'good');
    if (this.type !== 'credits') audio?.play('pickup');
  }

  dispose(scene) {
    scene?.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      }
    });
  }
}

export class PickupManager {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = 'pickups';
    scene.add(this.group);
  }

  spawn(type, x, y, z, data = {}) {
    const p = new Pickup(type, x, y, z, data);
    this.items.push(p);
    this.group.add(p.mesh);
    return p;
  }

  /** Drop loot at a position, nudged to a walkable tile. */
  dropAt(type, x, y, z, data = {}, level = null) {
    let px = x;
    let pz = z;
    if (level) {
      const spot = level.nearestWalkable(x, z, 3);
      if (spot) { px = spot.x; pz = spot.z; }
    }
    const gy = level ? 0 : y;
    return this.spawn(type, px, gy, pz, data);
  }

  update(dt, ctx) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.update(dt, ctx);
      if (!p.alive) {
        this.group.remove(p.mesh);
        p.mesh.traverse((o) => {
          if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
        });
        this.items.splice(i, 1);
      }
    }
  }

  count(type) {
    let n = 0;
    for (const p of this.items) if (p.type === type) n++;
    return n;
  }

  nearest(type, pos) {
    let best = null;
    let bd = Infinity;
    for (const p of this.items) {
      if (p.type !== type) continue;
      const d = Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  clear() {
    for (const p of this.items) {
      this.group.remove(p.mesh);
      p.mesh.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
    }
    this.items.length = 0;
  }
}
