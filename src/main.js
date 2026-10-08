/**
 * main.js — NEON BREACH bootstrap and frame loop.
 *
 * Boot sequence: renderer -> procedural sky/IBL -> procedural textures and
 * level -> physics -> gameplay systems. Everything is generated at runtime, so
 * the game runs completely offline with no asset downloads.
 */
import * as THREE from 'three';
import { SkyDome, buildEnvironment } from './gfx/sky.js';
import { Pipeline } from './gfx/post.js';
import { FX } from './gfx/fx.js';
import { Level } from './level.js';
import { CollisionWorld } from './core/physics.js';
import { Input } from './core/input.js';
import { AudioEngine } from './audio/audio.js';
import { Player } from './gameplay/player.js';
import { Director } from './gameplay/director.js';
import { buildViewModel } from './gameplay/weapons.js';
import { HUD } from './ui/hud.js';
import { UIManager, Settings } from './ui/ui.js';

const canvas = document.getElementById('gl');

export const App = {
  three: THREE,
  renderer: null,
  scene: null,
  camera: null,
  sky: null,
  level: null,
  world: null,
  input: null,
  pipeline: null,
  fx: null,
  audio: null,
  player: null,
  director: null,
  hud: null,
  ui: null,
  settings: null,
  clock: null,
  stats: { fps: 0, frames: 0, acc: 0, drawCalls: 0, tris: 0, ms: 0 },
  ready: false,
  playing: false,
  errors: [],
  version: '1.0.0',
};

window.__NB = App;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setLoad(pct, text, sub) {
  const f = document.getElementById('load-fill');
  if (f) f.style.width = Math.round(pct * 100) + '%';
  if (text) { const t = document.getElementById('load-text'); if (t) t.textContent = text; }
  if (sub) { const s = document.getElementById('load-sub'); if (s) s.textContent = sub; }
}

function bindEvents() {
  const { player, director } = App;

  player.events.length = 0;
  App.drainPlayerEvents = () => {
    for (const ev of player.events) {
      switch (ev.type) {
        case 'damaged': {
          // directional indicator: rotate the arrow into screen space
          const src = ev.source;
          const worldAngle = Math.atan2(src.x - player.pos.x, src.z - player.pos.z);
          const rel = worldAngle - player.yaw;
          App.hud?.damageFrom(worldAngle, -rel);
          break;
        }
        case 'grenade':
          App.hud?.toast(`手雷 × ${player.grenades}`, 'warn');
          break;
        case 'died':
          App.hud?.announce('生命体征消失', 'CRITICAL FAILURE', 3);
          break;
        default: break;
      }
    }
    player.events.length = 0;
  };
}

