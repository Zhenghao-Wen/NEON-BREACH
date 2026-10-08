/**
 * projectiles.js — thrown and fired payloads.
 *
 * Every projectile is swept along its path each frame (raycast between the
 * previous and next position) so fast rounds cannot tunnel through walls.
 */
import * as THREE from 'three';

const TEMP = new THREE.Vector3();
const TEMP2 = new THREE.Vector3();

function makeMesh(kind) {
  switch (kind) {
    case 'grenade': {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.55, metalness: 0.85 }),
      );
      g.add(body);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.088, 0.012, 6, 14),
        new THREE.MeshBasicMaterial({ color: 0xff5a3c }),
      );
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3020 }),
      );
      led.position.set(0, 0.09, 0);
      g.add(led);
      g.userData.led = led;
      return g;
    }
    case 'plasma': {
      const g = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.16, 1),
        new THREE.MeshBasicMaterial({ color: 0x8affc0 }),
      );
      g.add(core);
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.30, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x35ff90, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      g.add(halo);
      const light = new THREE.PointLight(0x5cffb0, 6, 8, 2);
      g.add(light);
      g.userData.halo = halo;
      return g;
    }
    case 'acid': {
      const g = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.13, 1),
        new THREE.MeshBasicMaterial({ color: 0xc8ff4a }),
      );
      g.add(core);
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x8fd020, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      g.add(halo);
      const light = new THREE.PointLight(0xaaff30, 4, 6, 2);
      g.add(light);
      return g;
    }
    case 'enemyBolt': {
      const g = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffa060 }),
      );
      g.add(core);
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      g.add(halo);
      return g;
    }
    default: {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      return m;
    }
  }
}

// ---------------------------------------------------------------------------
// grenades
// ---------------------------------------------------------------------------
export class Grenade {
  constructor({ origin, velocity, fuse = 2.4, damage = 165, radius = 5.6, owner = 'player' }) {
    this.mesh = makeMesh('grenade');
    this.pos = origin.clone();
    this.vel = velocity.clone();
    this.fuse = fuse;
    this.damage = damage;
    this.radius = radius;
    this.owner = owner;
    this.alive = true;
    this.bounces = 0;
    this.radiusCol = 0.09;
  }

  update(dt, world, onExplode) {
    this.fuse -= dt;
    // Check the fuse before the collision branches: a grenade that has come to
    // rest re-triggers the floor bounce every frame and returns early, so a
    // fuse check placed after them would never be reached.
    if (this.fuse <= 0) {
      this.alive = false;
      onExplode?.(this);
      return { detonated: true };
    }

    this.vel.y -= 19 * dt;
    // air drag
    this.vel.multiplyScalar(Math.exp(-dt * 0.25));

    const step = TEMP.copy(this.vel).multiplyScalar(dt);
    const dist = step.length();
    if (dist > 1e-5) {
      const dir = TEMP2.copy(step).multiplyScalar(1 / dist);
      const hit = world.raycast(this.pos, dir, dist + this.radiusCol);
      if (hit) {
        // move to the contact point and reflect
        this.pos.copy(hit.point).addScaledVector(hit.normal, this.radiusCol + 0.01);
        const vn = this.vel.dot(hit.normal);
        this.vel.addScaledVector(hit.normal, -vn * 1.55); // restitution 0.55
        this.vel.multiplyScalar(0.62);
        this.bounces++;
        return { bounced: true, speed: Math.abs(vn) };
      }
    }
    this.pos.add(step);
    // floor contact
    const groundY = world.groundHeight(this.pos.x, this.pos.z, this.radiusCol, this.pos.y + 0.2, 0.3);
    if (this.pos.y - this.radiusCol <= groundY) {
      this.pos.y = groundY + this.radiusCol;
      if (this.vel.y < 0) {
        this.vel.y = -this.vel.y * 0.42;
        this.vel.x *= 0.7;
        this.vel.z *= 0.7;
        if (Math.abs(this.vel.y) < 0.6) this.vel.y = 0;
        this.bounces++;
        return { bounced: true, speed: Math.abs(this.vel.y) };
      }
    }
    return null;
  }

  sync() {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += 0.18;
    this.mesh.rotation.y += 0.24;
    const led = this.mesh.userData.led;
    if (led) {
      const blink = this.fuse < 1 ? (Math.sin(this.fuse * 40) > 0 ? 1 : 0.15) : 0.7;
      led.material.color.setRGB(blink, blink * 0.2, blink * 0.1);
      led.scale.setScalar(0.8 + blink * 0.8);
    }
  }
}

// ---------------------------------------------------------------------------
// straight-line projectiles (plasma / acid / enemy bolts)
// ---------------------------------------------------------------------------
export class Bolt {
  constructor({
    origin, dir, speed, damage, splash = 0, splashDamage = 0, gravity = 0,
    kind = 'plasma', owner = null, lifetime = 6, radius = 0.16,
  }) {
    this.mesh = makeMesh(kind === 'acid' ? 'acid' : kind === 'enemyBolt' ? 'enemyBolt' : 'plasma');
    this.pos = origin.clone();
    this.dir = dir.clone().normalize();
    this.vel = this.dir.clone().multiplyScalar(speed);
    this.speed = speed;
    this.damage = damage;
    this.splash = splash;
    this.splashDamage = splashDamage;
    this.gravity = gravity;
    this.kind = kind;
    this.owner = owner;
    this.life = lifetime;
    this.alive = true;
    this.radius = radius;
    this.age = 0;
  }

