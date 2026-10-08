/**
 * tools/cdp.mjs — a tiny Chrome DevTools Protocol driver.
 *
 * Puppeteer's launcher needs to spawn Chrome with piped stdio, which this
 * sandbox forbids. Instead we start Chrome fully detached (stdio: 'ignore')
 * with --remote-debugging-port and talk to it over TCP using Node's built-in
 * WebSocket — no extra dependencies, no pipes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('no Chrome/Edge binary found');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, width = 1600, height = 900, extraArgs = [], userDataDir } = {}) {
  const exe = findBrowser();
  const profile = userDataDir || path.join(os.tmpdir(), 'nb-cdp-' + port + '-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`,
    'about:blank',
    ...extraArgs,
  ];

  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',        // <- no pipes: the sandbox blocks them
    windowsHide: true,
  });
  child.unref();

  const base = `http://127.0.0.1:${port}`;
  let version = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/json/version');
      if (r.ok) { version = await r.json(); break; }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!version) throw new Error('Chrome devtools endpoint never came up on port ' + port);
  return { child, port, base, version, profile };
}

export async function newPage(base, url = 'about:blank') {
  const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error('cannot open target: ' + r.status + ' ' + (await r.text()));
  const target = await r.json();
  const conn = new Conn(target.webSocketDebuggerUrl);
  await conn.open();
  return conn;
}

export async function closeBrowser(base, port) {
  try { await fetch(`${base}/json/close/`); } catch { /* ignore */ }
  try {
    const r = await fetch(base + '/json/list');
    const list = await r.json();
    for (const t of list) {
      try { await fetch(`${base}/json/close/${t.id}`); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export class Conn {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error('connection closed'));
        this.pending.clear();
      });
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message + ' (' + JSON.stringify(msg.error.data ?? '') + ')'));
      else p.resolve(msg.result);
      return;
    }
    const list = this.listeners.get(msg.method);
    if (list) for (const fn of list) fn(msg.params);
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 180000);
    });
  }

  async eval(fnOrExpr, { awaitPromise = true } = {}) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})()`
      : String(fnOrExpr);
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      throw new Error('eval error: ' + (ex.exception?.description || ex.text));
    }
    return res.result?.value;
  }

  async screenshot(file, { fullPage = false } = {}) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }

  async setViewport(width, height, dpr = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dpr, mobile: false,
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
