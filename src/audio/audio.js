/**
 * audio.js — fully procedural sound effects.
 *
 * No audio files exist in this project. Gunfire, impacts, footsteps, creature
 * vocalisations and the ambient score are all synthesised with WebAudio
 * oscillators, filtered noise and envelopes, then placed in 3D using the
 * listener's position and facing.
 */
import * as THREE from 'three';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.volumes = { master: 0.85, sfx: 0.9, music: 0.42 };
    this.listenerPos = new THREE.Vector3();
    this.listenerFwd = new THREE.Vector3(0, 0, -1);
    this.listenerRight = new THREE.Vector3(1, 0, 0);
    this.noise = {};
    this.lastPlayed = {};
    this.ambient = null;
    this.musicTimer = 0;
    this.intensity = 0;
    this._budget = 0;
  }

  init() {
    if (this.ctx) return this.ready;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return false;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.master.connect(ctx.destination);

    // a gentle limiter keeps explosions from clipping
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(this.master);
    this.comp = comp;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;
    this.sfxBus.connect(comp);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.volumes.music;
    this.musicBus.connect(comp);

    this._buildNoise();
    this.ready = true;
    return true;
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolumes({ master, sfx, music }) {
    if (master !== undefined) this.volumes.master = master;
    if (sfx !== undefined) this.volumes.sfx = sfx;
    if (music !== undefined) this.volumes.music = music;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.volumes.music, t, 0.05);
  }

  _buildNoise() {
    const ctx = this.ctx;
    const mk = (seconds, kind) => {
      const len = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'brown') {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.2;
        } else if (kind === 'pink') {
          last = 0.98 * last + 0.02 * w;
          d[i] = (w * 0.4 + last * 2.2);
        } else {
          d[i] = w;
        }
      }
      return buf;
    };
    this.noise.white = mk(2, 'white');
    this.noise.pink = mk(2, 'pink');
    this.noise.brown = mk(3, 'brown');
  }

  // ---------------------------------------------------------------- helpers
  _noiseSource(kind = 'white') {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise[kind] || this.noise.white;
    s.loop = true;
    return s;
  }

  _env(gain, t0, attack, decay, peak, sustain = 0) {
    const g = gain.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.exponentialRampToValueAtTime(Math.max(0.0001, sustain || 0.0001), t0 + attack + decay);
  }

  /** Spatial placement: returns a gain node + panner for a world position. */
  _spatial(pos, baseGain = 1, maxDist = 60) {
    const ctx = this.ctx;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const gain = ctx.createGain();
    let vol = baseGain;
    if (pos) {
      const dx = pos.x - this.listenerPos.x;
      const dy = (pos.y ?? this.listenerPos.y) - this.listenerPos.y;
      const dz = pos.z - this.listenerPos.z;
      const dist = Math.hypot(dx, dy, dz);
      vol = baseGain * Math.max(0, 1 - dist / maxDist) ** 1.6;
      if (panner) {
        const right = (dx * this.listenerRight.x + dz * this.listenerRight.z) / Math.max(0.6, dist);
        panner.pan.value = Math.max(-1, Math.min(1, right * 0.85));
      }
    }
    gain.gain.value = vol;
    if (panner) {
      gain.connect(panner);
      panner.connect(this.sfxBus);
    } else {
      gain.connect(this.sfxBus);
    }
    return { gain, vol, panner };
  }

  _throttle(name, ms) {
    const now = performance.now();
    if (this.lastPlayed[name] && now - this.lastPlayed[name] < ms) return false;
    this.lastPlayed[name] = now;
    return true;
  }

  // ------------------------------------------------------------------ voices
  play(name, opts = {}) {
    if (!this.ready) return;
    try {
      this._play(name, opts);
    } catch (e) {
      // never let audio break the game loop
      if (!this._warned) { console.warn('[audio]', e); this._warned = true; }
    }
  }

  _play(name, opts) {
    const ctx = this.ctx;
    const t = ctx.currentTime + (opts.delay || 0);
    const pos = opts.pos || null;
    const vol = opts.volume ?? 1;

    switch (name) {
      case 'shot': return this._gunshot(t, opts.weapon || 'rifle', pos, vol);
      case 'enemyShot': return this._enemyShot(t, pos, vol);
      case 'impact': return this._impact(t, opts.surface || 'concrete', pos, vol);
      case 'explosion': return this._explosion(t, pos, vol);
      case 'reload': return this._reload(t, opts.weapon || 'rifle', pos, vol);
      case 'reloadEnd': return this._click(t + 0.02, 1800, 0.10, pos, 0.5 * vol);
      case 'dryfire': return this._click(t, 2600, 0.05, pos, 0.35 * vol);
      case 'footstep': return this._footstep(t, opts.surface || '', pos, (opts.force ?? 1) * vol);
      case 'land': return this._land(t, opts.force ?? 0.5, pos, vol);
      case 'jump': return this._whoosh(t, pos, 0.25 * vol);
      case 'dash': return this._whoosh(t, pos, 0.7 * vol, 260, 900);
      case 'hurt': return this._hurt(t, opts.force ?? 0.5, vol);
      case 'playerDeath': return this._playerDeath(t, vol);
      case 'melee': return this._melee(t, pos, vol);
      case 'throw': return this._whoosh(t, pos, 0.35 * vol, 500, 1600);
      case 'hitmarker': return this._click(t, 3000, 0.045, null, 0.35 * vol);
      case 'headshot': return this._headshot(t, vol);
      case 'kill': return this._kill(t, pos, vol);
      case 'pickup': return this._pickup(t, vol);
      case 'credit': return this._credit(t, vol);
      case 'buy': return this._buy(t, vol);
      case 'denied': return this._denied(t, vol);
      case 'waveStart': return this._waveStart(t, vol);
      case 'waveClear': return this._waveClear(t, vol);
      case 'uiClick': return this._click(t, 1400, 0.03, null, 0.3 * vol);
      case 'uiHover': return this._click(t, 2000, 0.02, null, 0.16 * vol);
      case 'enemyAlert': return this._enemyAlert(t, pos, vol);
      case 'enemyGrowl': return this._enemyGrowl(t, pos, vol);
      case 'enemyDeath': return this._enemyDeath(t, pos, vol);
      case 'bossSpawn': return this._bossSpawn(t, vol);
      case 'damageAlarm': return this._damageAlarm(t, vol);
      case 'teleport': return this._teleport(t, pos, vol);
      case 'grenadeBounce': return this._click(t, 900, 0.05, pos, 0.3 * vol);
      default: return undefined;
    }
  }

  // ------------------------------------------------------------- generators
  _gunshot(t, id, pos, vol) {
    const { gain } = this._spatial(pos, vol, 90);
    const cfg = {
      rifle: { f: 950, q: 1.1, dec: 0.16, sub: 140, subDec: 0.10, noise: 0.85, tone: 0.55 },
      smg: { f: 1250, q: 1.4, dec: 0.10, sub: 180, subDec: 0.06, noise: 0.7, tone: 0.4 },
      shotgun: { f: 480, q: 0.8, dec: 0.34, sub: 90, subDec: 0.26, noise: 1.0, tone: 0.75 },
      magnum: { f: 620, q: 0.9, dec: 0.28, sub: 105, subDec: 0.2, noise: 0.95, tone: 0.7 },
      rail: { f: 2100, q: 3.0, dec: 0.3, sub: 70, subDec: 0.3, noise: 0.55, tone: 0.9 },
      plasma: { f: 1600, q: 5.0, dec: 0.22, sub: 120, subDec: 0.16, noise: 0.4, tone: 0.95 },
      minigun: { f: 780, q: 1.2, dec: 0.09, sub: 150, subDec: 0.06, noise: 0.8, tone: 0.45 },
    }[id] || { f: 950, q: 1.1, dec: 0.16, sub: 140, subDec: 0.1, noise: 0.85, tone: 0.55 };

    // crack: filtered noise burst
    const n = this._noiseSource('white');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(cfg.f * 1.7, t);
    bp.frequency.exponentialRampToValueAtTime(cfg.f * 0.5, t + cfg.dec);
    bp.Q.value = cfg.q;
    const ng = this.ctx.createGain();
    this._env(ng, t, 0.002, cfg.dec, cfg.noise);
    n.connect(bp); bp.connect(ng); ng.connect(gain);
    n.start(t); n.stop(t + cfg.dec + 0.06);

    // body: low sine thump
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(cfg.sub * 2.2, t);
    osc.frequency.exponentialRampToValueAtTime(cfg.sub, t + cfg.subDec);
    const og = this.ctx.createGain();
    this._env(og, t, 0.002, cfg.subDec, cfg.tone * 0.9);
    osc.connect(og); og.connect(gain);
    osc.start(t); osc.stop(t + cfg.subDec + 0.05);

    // energy layer for the exotic weapons
    if (id === 'rail' || id === 'plasma') {
      const o2 = this.ctx.createOscillator();
      o2.type = id === 'rail' ? 'sawtooth' : 'triangle';
      o2.frequency.setValueAtTime(id === 'rail' ? 3200 : 900, t);
      o2.frequency.exponentialRampToValueAtTime(id === 'rail' ? 220 : 260, t + 0.24);
      const g2 = this.ctx.createGain();
      this._env(g2, t, 0.004, 0.26, cfg.tone * 0.35);
      o2.connect(g2); g2.connect(gain);
      o2.start(t); o2.stop(t + 0.3);
    }
  }

  _enemyShot(t, pos, vol) {
    const { gain } = this._spatial(pos, vol, 60);
    const n = this._noiseSource('pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1500, t);
    bp.frequency.exponentialRampToValueAtTime(400, t + 0.18);
    bp.Q.value = 2.2;
    const g = this.ctx.createGain();
    this._env(g, t, 0.002, 0.18, 0.5);
    n.connect(bp); bp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.25);
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.16);
    const og = this.ctx.createGain();
    this._env(og, t, 0.002, 0.16, 0.3);
    o.connect(og); og.connect(gain);
    o.start(t); o.stop(t + 0.2);
  }

  _impact(t, surface, pos, vol) {
    const { gain } = this._spatial(pos, vol * 0.75, 45);
    const bright = { concrete: 1800, metal: 3200, tile: 2600, flesh: 500, default: 1600 }[surface] ?? 1600;
    const n = this._noiseSource('white');
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = bright * 0.35;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'peaking';
    bp.frequency.value = bright;
    bp.gain.value = 6;
    const g = this.ctx.createGain();
    this._env(g, t, 0.001, surface === 'flesh' ? 0.12 : 0.07, 0.42);
    n.connect(hp); hp.connect(bp); bp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.16);
  }

  _explosion(t, pos, vol) {
    const { gain } = this._spatial(pos, vol, 120);
    const n = this._noiseSource('brown');
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.9);
    const g = this.ctx.createGain();
    this._env(g, t, 0.006, 1.0, 1.0);
    n.connect(lp); lp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 1.2);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.7);
    const og = this.ctx.createGain();
    this._env(og, t, 0.004, 0.75, 0.85);
    o.connect(og); og.connect(gain);
    o.start(t); o.stop(t + 0.9);
  }

  _reload(t, id, pos, vol) {
    const heavy = id === 'shotgun' || id === 'minigun' || id === 'rail';
    const clicks = [
      { d: 0.02, f: heavy ? 900 : 1500, a: 0.35 },
      { d: 0.22, f: heavy ? 500 : 900, a: 0.30 },
      { d: heavy ? 0.9 : 0.55, f: 1100, a: 0.28 },
      { d: heavy ? 1.5 : 0.95, f: 1700, a: 0.34 },
      { d: heavy ? 2.0 : 1.25, f: 2300, a: 0.30 },
    ];
    for (const c of clicks) this._click(t + c.d, c.f, 0.045, pos, c.a * vol);
    // magazine handling noise
    const n = this._noiseSource('pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 1.4;
    const { gain } = this._spatial(pos, vol * 0.3, 20);
    const g = this.ctx.createGain();
    this._env(g, t + 0.1, 0.05, 0.3, 0.4);
    n.connect(bp); bp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.6);
  }

  _click(t, freq, amp, pos, scale = 1) {
    const { gain } = this._spatial(pos, scale, 30);
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.35), t + 0.03);
    const g = this.ctx.createGain();
    this._env(g, t, 0.0008, 0.035, amp);
    o.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.06);
    // tiny noise transient
    const n = this._noiseSource('white');
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2000;
    const ng = this.ctx.createGain();
    this._env(ng, t, 0.0006, 0.02, amp * 0.5);
    n.connect(hp); hp.connect(ng); ng.connect(gain);
    n.start(t); n.stop(t + 0.04);
  }

  _footstep(t, surface, pos, vol) {
    if (!this._throttle('step', 90)) return;
    const bright = /TUNNEL|OBSERV|VAULT|HANGAR/i.test(surface) ? 2400 : /LAB|ATRIUM|SERVER|MAP/i.test(surface) ? 3200 : 1500;
    const { gain } = this._spatial(pos, vol * 0.5, 26);
    const n = this._noiseSource('pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(bright, t);
    bp.frequency.exponentialRampToValueAtTime(bright * 0.4, t + 0.07);
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    this._env(g, t, 0.002, 0.08, 0.34);
    n.connect(bp); bp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.14);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.08);
    const og = this.ctx.createGain();
    this._env(og, t, 0.002, 0.07, 0.22);
    o.connect(og); og.connect(gain);
    o.start(t); o.stop(t + 0.12);
  }

  _land(t, force, pos, vol) {
    const { gain } = this._spatial(pos, vol * 0.7, 30);
    const n = this._noiseSource('brown');
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const g = this.ctx.createGain();
    this._env(g, t, 0.003, 0.2 * (0.5 + force), 0.5 * (0.4 + force));
    n.connect(lp); lp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.4);
  }

  _whoosh(t, pos, vol, f0 = 700, f1 = 260) {
    const { gain } = this._spatial(pos, vol, 22);
    const n = this._noiseSource('pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + 0.2);
    bp.Q.value = 1.2;
    const g = this.ctx.createGain();
    this._env(g, t, 0.01, 0.2, 0.4);
    n.connect(bp); bp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.3);
  }

  _hurt(t, force, vol) {
    const { gain } = this._spatial(null, vol, 10);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.22);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = this.ctx.createGain();
    this._env(g, t, 0.006, 0.24, 0.30 * (0.5 + force));
    o.connect(lp); lp.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.3);
    const n = this._noiseSource('pink');
    const ng = this.ctx.createGain();
    this._env(ng, t, 0.004, 0.18, 0.18 * (0.4 + force));
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    n.connect(bp); bp.connect(ng); ng.connect(gain);
    n.start(t); n.stop(t + 0.26);
  }

  _playerDeath(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 1.4);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1200, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 1.2);
    const g = this.ctx.createGain();
    this._env(g, t, 0.01, 1.5, 0.5, 0.0001);
    o.connect(lp); lp.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 1.6);
  }

  _melee(t, pos, vol) {
    const { gain } = this._spatial(pos, vol, 20);
    const n = this._noiseSource('pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(300, t + 0.12);
    bp.Q.value = 1.6;
    const g = this.ctx.createGain();
    this._env(g, t, 0.001, 0.14, 0.5);
    n.connect(bp); bp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.2);
  }

  _headshot(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1800, t);
    o.frequency.exponentialRampToValueAtTime(2600, t + 0.06);
    const g = this.ctx.createGain();
    this._env(g, t, 0.001, 0.08, 0.30);
    o.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.12);
  }

  _kill(t, pos, vol) {
    const { gain } = this._spatial(pos, vol, 40);
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(700, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.18);
    const g = this.ctx.createGain();
    this._env(g, t, 0.002, 0.2, 0.22);
    o.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.26);
    const n = this._noiseSource('pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    const ng = this.ctx.createGain();
    this._env(ng, t, 0.002, 0.14, 0.18);
    n.connect(bp); bp.connect(ng); ng.connect(gain);
    n.start(t); n.stop(t + 0.2);
  }

  _pickup(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    const notes = [660, 990];
    notes.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this._env(g, t + i * 0.07, 0.005, 0.12, 0.22);
      o.connect(g); g.connect(gain);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.18);
    });
  }

  _credit(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    [880, 1320, 1760].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this._env(g, t + i * 0.045, 0.004, 0.1, 0.14);
      o.connect(g); g.connect(gain);
      o.start(t + i * 0.045); o.stop(t + i * 0.045 + 0.16);
    });
  }

  _buy(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    [440, 660, 880, 1320].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this._env(g, t + i * 0.06, 0.005, 0.16, 0.18);
      o.connect(g); g.connect(gain);
      o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.24);
    });
  }

  _denied(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    [220, 180].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this._env(g, t + i * 0.1, 0.004, 0.12, 0.2);
      o.connect(g); g.connect(gain);
      o.start(t + i * 0.1); o.stop(t + i * 0.1 + 0.18);
    });
  }

  _waveStart(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(220, t + 1.1);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 1.0);
    const g = this.ctx.createGain();
    this._env(g, t, 0.2, 1.1, 0.4);
    o.connect(lp); lp.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 1.4);
  }

  _waveClear(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    [523, 659, 784, 1046].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this._env(g, t + i * 0.11, 0.01, 0.4, 0.24);
      o.connect(g); g.connect(gain);
      o.start(t + i * 0.11); o.stop(t + i * 0.11 + 0.5);
    });
  }

  _enemyAlert(t, pos, vol) {
    const { gain } = this._spatial(pos, vol, 45);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(520, t + 0.14);
    const g = this.ctx.createGain();
    this._env(g, t, 0.01, 0.3, 0.24);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    o.connect(lp); lp.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.4);
  }

  _enemyGrowl(t, pos, vol) {
    if (!this._throttle('growl', 260)) return;
    const { gain } = this._spatial(pos, vol * 0.8, 35);
    const n = this._noiseSource('brown');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(300 + Math.random() * 260, t);
    bp.Q.value = 3.5;
    bp.frequency.exponentialRampToValueAtTime(150, t + 0.5);
    const g = this.ctx.createGain();
    this._env(g, t, 0.06, 0.5, 0.4);
    n.connect(bp); bp.connect(g); g.connect(gain);
    n.start(t); n.stop(t + 0.7);
  }

  _enemyDeath(t, pos, vol) {
    const { gain } = this._spatial(pos, vol, 45);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.5);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    const g = this.ctx.createGain();
    this._env(g, t, 0.005, 0.55, 0.35);
    o.connect(lp); lp.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.7);
    const n = this._noiseSource('pink');
    const ng = this.ctx.createGain();
    this._env(ng, t, 0.004, 0.3, 0.22);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 600;
    n.connect(bp); bp.connect(ng); ng.connect(gain);
    n.start(t); n.stop(t + 0.4);
  }

  _bossSpawn(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(40, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 2.0);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(1800, t + 1.8);
    const g = this.ctx.createGain();
    this._env(g, t, 0.4, 2.0, 0.55);
    o.connect(lp); lp.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 2.6);
    o.onended = null;
  }

  _damageAlarm(t, vol) {
    const { gain } = this._spatial(null, vol, 10);
    [880, 660, 880].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this._env(g, t + i * 0.13, 0.01, 0.12, 0.16);
      o.connect(g); g.connect(gain);
      o.start(t + i * 0.13); o.stop(t + i * 0.13 + 0.18);
    });
  }

  _teleport(t, pos, vol) {
    const { gain } = this._spatial(pos, vol, 40);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
    const g = this.ctx.createGain();
    this._env(g, t, 0.02, 0.35, 0.3);
    o.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.5);
  }

  // ------------------------------------------------------------------ music
  startAmbient() {
    if (!this.ready || this.ambient) return;
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.0;
    bus.connect(this.musicBus);
    bus.gain.setTargetAtTime(0.36, ctx.currentTime, 3.0);

    // layered drone: root + fifth + octave, slowly detuned
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.18;
    droneGain.connect(bus);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.7;
    lp.connect(droneGain);

    const oscs = [];
    const roots = [55, 82.5, 110, 164.81];
    roots.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.5 : 0.18 / (i + 1);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + i * 0.017;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.5 + i * 0.4;
      lfo.connect(lfoGain);
      lfoGain.connect(o.detune);
      lfo.start();
      o.connect(g); g.connect(lp);
      o.start();
      oscs.push({ o, lfo });
    });

    // sparse metallic percussion
    const noiseBuf = this.noise.pink;
    const pulse = () => {
      if (!this.ambient) return;
      const t = ctx.currentTime;
      const n = ctx.createBufferSource();
      n.buffer = noiseBuf;
      n.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1600 + Math.random() * 2600;
      bp.Q.value = 6;
      const g = ctx.createGain();
      this._env(g, t, 0.002, 0.16, 0.06 + this.intensity * 0.09);
      n.connect(bp); bp.connect(g); g.connect(bus);
      n.start(t); n.stop(t + 0.3);
      this.ambient.timer = setTimeout(pulse, 420 + Math.random() * 900 - this.intensity * 200);
    };

    this.ambient = { bus, droneGain, lp, oscs, timer: null, started: true };
    setTimeout(pulse, 800);
  }

  stopAmbient() {
    if (!this.ambient) return;
    clearTimeout(this.ambient.timer);
    const t = this.ctx.currentTime;
    this.ambient.bus.gain.setTargetAtTime(0, t, 0.6);
    const amb = this.ambient;
    setTimeout(() => {
      for (const { o, lfo } of amb.oscs) { try { o.stop(); lfo.stop(); } catch { /* already stopped */ } }
      try { amb.bus.disconnect(); } catch { /* ignore */ }
    }, 2500);
    this.ambient = null;
  }

  setIntensity(v) {
    this.intensity = Math.max(0, Math.min(1, v));
    if (this.ambient) {
      this.ambient.lp.frequency.setTargetAtTime(360 + this.intensity * 900, this.ctx.currentTime, 1.4);
    }
  }

  update(dt, camera) {
    if (!this.ready) return;
    this.listenerPos.copy(camera.position);
    camera.getWorldDirection(this.listenerFwd);
    this.listenerRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  }
}