  update(dt, world, ctx) {
    this.age += dt;
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return { expired: true }; }
    if (this.gravity) this.vel.y -= this.gravity * dt;

    const step = TEMP.copy(this.vel).multiplyScalar(dt);
    const dist = step.length();
    const dir = TEMP2.copy(step).multiplyScalar(1 / Math.max(1e-6, dist));

    // world hit
    const hit = world.raycast(this.pos, dir, dist + this.radius);
    let hitT = hit ? hit.t : Infinity;
    let hitNormal = hit ? hit.normal : null;

    // enemy hit (only for player projectiles)
    let hitEnemy = null;
    if (ctx?.enemies && this.owner === 'player') {
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const t = raySphere(this.pos, dir, e.pos.x, e.pos.y + e.height * 0.5, e.pos.z, e.radius + this.radius, Math.min(dist, hitT));
        if (t !== null && t < hitT) { hitT = t; hitEnemy = e; hitNormal = dir.clone().negate(); }
      }
    }
    // player hit (enemy projectiles)
    if (ctx?.player && this.owner !== 'player' && this.owner !== null) {
      const p = ctx.player;
      if (p.alive) {
        const cy = p.pos.y + p.eyeHeight * 0.8;
        const t = raySphere(this.pos, dir, p.pos.x, cy, p.pos.z, 0.55 + this.radius, Math.min(dist, hitT));
        if (t !== null && t < hitT) { hitT = t; hitEnemy = 'player'; hitNormal = dir.clone().negate(); }
      }
    }

    this.pos.addScaledVector(dir, Math.min(hitT, dist));

    if (hitEnemy || hitT <= dist) {
      this.alive = false;
      return { impact: true, point: this.pos.clone(), normal: hitNormal, enemy: hitEnemy === 'player' ? null : hitEnemy, hitPlayer: hitEnemy === 'player' };
    }
    return null;
  }

  sync() {
    this.mesh.position.copy(this.pos);
    const halo = this.mesh.userData.halo;
    if (halo) {
      const s = 1 + Math.sin(this.age * 22) * 0.13;
      halo.scale.setScalar(s);
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

// ---------------------------------------------------------------------------
// expanding shockwaves
// ---------------------------------------------------------------------------
export class Shockwave {
  constructor({ center, maxRadius, damage, speed = 13, owner = 'player', color = 0xffb060 }) {
    this.center = center.clone();
    this.maxRadius = maxRadius;
    this.radius = 0.4;
    this.speed = speed;
    this.damage = damage;
    this.owner = owner;
    this.alive = true;
    this.hitSet = new Set();
    const geo = new THREE.RingGeometry(0.92, 1.0, 40);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    this.inner = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.add(this.inner);
    this.mesh.position.copy(this.center);
  }

  update(dt, ctx) {
    this.radius += this.speed * dt;
    this.mesh.scale.setScalar(this.radius);
    this.inner.scale.setScalar(0.78);
    const t = this.radius / this.maxRadius;
    this.mesh.material.opacity = Math.max(0, 0.85 * (1 - t * t));
    this.inner.material.opacity = Math.max(0, 0.4 * (1 - t));
    this.mesh.position.y = this.center.y + 0.35 + Math.sin(this.radius * 2) * 0.05;

    // damage anything the ring sweeps over
    const targets = [];
    if (this.owner === 'player' && ctx?.enemies) targets.push(...ctx.enemies);
    if (this.owner !== 'player' && ctx?.player) targets.push(ctx.player);
    for (const target of targets) {
      if (!target || (target.alive === false)) continue;
      const key = target.id ?? 'player';
      if (this.hitSet.has(key)) continue;
      const d = Math.hypot(target.pos.x - this.center.x, target.pos.z - this.center.z);
      if (d <= this.radius) {
        this.hitSet.add(key);
        if (key === 'player') target.damage(this.damage, this.center);
        else target.takeDamage(this.damage, { fromDir: new THREE.Vector3().subVectors(target.pos, this.center).setY(0).normalize() });
      }
    }

    if (this.radius >= this.maxRadius) this.alive = false;
  }
}

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------
export class ProjectileManager {
  constructor(scene) {
    this.scene = scene;
    this.grenades = [];
    this.bolts = [];
    this.waves = [];
    this.group = new THREE.Group();
    this.group.name = 'projectiles';
    scene.add(this.group);
  }

  addGrenade(opts) {
    const g = new Grenade(opts);
    this.grenades.push(g);
    this.group.add(g.mesh);
    return g;
  }

  addBolt(opts) {
    const b = new Bolt(opts);
    this.bolts.push(b);
    this.group.add(b.mesh);
    return b;
  }

  addWave(opts) {
    const w = new Shockwave(opts);
    this.waves.push(w);
    this.group.add(w.mesh);
    return w;
  }

  update(dt, ctx) {
    const { world, fx, audio } = ctx;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const res = g.update(dt, world, (gren) => this.explodeGrenade(gren, ctx));
      g.sync();
      if (res?.bounced && res.speed > 1.0) {
        audio?.play('grenadeBounce', { pos: g.pos, volume: Math.min(1, res.speed / 6) });
      }
      if (!g.alive) {
        this.group.remove(g.mesh);
        this.grenades.splice(i, 1);
      }
    }

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const res = b.update(dt, world, ctx);
      b.sync();
      if (res?.impact) {
        this.onBoltImpact(b, res, ctx);
      } else if (res?.expired) {
        fx?.particles.burst(b.pos, new THREE.Vector3(0, 1, 0), {
          count: 6, speed: 2, spread: 1, life: 0.3, size: 0.1, color: [[0.5, 1, 0.7]], gravity: 0, drag: 2,
        });
      }
      if (!b.alive) {
        this.group.remove(b.mesh);
        this.bolts.splice(i, 1);
      }
    }

    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.update(dt, ctx);
      if (!w.alive) {
        this.group.remove(w.mesh);
        w.mesh.geometry.dispose();
        w.mesh.material.dispose();
        w.inner.material.dispose();
        this.waves.splice(i, 1);
      }
    }
  }

  explodeGrenade(g, ctx) {
    const { fx, audio, world } = ctx;
    fx?.explosion(g.pos, g.radius);
    audio?.play('explosion', { pos: g.pos });
    // radial damage with line-of-sight falloff
    const origin = g.pos.clone();
    if (ctx.enemies) {
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const c = e.center;
        const d = c.distanceTo(origin);
        if (d > g.radius + e.radius) continue;
        const los = world.lineOfSight(origin, c);
        const falloff = 1 - Math.min(1, d / (g.radius + e.radius));
        const dmg = g.damage * falloff * falloff * (los ? 1 : 0.45);
        if (dmg <= 1) continue;
        e.takeDamage(dmg, {
          sourcePos: origin,
          fromDir: new THREE.Vector3().subVectors(e.pos, origin).setY(0).normalize(),
          stagger: 0.4,
        });
        fx?.numbers.spawn(c, Math.round(dmg).toString(), 'normal');
      }
    }
    if (ctx.player && g.owner === 'player') {
      const p = ctx.player;
      const d = Math.hypot(p.pos.x - origin.x, p.pos.y + 0.9 - origin.y, p.pos.z - origin.z);
      if (d < g.radius * 0.8) {
        const falloff = 1 - d / (g.radius * 0.8);
        p.damage(g.damage * 0.35 * falloff * falloff, origin);
      }
    }
  }

  onBoltImpact(b, res, ctx) {
    const { fx, audio, world } = ctx;
    const kind = b.kind;
    const splash = b.splash;
    if (b.hitPlayer && ctx.player) {
      ctx.player.damage(b.damage, b.pos);
    } else if (res.enemy) {
      res.enemy.takeDamage(b.damage, { sourcePos: b.pos, headshot: false });
      fx?.numbers.spawn(res.enemy.center, Math.round(b.damage).toString(), 'normal');
    } else if (res.normal) {
      fx?.impact(b.pos, res.normal, kind === 'acid' ? 'flesh' : 'metal');
    }

    if (splash > 0) {
      fx?.explosion(b.pos, splash * 0.8);
      audio?.play('explosion', { pos: b.pos, volume: 0.8 });
      if (ctx.enemies) {
        for (const e of ctx.enemies) {
          if (!e.alive || e === res.enemy) continue;
          const c = e.center;
          const d = c.distanceTo(b.pos);
          if (d > splash) continue;
          const los = world.lineOfSight(b.pos, c);
          const falloff = 1 - d / splash;
          e.takeDamage(b.splashDamage * falloff * falloff * (los ? 1 : 0.4), {
            fromDir: new THREE.Vector3().subVectors(e.pos, b.pos).setY(0).normalize(),
            stagger: 0.2,
          });
          fx?.numbers.spawn(c, Math.round(b.splashDamage * falloff).toString(), 'normal');
        }
      }
      if (b.owner === 'player' && ctx.player) {
        const p = ctx.player;
        const d = Math.hypot(p.pos.x - b.pos.x, p.pos.y + 0.9 - b.pos.y, p.pos.z - b.pos.z);
        if (d < splash) p.damage(b.splashDamage * 0.3 * (1 - d / splash), b.pos);
      }
    }
  }

  clear() {
    for (const g of this.grenades) this.group.remove(g.mesh);
    for (const b of this.bolts) this.group.remove(b.mesh);
    for (const w of this.waves) { this.group.remove(w.mesh); w.mesh.geometry.dispose(); }
    this.grenades.length = 0;
    this.bolts.length = 0;
    this.waves.length = 0;
  }
}
