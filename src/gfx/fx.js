/**
 * fx.js — combat feedback: particles, bullet decals, tracers, explosions and
 * floating damage numbers.
 *
 * Everything is pooled. Particles are a single THREE.Points draw call; decals
 * are a ring buffer of quads on a shared material.
 */
import * as THREE from 'three';
import { makeSpriteTextures } from './textures.js';

const MAX_PARTICLES = 4000;
const MAX_DECALS = 220;
const MAX_TRACERS = 64;
const MAX_NUMBERS = 48;

// ---------------------------------------------------------------------------
// particles
// ---------------------------------------------------------------------------
const PARTICLE_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main(){
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main(){
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
}
`;

export class ParticleSystem {
  constructor(scene, texture) {
    this.count = MAX_PARTICLES;
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    this.maxLife = new Float32Array(this.count);
    this.size = new Float32Array(this.count);
    this.alpha = new Float32Array(this.count);
    this.color = new Float32Array(this.count * 3);
    this.gravity = new Float32Array(this.count);
    this.drag = new Float32Array(this.count);
    this.growth = new Float32Array(this.count);
    this.cursor = 0;
    this.active = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geo.setDrawRange(0, this.count);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.geo = geo;
  }

  spawn(x, y, z, vx, vy, vz, opts = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    const life = opts.life ?? 0.6;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = opts.size ?? 0.12;
    this.alpha[i] = opts.alpha ?? 1;
    const c = opts.color || [1, 0.8, 0.4];
    this.color[i3] = c[0]; this.color[i3 + 1] = c[1]; this.color[i3 + 2] = c[2];
    this.gravity[i] = opts.gravity ?? 0;
    this.drag[i] = opts.drag ?? 1.6;
    this.growth[i] = opts.growth ?? 0;
  }

  burst(origin, dir, opts = {}) {
    const n = opts.count ?? 10;
    const speed = opts.speed ?? 6;
    const spread = opts.spread ?? 0.55;
    const color = opts.color || [1, 0.75, 0.35];
    for (let i = 0; i < n; i++) {
      const rx = (Math.random() - 0.5) * 2 * spread;
      const ry = (Math.random() - 0.5) * 2 * spread;
      const rz = (Math.random() - 0.5) * 2 * spread;
      const vx = (dir.x + rx) * speed * (0.5 + Math.random());
      const vy = (dir.y + ry) * speed * (0.5 + Math.random()) + (opts.lift ?? 0);
      const vz = (dir.z + rz) * speed * (0.5 + Math.random());
      this.spawn(
        origin.x, origin.y, origin.z, vx, vy, vz,
        {
          life: (opts.life ?? 0.55) * (0.6 + Math.random() * 0.8),
          size: (opts.size ?? 0.13) * (0.6 + Math.random() * 0.9),
          color: Array.isArray(color[0]) ? color[(Math.random() * color.length) | 0] : color,
          gravity: opts.gravity ?? 9,
          drag: opts.drag ?? 2.2,
          growth: opts.growth ?? 0,
        },
      );
    }
  }

  update(dt) {
    const { pos, vel, life, maxLife, alpha, size, gravity, drag, growth } = this;
    let active = 0;
    for (let i = 0; i < this.count; i++) {
      if (life[i] <= 0) { alpha[i] = 0; continue; }
      life[i] -= dt;
      if (life[i] <= 0) { alpha[i] = 0; continue; }
      const i3 = i * 3;
      const d = Math.exp(-drag[i] * dt);
      vel[i3] *= d;
      vel[i3 + 1] = vel[i3 + 1] * d - gravity[i] * dt;
      vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const t = life[i] / maxLife[i];
      alpha[i] = t * t;
      size[i] += growth[i] * dt;
      active++;
    }
    this.active = active;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// decals
// ---------------------------------------------------------------------------
export class DecalSystem {
  constructor(scene, textures) {
    this.scene = scene;
    this.textures = textures;
    this.materials = {
      bullet: new THREE.MeshBasicMaterial({ map: textures.scorch, transparent: true, depthWrite: false, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -4, blending: THREE.NormalBlending }),
      blood: new THREE.MeshBasicMaterial({ map: textures.blood, transparent: true, depthWrite: false, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -4 }),
      scorch: new THREE.MeshBasicMaterial({ map: textures.scorch, transparent: true, depthWrite: false, opacity: 0.8, polygonOffset: true, polygonOffsetFactor: -4 }),
    };
    this.ring = new THREE.MeshBasicMaterial({ map: textures.ring, transparent: true, depthWrite: false, opacity: 0.9, blending: THREE.AdditiveBlending });
    this.max = MAX_DECALS;
    this.items = [];
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.geo = geo;
    this.group = new THREE.Group();
    this.group.renderOrder = 2;
    scene.add(this.group);
    for (let i = 0; i < this.max; i++) {
      const m = new THREE.Mesh(geo, this.materials.bullet);
      m.visible = false;
      m.matrixAutoUpdate = true;
      this.group.add(m);
      this.items.push({ mesh: m, life: 0, fade: 0 });
    }
  }

  add(point, normal, kind = 'bullet', size = 0.32, fadeAfter = 22) {
    const slot = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    const mesh = slot.mesh;
    mesh.material = this.materials[kind] || this.materials.bullet;
    mesh.visible = true;
    mesh.position.copy(point).addScaledVector(normal, 0.012);
    const up = Math.abs(normal.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    const zAxis = normal.clone().normalize();
    const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    m.makeBasis(xAxis, yAxis, zAxis);
    mesh.quaternion.setFromRotationMatrix(m);
    mesh.rotateZ(Math.random() * Math.PI * 2);
    const s = size * (0.75 + Math.random() * 0.5);
    mesh.scale.set(s, s * (0.75 + Math.random() * 0.5), 1);
    slot.life = fadeAfter;
    slot.fade = fadeAfter;
    slot.mesh.material.opacity = (this.materials[kind] || this.materials.bullet).opacity;
  }

  /** Expanding ring flash (impacts / pickups). */
  ringAt(point, normal, color = 0x8ff0ff, size = 0.6) {
    const mesh = new THREE.Mesh(this.geo, this.ring.clone());
    mesh.material.color = new THREE.Color(color);
    mesh.position.copy(point).addScaledVector(normal, 0.03);
    const up = Math.abs(normal.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    const zAxis = normal.clone().normalize();
    const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    m.makeBasis(xAxis, yAxis, zAxis);
    mesh.quaternion.setFromRotationMatrix(m);
    mesh.scale.setScalar(size * 0.4);
    mesh.userData.t = 0;
    mesh.userData.dur = 0.35;
    mesh.userData.size = size;
    this.group.add(mesh);
    this.rings = this.rings || [];
    this.rings.push(mesh);
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      if (it.life < 4) {
        const base = it.mesh.material.userData.baseOpacity ?? it.mesh.material.opacity;
        it.mesh.material.userData.baseOpacity = base;
        it.mesh.material = it.mesh.material; // keep shared material; fade via scale instead
        const k = Math.max(0.02, it.life / 4);
        it.mesh.scale.setScalar(it.mesh.scale.x * (0.998));
        it.mesh.visible = k > 0.02;
      }
    }
    if (this.rings && this.rings.length) {
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        r.userData.t += dt;
        const t = r.userData.t / r.userData.dur;
        if (t >= 1) {
          this.group.remove(r);
          r.material.dispose();
          this.rings.splice(i, 1);
          continue;
        }
        r.scale.setScalar(r.userData.size * (0.3 + t * 1.4));
        r.material.opacity = (1 - t) * 0.85;
      }
    }
  }

  clear() {
    for (const it of this.items) { it.mesh.visible = false; it.life = 0; }
    if (this.rings) for (const r of this.rings) { this.group.remove(r); r.material.dispose(); }
    this.rings = [];
  }
}

// ---------------------------------------------------------------------------
// tracers
// ---------------------------------------------------------------------------
export class TracerSystem {
  constructor(scene) {
    this.geo = new THREE.CylinderGeometry(0.014, 0.014, 1, 6, 1, true);
    this.geo.rotateX(Math.PI / 2);
    this.geo.translate(0, 0, -0.5);
    this.materials = {
      bullet: new THREE.MeshBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      plasma: new THREE.MeshBasicMaterial({ color: 0x66ffb0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
      rail: new THREE.MeshBasicMaterial({ color: 0xc9a0ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
      enemy: new THREE.MeshBasicMaterial({ color: 0xff7043, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      red: new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
    };
    this.pool = [];
    this.group = new THREE.Group();
    this.group.renderOrder = 6;
    scene.add(this.group);
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(this.geo, this.materials.bullet);
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.pool.push({ mesh: m, life: 0, dur: 0.06 });
    }
    this.cursor = 0;
  }

  fire(from, to, kind = 'bullet', width = 1, dur = 0.055) {
    const slot = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    const m = slot.mesh;
    m.material = this.materials[kind] || this.materials.bullet;
    m.visible = true;
    m.position.copy(from);
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    m.lookAt(to);
    m.scale.set(width, width, len);
    slot.life = dur;
    slot.dur = dur;
  }

  update(dt) {
    for (const s of this.pool) {
      if (!s.mesh.visible) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      s.mesh.material.opacity = (s.life / s.dur) * 0.95;
      s.mesh.scale.x = s.mesh.scale.y = s.mesh.scale.x * 0.98 + 0.001;
    }
  }
}

// ---------------------------------------------------------------------------
// floating damage numbers (DOM overlay — cheap and always crisp)
// ---------------------------------------------------------------------------
export class DamageNumbers {
  constructor(container) {
    this.container = container;
    this.items = [];
    this.pool = [];
    this.layer = document.createElement('div');
    this.layer.id = 'fx-layer';
    container.appendChild(this.layer);
    this.v = new THREE.Vector3();
  }

  spawn(worldPos, text, kind = 'normal') {
    let el = this.pool.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'dmgnum';
      this.layer.appendChild(el);
    }
    el.className = 'dmgnum' + (kind === 'head' ? ' head' : '') + (kind === 'crit' ? ' head' : '');
    el.textContent = text;
    el.style.display = 'block';
    el.style.animation = 'none';
    // restart the CSS animation
    void el.offsetWidth;
    el.style.animation = '';
    this.items.push({ el, world: worldPos.clone(), life: 0.8, t: 0, kind });
  }

  update(dt, camera) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.t >= it.life) {
        it.el.style.display = 'none';
        this.pool.push(it.el);
        this.items.splice(i, 1);
        continue;
      }
      this.v.copy(it.world).project(camera);
      if (this.v.z > 1) { it.el.style.display = 'none'; continue; }
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      it.el.style.display = 'block';
      it.el.style.left = x + 'px';
      it.el.style.top = y + 'px';
      it.el.style.position = 'absolute';
    }
  }

  clear() {
    for (const it of this.items) { it.el.style.display = 'none'; this.pool.push(it.el); }
    this.items.length = 0;
  }
}

// ---------------------------------------------------------------------------
// facade
// ---------------------------------------------------------------------------
export class FX {
  constructor(scene, overlayContainer) {
    this.textures = makeSpriteTextures();
    this.particles = new ParticleSystem(scene, this.textures.spark);
    this.smoke = new ParticleSystem(scene, this.textures.smoke);
    this.smoke.material.blending = THREE.NormalBlending;
    this.decals = new DecalSystem(scene, this.textures);
    this.tracers = new TracerSystem(scene);
    this.numbers = new DamageNumbers(overlayContainer);
    this.scene = scene;
    this.lights = [];
  }

  /** Bullet impact on world geometry. */
  impact(point, normal, kind = 'concrete') {
    const palette = {
      concrete: [[1, 0.86, 0.6], [0.85, 0.8, 0.72]],
      metal: [[1, 0.95, 0.75], [1, 0.7, 0.35]],
      tile: [[1, 0.9, 0.75], [0.9, 0.9, 0.95]],
      flesh: [[0.85, 0.12, 0.16], [0.5, 0.05, 0.08]],
    }[kind] || [[1, 0.85, 0.6]];
    this.particles.burst(point, normal, {
      count: kind === 'flesh' ? 14 : 9, speed: 5.2, spread: 0.7, life: 0.4,
      size: 0.11, color: palette, gravity: 11, drag: 3.0,
    });
    if (kind !== 'flesh') {
      this.smoke.burst(point, normal, {
        count: 3, speed: 1.5, spread: 0.9, life: 0.6, size: 0.35, color: [0.55, 0.55, 0.6],
        gravity: -0.6, drag: 2.4, growth: 0.7, lift: 0.4,
      });
      this.decals.add(point, normal, 'bullet', 0.26);
    } else {
      this.decals.add(point, normal, 'blood', 0.55, 30);
    }
    this.decals.ringAt(point, normal, kind === 'flesh' ? 0xff4d5e : 0x9fe8ff, kind === 'flesh' ? 0.5 : 0.35);
    this.flash(point, kind === 'flesh' ? 0xff3344 : 0xffd9a0, 4.5, 0.08);
  }

  explosion(point, radius = 3) {
    this.particles.burst(point, new THREE.Vector3(0, 1, 0), {
      count: 46, speed: 12, spread: 1.0, life: 0.75, size: 0.3,
      color: [[1, 0.85, 0.4], [1, 0.5, 0.15], [1, 1, 0.85]], gravity: 6, drag: 1.6, lift: 2,
    });
    this.smoke.burst(point, new THREE.Vector3(0, 1, 0), {
      count: 22, speed: 4.5, spread: 1.0, life: 1.7, size: 0.95,
      color: [0.32, 0.30, 0.32], gravity: -1.4, drag: 1.1, growth: 1.6, lift: 1.4,
    });
    for (let i = 0; i < 6; i++) {
      const n = new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize();
      this.decals.add(
        new THREE.Vector3(point.x + n.x * radius * 0.4, point.y + 0.05, point.z + n.z * radius * 0.4),
        new THREE.Vector3(0, 1, 0), 'scorch', 1.5 * (0.7 + Math.random() * 0.7), 40,
      );
    }
    this.flash(point, 0xffb060, 60, 0.28, 16);
  }

  muzzleSmoke(pos, dir) {
    this.smoke.burst(pos, dir, {
      count: 2, speed: 1.2, spread: 0.6, life: 0.55, size: 0.22,
      color: [0.6, 0.6, 0.65], gravity: -0.8, drag: 2.4, growth: 0.9, lift: 0.5,
    });
  }

  bloodSpray(point, dir) {
    this.particles.burst(point, dir, {
      count: 12, speed: 4.5, spread: 0.8, life: 0.5, size: 0.14,
      color: [[0.8, 0.08, 0.12], [0.45, 0.02, 0.06]], gravity: 10, drag: 2.6,
    });
  }

  healBurst(point) {
    this.particles.burst(point, new THREE.Vector3(0, 1, 0), {
      count: 18, speed: 3.2, spread: 0.9, life: 0.9, size: 0.14,
      color: [[0.3, 1, 0.6], [0.7, 1, 0.85]], gravity: -2.5, drag: 1.6, lift: 1.2,
    });
    this.decals.ringAt(point, new THREE.Vector3(0, 1, 0), 0x4dffa1, 1.3);
  }

  shieldBurst(point) {
    this.particles.burst(point, new THREE.Vector3(0, 1, 0), {
      count: 16, speed: 3.0, spread: 0.9, life: 0.8, size: 0.13,
      color: [[0.35, 0.8, 1], [0.7, 0.95, 1]], gravity: -2, drag: 1.8, lift: 1,
    });
    this.decals.ringAt(point, new THREE.Vector3(1, 0, 0), 0x4fe9ff, 1.4);
  }

  creditBurst(point) {
    this.particles.burst(point, new THREE.Vector3(0, 1, 0), {
      count: 12, speed: 2.6, spread: 0.8, life: 0.8, size: 0.12,
      color: [[1, 0.85, 0.3], [1, 1, 0.8]], gravity: -1.5, drag: 1.8, lift: 1.4,
    });
  }

  /** Trigger a short-lived point light (explosions, muzzle flashes in world). */
  flash(point, color, intensity, dur, distance = 9) {
    let l = null;
    for (const cand of this.lights) {
      if (!cand.userData.busy) { l = cand; break; }
    }
    if (!l) {
      if (this.lights.length >= 8) return;
      l = new THREE.PointLight(color, 0, distance, 2);
      this.scene.add(l);
      this.lights.push(l);
    }
    l.userData.busy = true;
    l.userData.t = dur;
    l.userData.dur = dur;
    l.userData.base = intensity;
    l.color.setHex(color);
    l.distance = distance;
    l.intensity = intensity;
    l.position.copy(point);
  }

  update(dt, camera) {
    this.particles.update(dt);
    this.smoke.update(dt);
    this.decals.update(dt);
    this.tracers.update(dt);
    for (const l of this.lights) {
      if (!l.userData.busy) continue;
      l.userData.t -= dt;
      if (l.userData.t <= 0) { l.userData.busy = false; l.intensity = 0; continue; }
      l.intensity = l.userData.base * (l.userData.t / l.userData.dur);
    }
    if (camera) this.numbers.update(dt, camera);
  }

  clear() {
    this.particles.clear();
    this.smoke.clear();
    this.decals.clear();
    this.numbers.clear();
  }
}
