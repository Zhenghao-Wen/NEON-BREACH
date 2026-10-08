/**
 * player.js — the operative.
 *
 * First-person controller: capsule collision against the AABB world, sprint /
 * crouch / jump / dash, head bob, landing impact, view punch, ADS zoom, weapon
 * switching and the first-person viewmodel transform stack.
 */
import * as THREE from 'three';
import { WeaponInstance, WEAPON_BY_ID, WEAPONS, UPGRADES, STARTING_WEAPON } from './weapons.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  constructor({ camera, world, input, audio, level, director = null, viewmodels = null }) {
    this.camera = camera;
    this.world = world;
    this.input = input;
    this.audio = audio;
    this.level = level;
    // The director owns combat resolution; it is attached after construction
    // because it needs the player to exist first.
    this.director = director;
    // Optional viewmodel factory (kept separate so the player can run headless).
    this.viewmodels = viewmodels;

    this.pos = new THREE.Vector3(0, 0, 0);      // feet position
    this.vel = new THREE.Vector3();
    this.radius = 0.34;
    this.height = 1.78;
    this.crouchHeight = 1.15;
    this.eyeHeight = 1.62;
    this.eyeOffset = 0.1;

    this.yaw = 0;
    this.pitch = 0;
    this.crouch = 0;          // 0..1 smoothed
    this.wantCrouch = false;
    this.onGround = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.stepUp = 0.58;

    this.stats = {
      maxHealth: 100, health: 100,
      maxArmor: 50, armor: 0,
      stamina: 100, maxStamina: 100,
    };
    this.mods = {
      damage: 1, rpm: 1, mag: 1, reserve: 1, reload: 1, recoil: 1, spread: 1,
      speed: 1, headMul: 1, regen: 0, lifesteal: 0, luck: 1,
    };

    // movement tuning
    this.baseSpeed = 4.7;
    this.sprintMul = 1.62;
    this.crouchMul = 0.52;
    this.adsMul = 0.55;
    this.airControl = 0.32;
    this.accel = 11.5;
    this.friction = 9.0;
    this.gravity = 21.5;
    this.jumpSpeed = 6.4;

    // weapon state
    this.loadout = [STARTING_WEAPON];
    this.weapons = {};
    for (const def of WEAPONS) {
      const inst = new WeaponInstance(def, this.mods);
      inst.owned = def.id === STARTING_WEAPON;
      this.weapons[def.id] = inst;
    }
    this.currentId = STARTING_WEAPON;
    this.prevId = null;
    this.switchT = 0;
    this.switchDur = 0.45;
    this.ads = 0;
    this.adsWant = false;
    this.fireHeld = false;
    this.triggerReleased = true;
    this.upgrades = new Set();

    // feel
    this.bob = { phase: 0, amp: 0, target: 0 };
    this.landDip = 0;
    this.viewPunch = new THREE.Vector2();
    this.viewPunchVel = new THREE.Vector2();
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.damageDir = new THREE.Vector2();
    this.damageFlash = 0;
    this.healFlash = 0;
    this.footstepAccum = 0;
    this.lastGroundY = 0;
    this.dashCooldown = 0;
    this.grenades = 3;
    this.maxGrenades = 5;
    this.grenadeCooldown = 0;
    this.meleeCooldown = 0;
    this.slowmoT = 0;

    // view model container rendered in the main scene, attached to the camera
    this.viewGroup = new THREE.Group();
    this.viewGroup.name = 'viewmodel';
    camera.add(this.viewGroup);
    this.viewRigs = {};
    this.currentRig = null;
    this.muzzleFlash = null;
    this.muzzleLight = null;
    this._setupMuzzleFlash();

    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.events = [];
    this.equip(STARTING_WEAPON, true);
  }

  // ------------------------------------------------------------------ setup
  _setupMuzzleFlash() {
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0xfff0c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, map: null,
    }));
    this.muzzleFlash.scale.setScalar(0.34);
    this.muzzleFlash.userData.t = 0;
    this.viewGroup.add(this.muzzleFlash);
    this.muzzleLight = new THREE.PointLight(0xffdc9a, 0, 9, 2);
    this.viewGroup.add(this.muzzleLight);
  }

  get weapon() { return this.weapons[this.currentId]; }
  get def() { return this.weapon.def; }
  get eyeY() { return this.pos.y + this.eyeHeight - this.crouch * (this.height - this.crouchHeight); }
  get alive() { return this.stats.health > 0; }
  get speedMul() { return this.mods.speed; }

  // --------------------------------------------------------------- loadout
  giveWeapon(id) {
    const w = this.weapons[id];
    if (!w) return false;
    if (w.owned) return false;
    w.owned = true;
    w.ammo = w.magSize;
    w.reserve = Math.min(w.reserveMax, Math.round((w.def.startReserve ?? w.magSize * 2) * this.mods.reserve));
    this.loadout.push(id);
    this.loadout.sort((a, b) => WEAPON_BY_ID[a].slot - WEAPON_BY_ID[b].slot);
    return true;
  }

  buyUpgrade(id) {
    const up = UPGRADES.find((u) => u.id === id);
    if (!up || this.upgrades.has(id)) return false;
    up.apply(this);
    this.upgrades.add(id);
    // re-apply magazine scaling to already owned weapons
    for (const w of Object.values(this.weapons)) {
      const newMag = Math.round(w.def.magSize * this.mods.mag);
      const newReserve = Math.round(w.def.reserveMax * this.mods.reserve);
      if (newMag > w.magSize) w.ammo += newMag - w.magSize;
      w.magSize = newMag;
      w.reserveMax = newReserve;
      w.reserve = Math.min(w.reserveMax, w.reserve);
    }
    return true;
  }

  equip(id, instant = false) {
    if (!this.weapons[id] || !this.weapons[id].owned || id === this.currentId && !instant) return false;
    this.prevId = this.currentId;
    this.currentId = id;
    this.weapon.cancelReload();
    this.ads = 0;
    this.switchT = instant ? 0 : this.switchDur;
    // build the viewmodel lazily and cache it
    if (!this.viewRigs[id] && this.viewmodels) {
      const rig = this.viewmodels(id);
      if (rig) {
        rig.root.visible = false;
        this.viewGroup.add(rig.root);
        this.viewRigs[id] = rig;
      }
    }
    for (const [wid, rig] of Object.entries(this.viewRigs)) rig.root.visible = wid === id;
    this.currentRig = this.viewRigs[id] || null;
    if (this.currentRig) {
      this.muzzleFlash.position.copy(this.currentRig.muzzle.position);
    }
    this.events.push({ type: 'equip', id });
    return true;
  }

  cycleWeapon(dir) {
    const owned = this.loadout;
    if (owned.length < 2) return;
    let i = owned.indexOf(this.currentId);
    i = (i + dir + owned.length) % owned.length;
    this.equip(owned[i]);
  }

  equipSlot(slot) {
    const found = this.loadout.find((id) => WEAPON_BY_ID[id].slot === slot);
    if (found) this.equip(found);
  }

  // ------------------------------------------------------------------ input
  handleInput(dt) {
    const input = this.input;
    if (!input.enabled || !this.alive) return;

    // look
    const look = input.consumeLook();
    const adsSens = 1 - this.ads * 0.45;
    this.yaw += look.yaw * adsSens;
    this.pitch += look.pitch * adsSens;
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));

    // stance
    this.wantCrouch = input.isDown('ControlLeft') || input.isDown('ControlRight') || input.isDown('KeyC');
    const moving = input.axes();
    const isMoving = moving.x !== 0 || moving.y !== 0;
    const sprintKey = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    this.sprinting = sprintKey && isMoving && moving.y > 0.1 && !this.wantCrouch && this.ads < 0.3 &&
      this.stats.stamina > 1 && this.onGround;

    // dash (double-tap shift while moving forward)
    if (input.wasPressed('ShiftLeft') || input.wasPressed('ShiftRight')) {
      const now = performance.now();
      if (this._lastShift && now - this._lastShift < 280 && isMoving && this.dashCooldown <= 0) {
        this.doDash(moving);
      }
      this._lastShift = now;
    }

    // jump
    if (input.wasPressed('Space')) this.jumpBuffer = 0.18;

    // weapons
    for (let s = 1; s <= 7; s++) {
      if (input.wasPressed('Digit' + s)) this.equipSlot(s);
    }
    if (input.wheel) this.cycleWeapon(input.wheel > 0 ? 1 : -1);
    if (input.wasPressed('KeyR')) this.startReload();
    if (input.wasPressed('KeyQ')) this.throwGrenade();
    if (input.wasPressed('KeyF')) this.melee();

    this.adsWant = input.mouseDown(2) && this.switchT <= 0 && this.weapon.ammo > 0;
    this.fireHeld = input.mouseDown(0) && this.switchT <= 0 && this.alive;
    if (!input.mouseDown(0)) this.triggerReleased = true;
  }

  doDash(moveAxes) {
    if (this.dashCooldown > 0 || this.stats.stamina < 25) return;
    const dir = this.tmp.set(moveAxes.x, 0, moveAxes.y).applyAxisAngle(UP, this.yaw).normalize();
    this.vel.x += dir.x * 12.5;
    this.vel.z += dir.z * 12.5;
    this.dashCooldown = 1.4;
    this.stats.stamina -= 25;
    this.viewPunchVel.y += 6;
    this.audio?.play('dash');
  }

  startReload() {
    if (this.weapon.beginReload()) {
      this.audio?.play('reload', { weapon: this.def.id });
      this.events.push({ type: 'reload' });
    }
  }

  throwGrenade() {
    if (this.grenades <= 0 || this.grenadeCooldown > 0) return;
    this.grenades--;
    this.grenadeCooldown = 0.9;
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const origin = new THREE.Vector3(this.pos.x, this.eyeY - 0.1, this.pos.z).addScaledVector(dir, 0.6);
    this.director?.spawnGrenade(origin, dir.multiplyScalar(17).add(new THREE.Vector3(0, 3.4, 0)));
    this.audio?.play('throw');
    this.events.push({ type: 'grenade' });
  }

  melee() {
    if (this.meleeCooldown > 0) return;
    this.meleeCooldown = 0.62;
    this.viewPunchVel.x += 10;
    this.audio?.play('melee');
    const origin = this.eyePos(this.tmp);
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.director?.meleeSwing(origin, dir, 2.4, 95);
    this.events.push({ type: 'melee' });
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.eyeY, this.pos.z);
  }

  // --------------------------------------------------------------- movement
  update(dt) {
    const input = this.input;
    const wish = input.enabled && this.alive ? input.axes() : { x: 0, y: 0 };

    // crouch smoothing
    const crouchTarget = this.wantCrouch ? 1 : 0;
    this.crouch += (crouchTarget - this.crouch) * Math.min(1, dt * 13);

    // stamina
    if (this.sprinting) {
      this.stats.stamina = Math.max(0, this.stats.stamina - dt * 22);
    } else {
      this.stats.stamina = Math.min(this.stats.maxStamina, this.stats.stamina + dt * (this.onGround ? 16 : 6));
    }
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);

    // desired horizontal velocity
    const dir = this.tmp.set(wish.x, 0, wish.y);
    if (dir.lengthSq() > 0) dir.normalize().applyAxisAngle(UP, this.yaw);

    let speed = this.baseSpeed * this.mods.speed;
    if (this.crouch > 0.5) speed *= this.crouchMul;
    else if (this.sprinting) speed *= this.sprintMul;
    if (this.ads > 0.5) speed *= this.adsMul;
    speed *= this.def.moveMul;

    const target = this.tmp2.set(dir.x * speed, 0, dir.z * speed);
    const control = this.onGround ? 1 : this.airControl;
    const accel = this.accel * control;
    this.vel.x += (target.x - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (target.z - this.vel.z) * Math.min(1, accel * dt);
    if (this.onGround && dir.lengthSq() === 0) {
      const damp = Math.exp(-this.friction * dt);
      this.vel.x *= damp;
      this.vel.z *= damp;
    }

    // gravity + jump
    this.vel.y -= this.gravity * dt;
    if (this.jumpBuffer > 0) {
      this.jumpBuffer -= dt;
      if (this.onGround || this.coyote > 0) {
        this.vel.y = this.jumpSpeed * (this.crouch > 0.5 ? 0.82 : 1);
        this.onGround = false;
        this.coyote = 0;
        this.jumpBuffer = 0;
        this.audio?.play('jump');
      }
    }

    // vertical resolve
    const h = this.height - this.crouch * (this.height - this.crouchHeight);
    const dy = this.world.moveAxis(this.pos, this.radius, h, this.vel.y * dt, 'y');
    const wasFalling = this.vel.y < -1.5;
    this.pos.y += dy;
    if (dy !== this.vel.y * dt) {
      if (this.vel.y < 0) {
        if (wasFalling) {
          this.landDip = Math.min(1, Math.abs(this.vel.y) / 9);
          this.audio?.play('land', { force: this.landDip });
        }
        this.pos.y = Math.round(this.pos.y * 1000) / 1000;
      }
      this.vel.y = 0;
    }

    // ground snap / step handling
    const groundY = this.world.groundHeight(this.pos.x, this.pos.z, this.radius, this.pos.y + this.stepUp, this.stepUp);
    if (this.pos.y <= groundY + 0.02) {
      if (!this.onGround && this.vel.y <= 0 && wasFalling) {
        this.landDip = Math.max(this.landDip, Math.min(1, Math.abs(this.vel.y) / 9));
        this.audio?.play('land', { force: this.landDip });
      }
      this.pos.y = groundY;
      this.vel.y = 0;
      this.onGround = true;
      this.coyote = 0.1;
    } else {
      this.onGround = false;
      this.coyote = Math.max(0, this.coyote - dt);
    }

    // horizontal resolve, one axis at a time so we slide along walls
    const dx = this.world.moveAxis(this.pos, this.radius, h, this.vel.x * dt, 'x');
    if (dx !== this.vel.x * dt) this.vel.x = 0;
    this.pos.x += dx;
    const dz = this.world.moveAxis(this.pos, this.radius, h, this.vel.z * dt, 'z');
    if (dz !== this.vel.z * dt) this.vel.z = 0;
    this.pos.z += dz;

    // keep the player inside the facility footprint
    const b = this.level.bounds;
    this.pos.x = Math.max(b.minX + 1, Math.min(b.maxX - 1, this.pos.x));
    this.pos.z = Math.max(b.minZ + 1, Math.min(b.maxZ - 1, this.pos.z));

    // fall out of the world safety net
    if (this.pos.y < -6) {
      this.pos.y = 1.2;
      this.vel.set(0, 0, 0);
      this.damage(15, null, { silent: true });
    }

    this.updateFeel(dt, wish);
    this.updateWeapon(dt);
  }

  updateFeel(dt, wish) {
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    // head bob
    const targetAmp = this.onGround ? Math.min(1, horizSpeed / this.baseSpeed) * (this.sprinting ? 1.35 : 1) : 0;
    this.bob.target = targetAmp;
    this.bob.amp += (this.bob.target - this.bob.amp) * Math.min(1, dt * 7);
    const freq = this.sprinting ? 11.5 : 8.6;
    this.bob.phase += dt * freq * (0.35 + this.bob.amp);
    // footsteps on the bob cycle
    if (this.onGround && this.bob.amp > 0.25) {
      this.footstepAccum += dt * freq * (0.35 + this.bob.amp) / Math.PI;
      if (this.footstepAccum >= 1) {
        this.footstepAccum -= 1;
        this.audio?.play('footstep', { surface: this.level.regionNameAt(this.pos.x, this.pos.z), force: this.bob.amp });
      }
    }
    this.landDip *= Math.exp(-dt * 6);

    // recoil recovery
    this.recoilPitch *= Math.exp(-dt * 7.5);
    this.recoilYaw *= Math.exp(-dt * 7.5);

    // view punch spring
    this.viewPunchVel.x += -this.viewPunch.x * 190 * dt;
    this.viewPunchVel.y += -this.viewPunch.y * 190 * dt;
    this.viewPunchVel.multiplyScalar(Math.exp(-dt * 9));
    this.viewPunch.x += this.viewPunchVel.x * dt;
    this.viewPunch.y += this.viewPunchVel.y * dt;

    // ADS blend
    const adsTarget = this.adsWant && this.switchT <= 0 ? 1 : 0;
    const adsSpeed = adsTarget > this.ads ? 13 : 9;
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * adsSpeed);

    // camera transform
    const cam = this.camera;
    const bobY = Math.sin(this.bob.phase * 2) * 0.028 * this.bob.amp;
    const bobX = Math.cos(this.bob.phase) * 0.032 * this.bob.amp;
    const roll = Math.cos(this.bob.phase) * 0.012 * this.bob.amp;

    cam.position.set(
      this.pos.x + bobX * 0.9,
      this.eyeY + bobY - this.landDip * 0.18,
      this.pos.z,
    );
    const kickPitch = this.recoilPitch + this.viewPunch.x * 0.02;
    const kickYaw = this.recoilYaw + this.viewPunch.y * 0.02;
    cam.rotation.set(this.pitch + kickPitch, this.yaw + kickYaw, roll + this.viewPunch.y * 0.012);

    // FOV: sprint push, ADS zoom, dash punch
    const baseFov = this.director?.settings?.fov ?? 78;
    const sprintFov = this.sprinting ? 4.5 : 0;
    const targetFov = this.ads > 0.01
      ? THREE.MathUtils.lerp(baseFov + sprintFov, this.def.adsFov ?? 55, this.ads)
      : baseFov + sprintFov;
    const fovVel = this._fovVel || 0;
    const newFov = cam.fov + (targetFov - cam.fov) * Math.min(1, dt * 11);
    if (Math.abs(newFov - cam.fov) > 0.001) { cam.fov = newFov; cam.updateProjectionMatrix(); }

    this.damageFlash *= Math.exp(-dt * 3.2);
    this.healFlash *= Math.exp(-dt * 3.4);
    if (this.slowmoT > 0) this.slowmoT -= dt;
  }

  updateWeapon(dt) {
    const w = this.weapon;
    const res = w.update(dt);
    if (res === 'reloaded') {
      this.audio?.play('reloadEnd', { weapon: this.def.id });
      this.events.push({ type: 'reloaded' });
    }
    if (this.switchT > 0) this.switchT = Math.max(0, this.switchT - dt);

    // fire control
    const canAuto = this.def.auto;
    const wantShot = this.fireHeld && (canAuto || this.triggerReleased);
    if (wantShot && this.switchT <= 0 && this.alive) {
      if (w.ammo <= 0) {
        if (this.triggerReleased) {
          this.triggerReleased = false;
          this.audio?.play('dryfire');
          this.startReload();
        }
      } else if (w.tryFire()) {
        this.triggerReleased = false;
        this.onFire();
      }
    }
    // auto-reload when empty
    if (w.ammo <= 0 && !w.reloading && w.reserve > 0 && this.fireHeld) this.startReload();

    this.updateViewModel(dt);
  }

  onFire() {
    const w = this.weapon;
    const spread = w.spreadFor({ ads: this.ads > 0.5, moving: Math.hypot(this.vel.x, this.vel.z) > 2.4, crouch: this.crouch > 0.5 });
    const origin = this.eyePos(new THREE.Vector3());
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));

    this.director?.fireWeapon({
      player: this, weapon: w, def: this.def, origin, dir, spread,
      pellets: this.def.pellets,
      damage: w.damage,
      range: this.def.range,
      falloff: this.def.falloff,
      pierce: this.def.pierce,
      headMul: this.def.headMul * this.mods.headMul,
      projectile: this.def.projectile || null,
    });

    // recoil
    const recoilBase = this.def.recoil * this.mods.recoil;
    const adsMul = 1 - this.ads * 0.42;
    this.recoilPitch += recoilBase * 0.011 * adsMul * (0.85 + Math.random() * 0.3);
    this.recoilYaw += (Math.random() - 0.5) * recoilBase * 0.010 * adsMul;
    this.viewPunch.x -= 1.6 + recoilBase * 0.6;
    this.viewPunchVel.y -= (Math.random() - 0.5) * 5;
    if (this.onGround) { this.vel.x -= dir.x * 0.25; this.vel.z -= dir.z * 0.25; }

    // muzzle flash
    const mf = this.muzzleFlash;
    mf.material.opacity = 1;
    mf.material.rotation = Math.random() * Math.PI * 2;
    mf.scale.setScalar((this.def.id === 'shotgun' ? 0.5 : 0.3) * (0.8 + Math.random() * 0.5));
    mf.userData.t = 0.055;
    w.lastShotVisual = performance.now() / 1000;
    this.muzzleLight.intensity = this.def.id === 'shotgun' ? 26 : 15;
    this.muzzleLight.distance = 10;

    this.audio?.play('shot', { weapon: this.def.id });
    this.events.push({ type: 'fire', id: this.def.id });
  }

  updateViewModel(dt) {
    const rig = this.currentRig;
    const w = this.weapon;
    if (!rig) return;

    // switch animation: dip the weapon out of frame and back
    let switchDip = 0;
    if (this.switchT > 0) {
      const t = 1 - this.switchT / this.switchDur;
      switchDip = Math.sin(Math.min(1, t) * Math.PI) * 1.0;
    }

    // sprint pose
    const sprintPose = this.sprinting ? 1 : 0;
    this._sprintPose = (this._sprintPose ?? 0) + (sprintPose - (this._sprintPose ?? 0)) * Math.min(1, dt * 6);

    // idle sway follows look delta
    const sway = this._sway || (this._sway = { x: 0, y: 0 });
    sway.x += ((-this.viewPunch.y * 0.05) - sway.x) * Math.min(1, dt * 8);
    sway.y += ((-this.recoilPitch * 0.3) - sway.y) * Math.min(1, dt * 8);

    const adsX = 0;
    const adsY = 0.052;
    const adsZ = 0.16;
    const hipX = 0.175;
    const hipY = -0.155;
    const hipZ = -0.30;

    const a = this.ads;
    const baseX = THREE.MathUtils.lerp(hipX, adsX, a);
    const baseY = THREE.MathUtils.lerp(hipY, adsY, a);
    const baseZ = THREE.MathUtils.lerp(hipZ, adsZ, a);

    const bobAmt = this.bob.amp * (1 - a * 0.8);
    const bx = Math.cos(this.bob.phase) * 0.026 * bobAmt;
    const by = Math.sin(this.bob.phase * 2) * 0.020 * bobAmt;

    const sp = this._sprintPose;
    const sx = sp * 0.10;
    const sy = -sp * 0.10;
    const sz = sp * 0.12;
    const sRoll = sp * 0.55;

    const kick = w.kick;
    const reloadP = w.reloading ? Math.min(1, w.reloadT / w.reloadTime) : 0;
    const reloadArc = w.reloading ? Math.sin(reloadP * Math.PI) : 0;

    const root = rig.root;
    root.position.set(
      baseX + bx + sx + switchDip * -0.08,
      baseY + by + sy - switchDip * 0.34 - reloadArc * 0.14,
      baseZ + sz + kick * 0.10 + reloadArc * 0.05,
    );
    root.rotation.set(
      -kick * 0.42 + reloadArc * 0.55 - switchDip * 0.5 + sway.y,
      sway.x + reloadArc * 0.25 + switchDip * 0.3 - yawDrift(this),
      sRoll,
    );
    root.scale.setScalar(1 - a * 0.06);

    // weapon-specific mechanical animation
    const parts = rig.parts;
    if (parts.magazine) {
      const drop = reloadP < 0.45 ? reloadP / 0.45 : reloadP < 0.7 ? 0 : 1 - (reloadP - 0.7) / 0.3;
      parts.magazine.position.y = -0.20 - drop * 0.22;
      parts.magazine.rotation.z = drop * 0.7;
    }
    if (parts.pump) {
      // pump action after each shot
      const pumpT = Math.max(0, 1 - (performance.now() / 1000 - w.lastShotVisual) * 4);
      parts.pump.position.z = -0.46 + Math.sin((1 - pumpT) * Math.PI) * 0.10;
    }
    if (parts.spin) {
      const spinning = this.fireHeld || w.spin > 0.05;
      w.spin = Math.max(0, Math.min(1, w.spin + (spinning ? dt * 3.2 : -dt * 1.6)));
      parts.spin.rotation.z += w.spin * dt * 46;
    }
    if (parts.cylinder) {
      parts.cylinder.rotation.z += (w.reloading ? 0.9 : 0) * dt;
    }
    if (parts.charging) {
      parts.charging.position.z = -0.16 + Math.sin(performance.now() * 0.004) * 0.006 - kick * 0.08;
    }
    if (parts.coil) {
      const charge = w.ammo > 0 ? 0.6 + Math.sin(performance.now() * 0.006) * 0.25 : 0.2;
      parts.coil.material.emissiveIntensity = charge * 2.2;
    }
    if (parts.cell) {
      parts.cell.rotation.y += dt * (1 + w.heat * 6);
    }

    // muzzle flash lifetime
    const mf = this.muzzleFlash;
    if (mf.userData.t > 0) {
      mf.userData.t -= dt;
      mf.material.opacity = Math.max(0, mf.userData.t / 0.055);
      if (mf.userData.t <= 0) { mf.material.opacity = 0; this.muzzleLight.intensity = 0; }
    }
    this.muzzleLight.intensity *= Math.exp(-dt * 22);
    mf.position.copy(rig.muzzle.position);
    this.muzzleLight.position.copy(rig.muzzle.position);

    // keep the weapon out of walls: pull it back when the barrel would clip
    const cam = this.camera;
    const fwd = this.tmp2.set(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const hit = this.world.raycast(cam.position, fwd, 1.9);
    if (hit) {
      const limit = Math.max(0.18, hit.t - 0.28);
      const depth = Math.max(0, -(root.position.z + 0.85));
      if (depth > limit) {
        root.position.z += limit - depth;
        root.rotation.x += 0.22;
      }
    }
  }

  // ------------------------------------------------------------------ damage
  damage(amount, source = null, opts = {}) {
    if (!this.alive || this._god) return 0;
    let dmg = amount;
    if (this.stats.armor > 0) {
      const absorbed = Math.min(this.stats.armor, dmg * 0.65);
      this.stats.armor -= absorbed;
      dmg -= absorbed;
    }
    const dealt = Math.min(this.stats.health, dmg);
    this.stats.health -= dealt;
    this.damageFlash = Math.min(1, this.damageFlash + amount / 45);
    this.viewPunch.x -= amount * 0.06;
    this.viewPunchVel.y += (Math.random() - 0.5) * amount * 0.5;
    if (!opts.silent) this.audio?.play('hurt', { force: Math.min(1, amount / 30) });
    if (source) {
      const dx = source.x - this.pos.x;
      const dz = source.z - this.pos.z;
      this.damageDir.set(dx, dz).normalize();
      this.events.push({ type: 'damaged', source: { x: source.x, z: source.z } });
    }
    if (this.stats.health <= 0) {
      this.stats.health = 0;
      this.die();
    }
    return dealt;
  }

  heal(amount) {
    const before = this.stats.health;
    this.stats.health = Math.min(this.stats.maxHealth, this.stats.health + amount);
    const gained = this.stats.health - before;
    if (gained > 0) this.healFlash = Math.min(0.6, this.healFlash + gained / 60);
    return gained;
  }

  addArmor(amount) {
    const before = this.stats.armor;
    this.stats.armor = Math.min(this.stats.maxArmor, this.stats.armor + amount);
    return this.stats.armor - before;
  }

  die() {
    this.events.push({ type: 'died' });
    this.audio?.play('playerDeath');
  }

  respawnAt(spawn) {
    this.pos.set(spawn.x, spawn.y ?? 0, spawn.z);
    this.vel.set(0, 0, 0);
    this.stats.health = this.stats.maxHealth;
    this.stats.armor = Math.floor(this.stats.maxArmor * 0.5);
    this.stats.stamina = this.stats.maxStamina;
    this.recoilPitch = this.recoilYaw = 0;
    this.viewPunch.set(0, 0);
    for (const w of Object.values(this.weapons)) {
      if (!w.owned) continue;
      w.ammo = w.magSize;
      w.reserve = Math.min(w.reserveMax, Math.round((w.def.startReserve ?? w.magSize * 2) * this.mods.reserve));
      w.cancelReload();
    }
  }

  /** Called every frame by the director to apply regeneration effects. */
  tickEffects(dt) {
    if (this.mods.regen > 0 && this.alive && this.stats.health < this.stats.maxHealth) {
      this.heal(this.mods.regen * dt);
    }
  }
}

function yawDrift(p) {
  // subtle weapon lag behind yaw changes
  return THREE.MathUtils.clamp((p.recoilYaw || 0) * 6, -0.12, 0.12);
}
