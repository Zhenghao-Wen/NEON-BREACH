/**
 * ui.js — menus, settings, shop and end-of-run screens.
 *
 * Everything is DOM based. Settings persist to localStorage and are applied
 * live through callbacks so the pause menu can change quality instantly.
 */
import { WEAPON_BY_ID } from '../gameplay/weapons.js';

const $ = (id) => document.getElementById(id);

export const DEFAULT_SETTINGS = {
  sensitivity: 0.55,
  fov: 78,
  invertY: false,
  master: 0.85,
  sfx: 0.9,
  music: 0.42,
  quality: 'high',
  bloom: true,
  grade: true,
  grain: 0.055,
  scanlines: 0.35,
  aberration: 0.9,
  showFps: false,
  minimap: true,
  headBob: true,
  autoReload: true,
};

export class Settings {
  constructor(onChange) {
    this.values = { ...DEFAULT_SETTINGS };
    this.onChange = onChange;
    this.load();
  }

  load() {
    try {
      const raw = window.localStorage?.getItem('neonbreach.settings');
      if (raw) Object.assign(this.values, JSON.parse(raw));
    } catch { /* first run */ }
  }

  save() {
    try {
      window.localStorage?.setItem('neonbreach.settings', JSON.stringify(this.values));
    } catch { /* ignore */ }
  }

  set(key, value) {
    this.values[key] = value;
    this.save();
    this.onChange?.(key, value, this.values);
  }
}

export class UIManager {
  constructor({ settings, audio, onStart, onResume, onRestart, onQuit, onBuy, onNextWave, onEndless }) {
    this.settings = settings;
    this.audio = audio;
    this.onStart = onStart;
    this.onResume = onResume;
    this.onRestart = onRestart;
    this.onQuit = onQuit;
    this.onBuy = onBuy;
    this.onNextWave = onNextWave;
    this.onEndless = onEndless;
    this.shopOpen = false;
    this.paused = false;
    this.openOverlay = null;
    this.el = {
      menu: $('menu'), howto: $('howto'), settings: $('settings'), pause: $('pause'),
      shop: $('shop'), gameover: $('gameover'), victory: $('victory'),
      shopGrid: $('shop-grid'), shopCredits: $('shop-credits'), shopWave: $('shop-wave'),
      shopTimer: $('shop-timer'), shopStart: $('shop-start'), settingsBody: $('settings-body'),
      startPrompt: $('start-prompt'),
    };
    this.bind();
    this.buildSettings();
  }

