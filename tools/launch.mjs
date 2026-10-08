/**
 * tools/launch.mjs — one-shot launcher for NEON BREACH.
 *
 *   1. checks the Node version
 *   2. installs dependencies when they are missing
 *   3. finds a free port (5180, then upwards)
 *   4. optionally vendors three.js into ./threejs (npm run vendor)
 *   5. starts the static server and opens the browser
 *
 * Options:
 *   --port <n>      preferred port (default 5180)
 *   --no-open       do not open a browser
 *   --no-install    never run npm install
 *   --vendor        serve three.js from ./threejs instead of node_modules
 *   --host <addr>   bind address (default 127.0.0.1)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const flag = (f, d) => {
  const i = argv.indexOf('--' + f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const HOST = flag('host', '127.0.0.1');
const PREFERRED_PORT = Number(flag('port', 5180));
const OPEN_BROWSER = !has('no-open');
const ALLOW_INSTALL = !has('no-install');
const PREFER_VENDOR = has('vendor');

const c = {
  dim: '\x1b[2m', reset: '\x1b[0m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const say = (m) => console.log(m);
const step = (m) => say(`  ${c.cyan}\u25b8${c.reset} ${m}`);
const good = (m) => say(`  ${c.green}\u2713${c.reset} ${m}`);
const warn = (m) => say(`  ${c.yellow}!${c.reset} ${m}`);
const bad = (m) => say(`  ${c.red}\u2717${c.reset} ${m}`);

const banner = `
  ${c.cyan}${c.bold}NEON BREACH${c.reset} ${c.dim}\u2014 3D first-person shooter${c.reset}
  ${c.dim}procedural textures \u00b7 procedural audio \u00b7 no build step \u00b7 fully offline${c.reset}
`;

// ---------------------------------------------------------------------------
// 1. environment
// ---------------------------------------------------------------------------
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    bad(`Node.js ${process.versions.node} is too old \u2014 18 or newer is required.`);
    process.exit(1);
  }
  good(`Node.js ${process.versions.node}`);
}

// ---------------------------------------------------------------------------
// 2. dependencies
// ---------------------------------------------------------------------------
function depsReady() {
  return fs.existsSync(path.join(ROOT, 'node_modules', 'three', 'package.json'));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function ensureDeps() {
  if (depsReady()) {
    good('dependencies present (three.js)');
    return true;
  }
  if (!ALLOW_INSTALL) {
    warn('node_modules/three is missing and --no-install was given');
    return false;
  }
  step('installing dependencies (npm install) \u2026');
  // a workspace-local npm cache avoids permission problems on locked-down machines
  const cacheDir = path.join(ROOT, '.npm-cache');
  const code = await run('npm', ['install', '--no-audit', '--no-fund', '--cache', cacheDir]);
  if (code === 0 && depsReady()) {
    good('dependencies installed');
    return true;
  }
  bad('npm install failed \u2014 see the output above');
  say(`    ${c.dim}If your network blocks npm, run:  npm install --cache .npm-cache${c.reset}`);
  return false;
}

// ---------------------------------------------------------------------------
// 3. port
// ---------------------------------------------------------------------------
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });
}

async function pickPort() {
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 40; p++) {
    if (await portFree(p)) {
      if (p !== PREFERRED_PORT) warn(`port ${PREFERRED_PORT} is busy, using ${p}`);
      return p;
    }
  }
  bad(`no free port in ${PREFERRED_PORT}\u2013${PREFERRED_PORT + 39}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. vendored three.js (optional)
// ---------------------------------------------------------------------------
async function ensureVendor() {
  const vendorDir = path.join(ROOT, 'threejs');
  const marker = path.join(vendorDir, 'VENDORED.json');
  if (!fs.existsSync(vendorDir)) return false;
  if (fs.existsSync(marker) && !has('re-vendor')) {
    good('vendored three.js tree present (threejs/)');
    return true;
  }
  if (!depsReady()) return false;
  step('vendoring three.js addons into threejs/ \u2026');
  const code = await run(process.execPath, [path.join(ROOT, 'tools', 'vendor.mjs')]);
  if (code === 0) good('three.js vendored');
  else warn('vendoring failed \u2014 falling back to node_modules');
  return code === 0;
}

// ---------------------------------------------------------------------------
// 5. server + browser
// ---------------------------------------------------------------------------
function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => warn(`could not open a browser \u2014 visit ${url} manually`));
    child.unref();
  } catch {
    warn(`could not open a browser \u2014 visit ${url} manually`);
  }
}

async function main() {
  say(banner);

  step('checking environment');
  checkNode();
  good(`${process.platform} ${os.arch()}`);

  step('checking dependencies');
  const depsOk = await ensureDeps();

  let useVendor = false;
  if (PREFER_VENDOR) {
    useVendor = await ensureVendor();
    if (!useVendor) {
      warn('vendor mode requested but unavailable');
      if (!depsOk) {
        bad('nothing to serve three.js from \u2014 run npm install first');
        process.exit(1);
      }
    }
  } else if (!depsOk) {
    // no node_modules: the vendored tree is the only way to run
    useVendor = await ensureVendor();
    if (!useVendor) {
      bad('cannot start: neither node_modules/three nor a vendored threejs/ tree is available');
      process.exit(1);
    }
    warn('running from the vendored threejs/ tree');
  }

  const port = await pickPort();
  const url = `http://${HOST}:${port}/`;

  step('starting server');
  const serverArgs = [path.join(ROOT, 'tools', 'serve.mjs'), '--port', String(port), '--host', HOST];
  if (useVendor) serverArgs.push('--vendor');

  const server = spawn(process.execPath, serverArgs, { cwd: ROOT, stdio: 'inherit' });

  let opened = false;
  const onFirstOutput = setTimeout(() => {
    if (opened) return;
    opened = true;
    say('');
    good(`ready \u2014 ${c.bold}${url}${c.reset}`);
    say(`  ${c.dim}press Ctrl+C to stop${c.reset}\n`);
    if (OPEN_BROWSER) openBrowser(url);
  }, 700);

  const shutdown = () => {
    clearTimeout(onFirstOutput);
    say(`\n  ${c.dim}shutting down\u2026${c.reset}`);
    try { server.kill(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('close', (code) => {
    clearTimeout(onFirstOutput);
    if (code) bad(`server exited with code ${code}`);
    process.exit(code ?? 0);
  });
  server.on('error', (err) => {
    bad(`could not start the server: ${err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  bad(err?.stack || String(err));
  process.exit(1);
});