async function boot() {
  const t0 = performance.now();

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = false;
  renderer.info.autoReset = false;
  App.renderer = renderer;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070c14, 0.018);
  App.scene = scene;

  const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 700);
  camera.rotation.order = 'YXZ';
  App.camera = camera;
  scene.add(camera);

  setLoad(0.05, '初始化渲染管线…', 'WEBGL2 PIPELINE');
  await nextFrame();

  // ------------------------------------------------------------ sky + light
  App.sky = new SkyDome(scene, renderer, {
    horizon: 0x141f38, zenith: 0x03050c, glow: 0x1d7a99, stars: 1,
  });

  setLoad(0.12, '烘焙环境光照 / IBL…', 'PMREM ENVIRONMENT PROBE');
  await nextFrame();
  scene.environment = buildEnvironment(renderer);
  scene.environmentIntensity = 0.6;

  // ------------------------------------------------------------------ audio
  App.audio = new AudioEngine();

  // ------------------------------------------------- settings (needs audio)
  App.settings = new Settings((key, value, all) => applySetting(key, value, all));
  const S = App.settings.values;
  camera.fov = S.fov;
  camera.updateProjectionMatrix();

  // ----------------------------------------------------- textures + level
  setLoad(0.20, '合成程序化 PBR 贴图…', 'PROCEDURAL TEXTURE SYNTHESIS');
  await nextFrame();
  const tLevel = performance.now();
  const level = new Level();
  level.build('high');
  App.level = level;
  scene.add(level.group);
  setLoad(0.74, '构建关卡几何…', `${level.colliders.length} COLLIDERS / ${level.spawnPoints.length} SPAWN TILES`);
  await nextFrame();

  const world = new CollisionWorld();
  world.addFromLevel(level.colliders);
  App.world = world;

  setLoad(0.80, '布置特效与音效…', 'VFX + PROCEDURAL AUDIO');
  await nextFrame();

  const overlay = document.getElementById('app');
  App.fx = new FX(scene, overlay);
  App.hud = new HUD();
  App.input = new Input(canvas);

  // ----------------------------------------------------------- gameplay
  const player = new Player({
    camera, world, input: App.input, audio: App.audio, level,
    viewmodels: (id) => buildViewModel(id),
  });
  App.player = player;

  const director = new Director({
    scene, camera, world, level, player,
    hud: App.hud, fx: App.fx, audio: App.audio, input: App.input,
    settings: S, ui: null,
  });
  App.director = director;
  player.director = director;

  const ui = new UIManager({
    settings: App.settings,
    audio: App.audio,
    onStart: () => startRun(),
    onResume: () => requestLock(),
    onRestart: () => startRun(),
    onQuit: () => quitToMenu(),
    onBuy: (item) => director.buy(item),
    onNextWave: () => {
      director.intermissionT = 0;
      if (director.state === 'intermission') director.startWave(director.wave + 1);
    },
    onEndless: () => {
      director.endless = true;
      director.state = 'intermission';
      director.intermissionT = 12;
      director.ui.hideAll();
      requestLock();
    },
  });
  App.ui = ui;
  director.ui = ui;

  // ------------------------------------------------------------- pipeline
  setLoad(0.90, '编译着色器…', 'SHADER COMPILATION');
  await nextFrame();

  App.pipeline = new Pipeline(renderer, scene, camera, {
    bloomStrength: 0.72, bloomRadius: 0.62, bloomThreshold: 0.74,
  });
  App.pipeline.applyQuality(qualityPreset(S.quality));

  App.clock = new THREE.Clock();
  App.input.sensitivity = 0.0022 * (S.sensitivity / 0.55);
  App.input.invertY = S.invertY;
  App.audio.setVolumes({ master: S.master, sfx: S.sfx, music: S.music });

  // spawn the camera somewhere sensible behind the menu
  const c = level.tileToWorld(18, 10);
  const spot = level.nearestWalkable(c.x + 5, c.y + 4) || { x: c.x, z: c.y };
  player.respawnAt({ x: spot.x, y: 0, z: spot.z });
  player.yaw = Math.atan2(c.x - spot.x, c.y - spot.z);
  player.update(0.016);

  App.hud.buildBase?.(level);
  bindEvents();

  window.addEventListener('resize', onResize);
  canvas.addEventListener('click', () => {
    if (!App.ui.isBlocking()) requestLock();
  });
  App.input.onLockChange = (locked) => {
    if (locked) {
      App.ui.setStartPrompt(false);
    } else if (App.playing && !App.ui.isBlocking()) {
      App.ui.setStartPrompt(true);
    }
  };
  document.addEventListener('pointerlockerror', () => {
    App.hud?.toast('指针锁定被拒绝，请点击画面重试', 'warn');
  });

  renderer.compile(scene, camera);

  setLoad(1, '准备完毕', `BUILD ${Math.round(performance.now() - t0)}MS`);
  await wait(180);
  document.getElementById('loading')?.classList.add('hidden');
  App.hud.show(true);
  App.ui.show('menu');

  App.ready = true;
  App.bootMs = performance.now() - t0;
  loop();
  return App;
}