  bind() {
    const click = (id, fn) => $(id)?.addEventListener('click', (e) => { e.stopPropagation(); this.audio?.play('uiClick'); fn(); });
    click('btn-play', () => { this.hideAll(); this.onStart?.(); });
    click('btn-howto', () => this.show('howto'));
    click('btn-settings', () => this.show('settings'));
    click('btn-resume', () => { this.hideAll(); this.onResume?.(); });
    click('btn-pause-settings', () => this.show('settings', true));
    click('btn-quit', () => { this.hideAll(); this.onQuit?.(); });
    click('btn-retry', () => { this.hideAll(); this.onRestart?.(); });
    click('btn-menu', () => { this.hideAll(); this.show('menu'); this.onQuit?.(); });
    click('btn-win-menu', () => { this.hideAll(); this.show('menu'); this.onQuit?.(); });
    click('btn-continue-endless', () => { this.hideAll(); this.onEndless?.(); });
    click('shop-start', () => { this.hideAll(); this.onNextWave?.(); });
    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => {
        this.audio?.play('uiClick');
        const target = btn.getAttribute('data-close');
        this.hide(target);
        if (target === 'settings' && this.returnTo) { this.show(this.returnTo); this.returnTo = null; }
      });
    }
  }

  hideAll() {
    for (const key of ['menu', 'howto', 'settings', 'pause', 'shop', 'gameover', 'victory']) this.hide(key);
  }

  show(key, fromPause = false) {
    const el = this.el[key];
    if (!el) return;
    if (key === 'settings' && !fromPause && this.openOverlay) this.returnTo = this.openOverlay;
    if (key !== 'settings' && key !== 'howto') this.openOverlay = key;
    el.classList.remove('hidden');
    if (key === 'shop') this.shopOpen = true;
    if (key === 'pause') this.paused = true;
  }

  hide(key) {
    this.el[key]?.classList.add('hidden');
    if (key === 'shop') this.shopOpen = false;
    if (key === 'pause') this.paused = false;
    if (key === 'menu' || key === 'gameover' || key === 'victory') this.openOverlay = null;
  }

  isBlocking() {
    return ['menu', 'howto', 'settings', 'pause', 'shop', 'gameover', 'victory']
      .some((k) => this.el[k] && !this.el[k].classList.contains('hidden'));
  }

  setStartPrompt(on) {
    this.el.startPrompt?.classList.toggle('hidden', !on);
  }

  // ------------------------------------------------------------------- shop
  renderShop(director) {
    const grid = this.el.shopGrid;
    if (!grid) return;
    grid.innerHTML = '';
    const items = director.shopItems();
    const affordableFirst = items.slice().sort((a, b) => (b.affordable ? 1 : 0) - (a.affordable ? 1 : 0));
    for (const item of affordableFirst) {
      const card = document.createElement('div');
      card.className = 'card' + (item.affordable ? '' : ' cant');
      const stats = item.stats.length
        ? `<div class="stats">${item.stats.map((s) => `<span>${s}</span>`).join('')}</div>`
        : '';
      const tags = item.tags?.length ? `<div class="stats">${item.tags.map((s) => `<span>${s}</span>`).join('')}</div>` : '';
      card.innerHTML = `
        <h3>${item.name}<em>${item.price}c</em></h3>
        <div class="tag">${item.tag}</div>
        <p>${item.desc}</p>
        ${stats}${tags}
      `;
      card.addEventListener('click', () => {
        if (!item.affordable) { this.audio?.play('denied'); return; }
        const ok = this.onBuy?.(item);
        if (ok) this.renderShop(director);
      });
      card.addEventListener('mouseenter', () => this.audio?.play('uiHover'));
      grid.appendChild(card);
    }
    if (this.el.shopCredits) this.el.shopCredits.textContent = Math.round(director.credits);
    if (this.el.shopWave) this.el.shopWave.textContent = director.wave;
  }

  updateShopTimer(seconds) {
    if (this.el.shopTimer) this.el.shopTimer.textContent = `下一波 ${Math.ceil(Math.max(0, seconds))}s`;
  }

  openShop(director) {
    this.renderShop(director);
    this.show('shop');
  }

  // --------------------------------------------------------------- settings
  buildSettings() {
    const body = this.el.settingsBody;
    if (!body) return;
    const s = this.settings;
    const rows = [
      { group: '操作 / CONTROLS' },
      { key: 'sensitivity', label: '鼠标灵敏度', type: 'range', min: 0.1, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
      { key: 'fov', label: '视野范围 FOV', type: 'range', min: 60, max: 110, step: 1, fmt: (v) => v + '°' },
      { key: 'invertY', label: '反转垂直视角', type: 'bool' },
      { key: 'autoReload', label: '自动换弹', type: 'bool' },
      { key: 'headBob', label: '头部摆动', type: 'bool' },
      { group: '画面 / GRAPHICS' },
      {
        key: 'quality', label: '画质预设', type: 'select',
        options: [['low', '低'], ['medium', '中'], ['high', '高']],
      },
      { key: 'bloom', label: '泛光 Bloom', type: 'bool' },
      { key: 'grade', label: '色彩分级', type: 'bool' },
      { key: 'grain', label: '胶片颗粒', type: 'range', min: 0, max: 0.2, step: 0.005, fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'scanlines', label: '扫描线', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'aberration', label: '色差', type: 'range', min: 0, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) },
      { key: 'minimap', label: '显示小地图', type: 'bool' },
      { key: 'showFps', label: '显示性能信息', type: 'bool' },
      { group: '音量 / AUDIO' },
      { key: 'master', label: '主音量', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'sfx', label: '音效', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'music', label: '环境音', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => (v * 100).toFixed(0) + '%' },
    ];
    for (const row of rows) {
      if (row.group) {
        const g = document.createElement('div');
        g.className = 'set-group';
        g.textContent = row.group;
        body.appendChild(g);
        continue;
      }
      const wrap = document.createElement('div');
      wrap.className = 'set-row';
      const label = document.createElement('label');
      label.textContent = row.label;
      wrap.appendChild(label);
      let input;
      if (row.type === 'range') {
        input = document.createElement('input');
        input.type = 'range';
        input.min = row.min; input.max = row.max; input.step = row.step;
        input.value = s.values[row.key];
        const out = document.createElement('output');
        out.textContent = row.fmt ? row.fmt(Number(s.values[row.key])) : s.values[row.key];
        input.addEventListener('input', () => {
          const v = Number(input.value);
          out.textContent = row.fmt ? row.fmt(v) : v;
          s.set(row.key, v);
        });
        wrap.appendChild(input);
        wrap.appendChild(out);
      } else if (row.type === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!s.values[row.key];
        input.addEventListener('change', () => s.set(row.key, input.checked));
        wrap.appendChild(input);
      } else if (row.type === 'select') {
        input = document.createElement('select');
        for (const [value, text] of row.options) {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = text;
          input.appendChild(o);
        }
        input.value = s.values[row.key];
        input.addEventListener('change', () => s.set(row.key, input.value));
        wrap.appendChild(input);
      }
      body.appendChild(wrap);
    }
  }

  syncSettings() {
    const body = this.el.settingsBody;
    if (!body) return;
    const inputs = body.querySelectorAll('input, select');
    let i = 0;
    for (const el of inputs) {
      const row = el.closest('.set-row');
      const key = this.keyForLabel(row?.querySelector('label')?.textContent);
      if (!key) continue;
      if (el.type === 'checkbox') el.checked = !!this.settings.values[key];
      else el.value = this.settings.values[key];
      const out = row.querySelector('output');
      if (out && el.type === 'range') out.textContent = el.value;
      i++;
    }
  }

  keyForLabel(label) {
    const map = {
      '鼠标灵敏度': 'sensitivity', '视野范围 FOV': 'fov', '反转垂直视角': 'invertY',
      '自动换弹': 'autoReload', '头部摆动': 'headBob', '画质预设': 'quality',
      '泛光 Bloom': 'bloom', '色彩分级': 'grade', '胶片颗粒': 'grain', '扫描线': 'scanlines',
      '色差': 'aberration', '显示小地图': 'minimap', '显示性能信息': 'showFps',
      '主音量': 'master', '音效': 'sfx', '环境音': 'music',
    };
    return map[label];
  }

  // ------------------------------------------------------------- end screens
  showGameOver(stats) {
    const el = $('go-stats');
    if (el) el.innerHTML = this.statsRows(stats, '任务终止');
    this.show('gameover');
  }

  showVictory(stats) {
    const el = $('win-stats');
    if (el) el.innerHTML = this.statsRows(stats, '全部波次清除');
    this.show('victory');
  }

  showPause(stats) {
    const el = $('pause-stats');
    if (el) el.innerHTML = this.statsRows(stats, '当前进度');
    this.show('pause');
  }

  statsRows(stats, title) {
    const mm = Math.floor(stats.time / 60);
    const ss = Math.floor(stats.time % 60).toString().padStart(2, '0');
    const rows = [
      [title, ''],
      ['到达波次', stats.wave],
      ['总得分', Math.round(stats.score).toLocaleString('en-US')],
      ['击杀数', stats.kills],
      ['爆头数', stats.headshots],
      ['命中率', stats.accuracy.toFixed(1) + '%'],
      ['造成伤害', Math.round(stats.damageDealt).toLocaleString('en-US')],
      ['承受伤害', Math.round(stats.damageTaken).toLocaleString('en-US')],
      ['存活时间', `${mm}:${ss}`],
    ];
    return rows.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  }
}
