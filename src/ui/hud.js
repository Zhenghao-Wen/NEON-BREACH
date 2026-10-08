/**
 * hud.js — DOM heads-up display.
 *
 * The HUD is deliberately DOM-based rather than canvas: text stays crisp at any
 * resolution, CSS handles the neon styling, and it costs nothing on the GPU.
 * Elements are cached and only written when their value actually changes.
 */
import { WEAPON_BY_ID } from '../gameplay/weapons.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'),
      regionName: $('region-name'),
      objective: $('objective'),
      waveNum: $('wave-num'),
      enemyCount: $('enemy-count'),
      score: $('score'),
      credits: $('credits'),
      combo: $('combo'),
      comboX: $('combo-x'),
      comboFill: $('combo-fill'),
      healthFill: $('health-fill'),
      healthNum: $('health-num'),
      armorFill: $('armor-fill'),
      armorNum: $('armor-num'),
      staminaFill: $('stamina-fill'),
      weaponName: $('weapon-name'),
      mag: $('mag'),
      reserve: $('reserve'),
      ammo: $('ammo'),
      reloadHint: $('reload-hint'),
      slots: $('weapon-slots'),
      killfeed: $('killfeed'),
      damageVignette: $('damage-vignette'),
      lowHealth: $('low-health'),
      damageIndicators: $('damage-indicators'),
      pickupToast: $('pickup-toast'),
      crosshair: $('crosshair'),
      hitmarker: $('hitmarker'),
      spreadRing: $('spread-ring'),
      centerMsg: $('center-msg'),
      minimap: $('minimap'),
      bossBar: $('boss-bar'),
      bossName: $('boss-name'),
      bossFill: $('boss-fill'),
      slowmoTag: $('slowmo-tag'),
    };
    this.ctx2d = this.el.minimap?.getContext('2d') || null;
    this._cache = {};
    this._feed = [];
    this._indicators = [];
    this._toasts = [];
    this._hitT = 0;
    this._msgT = 0;
    this._slotCache = '';
    this.minimapScale = 1;
    this.mapImage = null;
    this.buildMinimapBase = null;
  }

  show(on = true) {
    this.el.hud?.classList.toggle('hidden', !on);
    if (on && this.el.hud) this.el.hud.style.display = '';
  }

  set(key, value, formatter) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    const el = this.el[key];
    if (!el) return;
    el.textContent = formatter ? formatter(value) : value;
  }

  setBar(el, numEl, value, max) {
    if (!el) return;
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    el.style.transform = `scaleX(${frac})`;
    if (numEl) {
      const rounded = Math.ceil(value);
      if (numEl.textContent !== String(rounded)) numEl.textContent = rounded;
    }
  }

  update(state) {
    const c = this._cache;

    // region + objective
    this.set('regionName', state.region);
    this.set('objective', state.objective);
    this.set('waveNum', state.wave);
    this.set('enemyCount', state.enemiesLeft);
    this.set('score', state.score.toLocaleString('en-US'));
    this.set('credits', state.credits.toLocaleString('en-US'));

    // vitals
    this.setBar(this.el.healthFill, this.el.healthNum, state.health, state.maxHealth);
    this.setBar(this.el.armorFill, this.el.armorNum, state.armor, state.maxArmor);
    this.setBar(this.el.staminaFill, null, state.stamina, state.maxStamina);
    this.el.staminaFill?.parentElement?.parentElement?.classList.toggle('hidden', state.stamina >= state.maxStamina - 0.5);

    // health feedback
    const hpFrac = state.health / Math.max(1, state.maxHealth);
    if (this.el.healthFill) {
      this.el.healthFill.style.background = hpFrac < 0.3
        ? 'linear-gradient(90deg,#c81f2e,#ff8f8f)'
        : hpFrac < 0.6
          ? 'linear-gradient(90deg,#c9a01a,#ffe08a)'
          : 'linear-gradient(90deg,#12d98a,#8dffd0)';
    }
    if (this.el.lowHealth) this.el.lowHealth.classList.toggle('on', hpFrac < 0.32);
    if (this.el.damageVignette) {
      const dmg = Math.min(1, state.damageFlash * 1.2 + (1 - hpFrac) * 0.35);
      this.el.damageVignette.style.opacity = dmg.toFixed(2);
    }

    // weapon + ammo
    this.set('weaponName', state.weaponName);
    const mag = state.ammo;
    if (c.mag !== mag) { c.mag = mag; if (this.el.mag) this.el.mag.textContent = mag; }
    if (c.reserve !== state.reserve) {
      c.reserve = state.reserve;
      if (this.el.reserve) this.el.reserve.textContent = state.reserve;
    }
    if (this.el.ammo) {
      this.el.ammo.classList.toggle('low', mag > 0 && mag <= Math.max(1, Math.round(state.magSize * 0.25)));
      this.el.ammo.classList.toggle('empty', mag === 0);
    }
    if (this.el.reloadHint) {
      const showHint = mag === 0 || (state.reloading === false && mag <= state.magSize * 0.2 && state.reserve > 0);
      this.el.reloadHint.classList.toggle('hidden', !showHint);
    }

    // weapon slots
    const slotKey = state.loadout.join(',') + '|' + state.weaponId;
    if (this._slotCache !== slotKey) {
      this._slotCache = slotKey;
      if (this.el.slots) {
        this.el.slots.innerHTML = '';
        for (let s = 1; s <= 7; s++) {
          const id = state.loadout.find((w) => WEAPON_BY_ID[w].slot === s);
          const div = document.createElement('div');
          div.className = 'wslot' + (id === state.weaponId ? ' active' : '') + (id ? '' : ' locked');
          div.innerHTML = `<span class="k">${s}</span>${id ? WEAPON_BY_ID[id].short : '—'}`;
          this.el.slots.appendChild(div);
        }
      }
    }

    // combo
    if (this.el.combo) {
      const show = state.combo > 1.05;
      this.el.combo.classList.toggle('hidden', !show);
      if (show) {
        this.el.comboX.textContent = 'x' + state.combo.toFixed(2);
        this.el.comboFill.style.width = Math.min(100, (state.comboT / state.comboMaxT) * 100) + '%';
      }
    }

    // crosshair spread ring
    if (this.el.spreadRing) {
      const size = 42 + state.spread * 1400;
      this.el.spreadRing.style.width = size + 'px';
      this.el.spreadRing.style.height = size + 'px';
      this.el.spreadRing.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
      this.el.spreadRing.style.opacity = state.ads > 0.5 ? '0.15' : '0.5';
    }

    // slow-motion tag
    this.el.slowmoTag?.classList.toggle('hidden', !state.slowmo);

    // boss bar
    if (this.el.bossBar) {
      const show = !!state.boss;
      this.el.bossBar.classList.toggle('hidden', !show);
      if (show) {
        if (c.bossName !== state.boss.name) {
          c.bossName = state.boss.name;
          this.el.bossName.textContent = state.boss.name;
        }
        this.el.bossFill.style.transform = `scaleX(${Math.max(0, state.boss.hp / state.boss.maxHp)})`;
      }
    }

    // hitmarker timer
    if (this._hitT > 0) {
      this._hitT -= state.dt;
      if (this._hitT <= 0) {
        this.el.hitmarker?.classList.remove('show', 'kill');
      }
    }
    if (this._msgT > 0) {
      this._msgT -= state.dt;
      if (this._msgT <= 0) this.el.centerMsg?.classList.remove('show');
    }

    // transient lists
    this.updateFeed(state.dt);
    this.updateIndicators(state.dt);
    this.updateToasts(state.dt);
    this.drawMinimap(state);
  }

  setHostile(on) {
    this.el.crosshair?.classList.toggle('hostile', on);
  }

  hitmarker(kill = false) {
    const el = this.el.hitmarker;
    if (!el) return;
    el.classList.add('show');
    el.classList.toggle('kill', kill);
    this._hitT = kill ? 0.22 : 0.12;
  }

  addKill(text, opts = {}) {
    const div = document.createElement('div');
    div.className = 'kf' + (opts.headshot ? ' head' : '');
    div.innerHTML = text;
    this.el.killfeed?.appendChild(div);
    this._feed.push({ el: div, t: 4.5 });
    while (this._feed.length > 6) {
      const old = this._feed.shift();
      old.el.remove();
    }
  }

  updateFeed(dt) {
    for (let i = this._feed.length - 1; i >= 0; i--) {
      const f = this._feed[i];
      f.t -= dt;
      if (f.t <= 0) { f.el.remove(); this._feed.splice(i, 1); }
      else if (f.t < 0.8) f.el.style.opacity = (f.t / 0.8).toFixed(2);
    }
  }

  /** Directional damage indicator: angle is in world space relative to the player. */
  damageFrom(angleRad, angleRelative) {
    const wrap = this.el.damageIndicators;
    if (!wrap) return;
    const div = document.createElement('div');
    div.className = 'dmg-ind';
    const deg = (angleRelative * 180) / Math.PI;
    div.style.transform = `rotate(${deg}deg)`;
    div.innerHTML = '<i></i>';
    wrap.appendChild(div);
    requestAnimationFrame(() => { div.style.transition = 'opacity .15s'; div.style.opacity = '0.95'; });
    this._indicators.push({ el: div, t: 1.1 });
    while (this._indicators.length > 8) {
      const old = this._indicators.shift();
      old.el.remove();
    }
  }

  updateIndicators(dt) {
    for (let i = this._indicators.length - 1; i >= 0; i--) {
      const d = this._indicators[i];
      d.t -= dt;
      if (d.t <= 0) { d.el.remove(); this._indicators.splice(i, 1); }
      else if (d.t < 0.5) d.el.style.opacity = (d.t / 0.5).toFixed(2);
    }
  }

  toast(text, kind = 'good') {
    if (!text) return;
    const div = document.createElement('div');
    div.className = 'toast ' + kind;
    div.textContent = text;
    this.el.pickupToast?.appendChild(div);
    this._toasts.push({ el: div, t: 2.2 });
    while (this._toasts.length > 5) {
      const old = this._toasts.shift();
      old.el.remove();
    }
  }

  updateToasts(dt) {
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.t -= dt;
      if (t.t <= 0) { t.el.remove(); this._toasts.splice(i, 1); }
      else if (t.t < 0.6) t.el.style.opacity = (t.t / 0.6).toFixed(2);
    }
  }

  /** Big centred announcement. */
  announce(text, sub = '', duration = 2.6) {
    const el = this.el.centerMsg;
    if (!el) return;
    el.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
    el.classList.add('show');
    this._msgT = duration;
  }

  // -------------------------------------------------------------- minimap
  buildBase(level, size) {
    const c = document.createElement('canvas');
    c.width = level.navW;
    c.height = level.navH;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(level.navW, level.navH);
    for (let y = 0; y < level.navH; y++) {
      for (let x = 0; x < level.navW; x++) {
        const o = (y * level.navW + x) * 4;
        const solid = level.isSolid(x, y);
        const walk = level.nav[y * level.navW + x];
        if (!solid && walk) {
          img.data[o] = 30; img.data[o + 1] = 60; img.data[o + 2] = 78; img.data[o + 3] = 255;
        } else if (!solid) {
          img.data[o] = 22; img.data[o + 1] = 32; img.data[o + 2] = 42; img.data[o + 3] = 255;
        } else {
          img.data[o] = 8; img.data[o + 1] = 14; img.data[o + 2] = 20; img.data[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  drawMinimap(state) {
    const ctx = this.ctx2d;
    const level = state.level;
    if (!ctx || !level) return;
    if (!this._mapBase) this._mapBase = this.buildBase(level, 220);

    const w = this.el.minimap.width;
    const h = this.el.minimap.height;
    const scale = Math.min(w / level.navW, h / level.navH) * 0.92;
    const ox = (w - level.navW * scale) / 2;
    const oy = (h - level.navH * scale) / 2;

    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this._mapBase, ox, oy, level.navW * scale, level.navH * scale);
    ctx.globalAlpha = 1;

    const toMap = (x, z) => [
      ox + ((x - level.origin.x) / level.cellSize) * scale,
      oy + ((z - level.origin.y) / level.cellSize) * scale,
    ];

    // enemies
    for (const e of state.enemies || []) {
      if (!e.alive) continue;
      const [mx, my] = toMap(e.pos.x, e.pos.z);
      ctx.fillStyle = e.def?.boss ? '#ffcc33' : '#ff4d5e';
      const r = e.def?.boss ? 4 : 2.4;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // pickups
    for (const p of state.pickups || []) {
      const [mx, my] = toMap(p.pos.x, p.pos.z);
      ctx.fillStyle = '#' + p.def.color.toString(16).padStart(6, '0');
      ctx.fillRect(mx - 1.5, my - 1.5, 3, 3);
    }
    // player
    const [px, py] = toMap(state.playerPos.x, state.playerPos.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-state.playerYaw);
    ctx.fillStyle = '#4fe9ff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // view cone
    ctx.strokeStyle = 'rgba(79,233,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, 22, -state.playerYaw - Math.PI / 2 - 0.5, -state.playerYaw - Math.PI / 2 + 0.5);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
}