// ---------------------------------------------------------------------------
// settings -> live systems
// ---------------------------------------------------------------------------
function qualityPreset(name) {
  switch (name) {
    case 'low':
      return {
        bloom: false, grade: true, aberration: 0.3, grain: 0.02, scan: 0,
        pixel: 0, scale: 0.75, vignette: 0.6, saturation: 1.05,
        lift: [0.01, 0.014, 0.024], gain: [1.0, 0.99, 1.02],
      };
    case 'medium':
      return {
        bloom: true, grade: true, aberration: 0.6, grain: 0.04, scan: 0.2,
        pixel: 0, scale: 1, vignette: 0.78, saturation: 1.1,
        lift: [0.012, 0.016, 0.028], gain: [1.02, 1.0, 1.05],
      };
    default:
      return {
        bloom: true, grade: true, aberration: 0.9, grain: 0.055, scan: 0.35,
        pixel: 0, scale: 1, vignette: 0.85, saturation: 1.14,
        lift: [0.012, 0.018, 0.032], gain: [1.03, 1.0, 1.06],
      };
  }
}

function applySetting(key, value, all) {
  const A = App;
  switch (key) {
    case 'sensitivity':
      if (A.input) A.input.sensitivity = 0.0022 * (value / 0.55);
      break;
    case 'invertY':
      if (A.input) A.input.invertY = value;
      break;
    case 'fov':
      A.settings.values.fov = value;
      break;
    case 'master': case 'sfx': case 'music':
      A.audio?.setVolumes({ master: all.master, sfx: all.sfx, music: all.music });
      break;
    case 'quality': {
      const preset = qualityPreset(value);
      A.pipeline?.applyQuality(preset);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, preset.scale >= 1 ? 2 : 1) * preset.scale;
      A.renderer?.setPixelRatio(pixelRatio);
      onResize();
      break;
    }
    case 'bloom': A.pipeline?.applyQuality({ bloom: value }); break;
    case 'grade': A.pipeline?.applyQuality({ grade: value }); break;
    case 'grain': A.pipeline?.applyQuality({ grain: value }); break;
    case 'scanlines': A.pipeline?.applyQuality({ scan: value }); break;
    case 'aberration': A.pipeline?.applyQuality({ aberration: value }); break;
    case 'minimap':
      document.getElementById('minimap-wrap')?.classList.toggle('hidden', !value);
      break;
    case 'showFps':
      document.getElementById('nb-fps')?.classList.toggle('hidden', !value);
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// game flow
// ---------------------------------------------------------------------------
function requestLock() {
  App.audio?.resume();
  App.input.requestLock();
}

function startRun() {
  App.playing = true;
  App.ui.hideAll();
  App.fx.clear();
  App.director.startRun();
  App.hud.show(true);
  requestLock();
}

function quitToMenu() {
  App.playing = false;
  App.input.exitLock();
  App.director.state = 'menu';
  App.director.clearEnemies();
  App.director.projectiles.clear();
  App.director.pickups.clear();
  App.fx.clear();
  App.audio?.stopAmbient();
  App.ui.show('menu');
}

function togglePause() {
  if (!App.playing) return;
  if (App.ui.isBlocking()) {
    if (App.ui.shopOpen) return;
    App.ui.hideAll();
    requestLock();
  } else {
    App.input.exitLock();
    App.ui.showPause(App.director.stats());
  }
}

// ---------------------------------------------------------------------------
// frame loop
// ---------------------------------------------------------------------------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  App.camera.aspect = w / h;
  App.camera.updateProjectionMatrix();
  App.renderer.setSize(w, h, false);
  App.pipeline?.resize();
}

