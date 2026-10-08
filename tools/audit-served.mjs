/**
 * tools/audit-served.mjs — validate the JavaScript the server actually sends.
 *
 * The other audits read files straight from disk. This one starts the static
 * server, fetches every module over HTTP exactly as a browser would, and
 * syntax-checks the response body. That is what catches a bug in the server's
 * import rewriter — a class of failure that is invisible to disk-based checks
 * but breaks the game in the browser with "Unexpected token".
 *
 *   node tools/audit-served.mjs [--port 5188]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(flag('port', 5188));
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

let failures = 0;
let checks = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (t) => console.log(`\n\u2500\u2500 ${t} ${'\u2500'.repeat(Math.max(0, 58 - t.length))}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Syntax-check an ES module body without needing module loading.
 *
 * `vm.SourceTextModule` requires --experimental-vm-modules and a child process
 * needs piped stdio (blocked in this sandbox), so the module syntax is reduced
 * to a classic-script equivalent and parsed with vm.Script. Import statements
 * become `const` bindings and export modifiers are dropped; anything that then
 * fails to parse is a genuine syntax error in the served bytes.
 */
function parseModuleBody(body, identifier) {
  // 1. join multi-line import statements into single logical lines
  const logical = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*import\s/.test(raw) && !/['"];?\s*$/.test(raw.trim()) && !raw.includes(';')) {
      let joined = raw;
      let j = i;
      while (j + 1 < lines.length && !joined.includes(';')) {
        j++;
        joined += ' ' + lines[j].trim();
      }
      i = j;
      logical.push(joined);
      continue;
    }
    logical.push(raw);
  }

  // 2. reduce module syntax to classic-script equivalents
  const out = logical.map((line) => {
    const t = line.trim();
    if (/^import\s+['"]/.test(t)) return '';                        // side-effect import
    if (/^export\s*\*/.test(t)) return '';                          // export * from
    if (/^export\s*\{/.test(t)) return '';                          // re-export list
    if (/^export\s+from\s/.test(t)) return '';
    if (/^export\s+default\s/.test(t)) return line.replace(/^(\s*)export\s+default\s/, '$1const __default = ');
    if (/^(\s*)import\s/.test(line)) {
      const indent = RegExp.$1;
      const rest = t.replace(/^import\s/, '');
      if (rest.startsWith('*')) return '';                          // import * as ns
      const from = rest.lastIndexOf(' from ');
      const bindings = (from > 0 ? rest.slice(0, from) : rest).trim();
      if (bindings.includes('{')) {
        // destructuring needs an initialiser to remain valid syntax, and a
        // trailing comma inside the braces (`{ a, b, }`) is only legal in the
        // declaration form, so strip it.
        const open = bindings.indexOf('{');
        const close = bindings.indexOf('}', open);
        if (close < 0) return `${indent}const __ns = null;`;
        const names = bindings.slice(open + 1, close).replace(/,\s*$/, '');
        return `${indent}const { ${names} } = __ns;`;
      }
      return bindings ? `${indent}const ${bindings} = null;` : '';
    }
    if (/^(\s*)export\s/.test(line)) return line.replace(/^(\s*)export\s+/, '$1');
    return line;
  }).join('\n');
  // eslint-disable-next-line no-new
  new vm.Script(out, { filename: identifier });
}

/**
 * Same as parseModuleBody but returns the flattened source, for debugging a
 * failure by printing the offending line.
 */
export function flattenModuleBody(body) {
  const logical = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*import\s/.test(raw) && !/['"];?\s*$/.test(raw.trim()) && !raw.includes(';')) {
      let joined = raw;
      let j = i;
      while (j + 1 < lines.length && !joined.includes(';')) {
        j++;
        joined += ' ' + lines[j].trim();
      }
      i = j;
      logical.push(joined);
      continue;
    }
    logical.push(raw);
  }
  return logical.map((line) => {
    const t = line.trim();
    if (/^import\s+['"]/.test(t)) return '';
    if (/^export\s*\*/.test(t)) return '';
    if (/^export\s*\{/.test(t)) return '';
    if (/^export\s+from\s/.test(t)) return '';
    if (/^export\s+default\s/.test(t)) return line.replace(/^(\s*)export\s+default\s/, '$1const __default = ');
    if (/^(\s*)import\s/.test(line)) {
      const indent = RegExp.$1;
      const rest = t.replace(/^import\s/, '');
      if (rest.startsWith('*')) return '';
      const from = rest.lastIndexOf(' from ');
      const bindings = (from > 0 ? rest.slice(0, from) : rest).trim();
      if (bindings.includes('{')) {
        const open = bindings.indexOf('{');
        const close = bindings.indexOf('}', open);
        if (close < 0) return `${indent}const __ns = null;`;
        const names = bindings.slice(open + 1, close).replace(/,\s*$/, '');
        return `${indent}const { ${names} } = __ns;`;
      }
      return bindings ? `${indent}const ${bindings} = null;` : '';
    }
    if (/^(\s*)export\s/.test(line)) return line.replace(/^(\s*)export\s+/, '$1');
    return line;
  }).join('\n');
}
async function crawlModules() {
  const html = await (await fetch(BASE + '/')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  const importMap = mapMatch ? JSON.parse(mapMatch[1]).imports || {} : {};

  const queue = [...scripts];
  const seen = new Set();
  const modules = [];

  const resolveSpec = (spec, fromUrl) => {
    if (spec.startsWith('/')) return spec.split('?')[0];
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return new URL(spec, 'http://x' + fromUrl).pathname.split('?')[0];
    }
    for (const [k, v] of Object.entries(importMap)) {
      if (k.endsWith('/') && spec.startsWith(k)) return v + spec.slice(k.length);
      if (spec === k) return v;
    }
    return null; // bare specifier with no mapping
  };

  while (queue.length) {
    const spec = queue.shift();
    if (seen.has(spec)) continue;
    seen.add(spec);
    const res = await fetch(BASE + spec);
    if (!res.ok) {
      modules.push({ url: spec, status: res.status, body: null });
      continue;
    }
    const body = await res.text();
    modules.push({ url: spec, status: res.status, body });
    const dir = spec.replace(/[^/]*$/, '');
    for (const m of body.matchAll(/(?:from\s*|import\s*\(?\s*)(['"])([^'"]+)\1/g)) {
      const next = resolveSpec(m[2], dir);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return modules;
}

async function main() {
  console.log(`\n  starting server on ${BASE} to audit what it serves`);

  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), '--port', String(PORT), '--host', HOST], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  });
  const stop = () => { try { server.kill(); } catch { /* gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(1); });

  // wait for it to accept connections
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) { up = true; break; }
    } catch { /* not yet */ }
    await sleep(150);
  }
  if (!up) {
    console.log('  \u2717 server never came up');
    stop();
    process.exit(1);
  }

  try {
    section('served over HTTP');
    const modules = await crawlModules();
    ok('index.html served', modules.length > 0, `${modules.length} requests followed`);

    const failed = modules.filter((m) => m.status !== 200);
    ok('every requested module returns 200', failed.length === 0,
      failed.map((f) => `${f.url} -> ${f.status}`).join(', '));

    const js = modules.filter((m) => m.body && /\.(m?js)(\?|$)/.test(m.url));

    section('syntax of served JavaScript');
    let bad = 0;
    let advisory = 0;
    for (const mod of js) {
      // Vendored third-party trees are shipped code we do not modify; parse
      // them for information but only the project's own modules are gated,
      // since the flattener below is a heuristic.
      const isOwn = mod.url.startsWith('/src/') || mod.url === '/index.html';
      try {
        parseModuleBody(mod.body, mod.url);
      } catch (e) {
        const msg = String(e.message || e);
        if (!isOwn) {
          advisory++;
          console.log(`    \u00b7 ${mod.url}: ${msg}  (vendored, not gated)`);
          continue;
        }
        bad++;
        console.log(`    \u2717 ${mod.url}: ${msg}`);
        const flat = flattenModuleBody(mod.body).split('\n');
        const loc = String(e.stack || '').match(/<[^>]*>:(\d+)/) || msg.match(/at (\d+):(\d+)/);
        if (loc) {
          const num = Number(loc[1]);
          for (let i = Math.max(0, num - 3); i < Math.min(flat.length, num + 2); i++) {
            console.log(`        ${i + 1}| ${flat[i].slice(0, 120)}`);
          }
        }
      }
    }
    ok('every game module served parses', bad === 0, `${js.length - bad - advisory}/${js.length} modules`);

    section('import specifier integrity');
    // the rewriter appends ?v=stamp to relative specifiers; the quotes around
    // them must survive. A broken quote showed up in a browser as
    // "Unexpected token '.'" pointing at the import line.
    let malformed = 0;
    for (const mod of js) {
      for (const line of mod.body.split('\n')) {
        if (!/^\s*(import|export)\b/.test(line)) continue;
        const quotes = (line.match(/['"]/g) || []).length;
        if (quotes % 2 !== 0) {
          malformed++;
          console.log(`    \u2717 ${mod.url}: odd quote count -> ${line.trim().slice(0, 120)}`);
        }
        if (/from\s+\.\.?\//.test(line) && !/from\s+['"]/.test(line)) {
          malformed++;
          console.log(`    \u2717 ${mod.url}: unquoted specifier -> ${line.trim().slice(0, 120)}`);
        }
      }
    }
    ok('every import/export line keeps its quotes', malformed === 0);

    section('cache behaviour');
    const head = await fetch(BASE + '/src/main.js');
    ok('source modules are no-store', head.headers.get('cache-control') === 'no-store',
      String(head.headers.get('cache-control')));
    const vendored = await fetch(BASE + '/threejs/three.module.js');
    ok('vendored three.js is cacheable',
      vendored.ok && String(vendored.headers.get('cache-control')).includes('max-age'),
      `${vendored.status} ${vendored.headers.get('cache-control')}`);

    section('misc');
    const favicon = await fetch(BASE + '/favicon.ico');
    ok('favicon is provided (no console 404)', favicon.ok, `HTTP ${favicon.status}`);

    // the rewriter must be stable: same request twice, identical bytes
    const a = await (await fetch(BASE + '/src/gameplay/director.js')).text();
    const b = await (await fetch(BASE + '/src/gameplay/director.js')).text();
    ok('repeated requests are byte-identical', a === b);

    // and the version stamps must actually be present
    ok('relative imports carry a version stamp', /\?v=[0-9a-f]{8}/.test(a),
      (a.split('\n').find((l) => l.includes('?v=')) || '').trim().slice(0, 100));
  } finally {
    stop();
  }

  console.log('\n' + '='.repeat(64));
  console.log(`  ${checks - failures}/${checks} checks passed`);
  console.log('='.repeat(64) + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