let last = performance.now();
let fpsEl = null;
let frameAcc = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);

  const t0 = now;
  const A = App;
  const input = A.input;
  const playing = A.playing && !A.ui.isBlocking();

  input.enabled = playing;

  // ---- global keys (work even when paused)
  if (input.wasPressed('Escape')) togglePause();
  if (input.wasPressed('Tab') && A.settings.values.minimap) {
    document.getElementById('minimap-wrap')?.classList.toggle('hidden');
  }
  if (input.wasPressed('KeyM') && playing) A.audio.setVolumes({ master: A.settings.values.master === 0 ? 0.85 : 0 });

  // ---- simulation
  const director = A.director;
  director.update(dt);

  if (playing) {
    A.player.handleInput(dt);
    A.player.update(dt);
    A.drainPlayerEvents?.();
  } else {
    A.player.updateViewModel(dt);
    A.player.updateFeel(dt, { x: 0, y: 0 });
  }

  // ---- shop transition
  if (director.state === 'intermission' && !A.ui.shopOpen) {
    A.ui.openShop(director);
    A.input.exitLock();
  }
  if (director.state === 'intermission' && A.ui.shopOpen) {
    A.ui.updateShopTimer(director.intermissionT);
  }
  if (director.state !== 'intermission' && A.ui.shopOpen && !A.ui.paused) {
    A.ui.hide('shop');
  }

  // ---- presentation
  A.sky.update(dt, A.camera);
  A.level.update(dt);
  A.fx.update(dt * director.timeScale, A.camera);
  A.audio.update(dt, A.camera);

  const hudState = director.hudState(dt);
  A.hud.update(hudState);

  // enemy highlight for the crosshair
  const target = A.director.enemies.find((e) => e.alive && e.hasLos &&
    Math.hypot(e.pos.x - A.player.pos.x, e.pos.z - A.player.pos.z) < 40);
  A.hud.setHostile(!!target && playing);

  const anger = A.player.stats.health / A.player.stats.maxHealth < 0.35 ? 0.5 : 0;
  A.renderState = {
    damage: Math.min(1, A.player.damageFlash + anger),
    heal: A.player.healFlash,
    flash: A.player.hitFlash || 0,
    slow: A.director.powerups.has('adrenaline') ? 1 : 0,
  };

  A.pipeline.update(dt, A.renderState);
  A.renderer.info.reset();
  A.pipeline.render();

  // ---- stats
  A.stats.drawCalls = A.renderer.info.render.calls;
  A.stats.tris = A.renderer.info.render.triangles;
  A.stats.acc += dt;
  A.stats.frames++;
  frameAcc += performance.now() - t0;
  if (A.stats.acc >= 0.5) {
    A.stats.fps = A.stats.frames / A.stats.acc;
    A.stats.ms = frameAcc / A.stats.frames;
    A.stats.frames = 0;
    A.stats.acc = 0;
    frameAcc = 0;
    if (A.settings.values.showFps) {
      if (!fpsEl) {
        fpsEl = document.createElement('div');
        fpsEl.id = 'nb-fps';
        fpsEl.style.cssText = 'position:fixed;left:50%;top:4px;transform:translateX(-50%);font:11px/1.4 monospace;color:#4fe9ff;background:rgba(4,10,16,.6);padding:3px 10px;border:1px solid rgba(79,233,255,.3);z-index:30;pointer-events:none';
        document.getElementById('app').appendChild(fpsEl);
      }
      fpsEl.textContent = `${A.stats.fps.toFixed(0)} FPS · ${A.stats.ms.toFixed(1)}ms · ${A.stats.drawCalls} calls · ${(A.stats.tris / 1000).toFixed(1)}k tris · ${A.director.enemies.length} enemies`;
    }
  }

  input.endFrame();
}

// ---------------------------------------------------------------------------
boot().catch((err) => {
  console.error('[NEON BREACH] boot failed', err);
  App.errors.push(String((err && err.stack) || err));
  const t = document.getElementById('load-text');
  if (t) { t.textContent = '启动失败: ' + (err?.message || err); t.style.color = '#ff6b7d'; }
  const s = document.getElementById('load-sub');
  if (s) s.textContent = 'SEE CONSOLE FOR STACK TRACE';
});

// expose a few helpers for debugging / automated verification
window.NB = {
  app: App,
  giveAll() {
    for (const id of Object.keys(App.player.weapons)) App.player.giveWeapon(id);
    App.player.equip('rail');
  },
  addCredits(n) { App.director.addCredits(n); },
  spawnAt(type, x, z) { return App.director.spawnEnemy(type, { spot: { x, z }, minDistance: 0 }); },
  teleport(x, z) { App.player.pos.set(x, 1, z); },
  skipWave() { App.director.spawnQueue.length = 0; App.director.clearEnemies(); },
  godMode(on = true) { App.player._god = on; },
};
