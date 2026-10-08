/**
 * tools/check-serve.mjs — prove what the server emits for one file.
 *
 *   node tools/check-serve.mjs [--port 5188] [--file /src/gameplay/director.js]
 *
 * Starts the server, fetches the file the way a browser would, and prints the
 * import lines with their exact character codes so an off-by-one in the
 * specifier rewriter is impossible to miss. Then strips the ?v= stamps and
 * syntax-checks the result.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(flag('port', 5188));
const TARGET = flag('file', '/src/gameplay/director.js');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
process.on('exit', () => { try { server.kill(); } catch { /* gone */ } });

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/')).ok) { up = true; break; } } catch { /* wait */ }
  await sleep(150);
}
if (!up) { console.log('server never came up'); process.exit(1); }

const res = await fetch(BASE + TARGET);
const body = await res.text();
const lines = body.split('\n');

console.log(`\nGET ${TARGET}  ->  HTTP ${res.status}`);
console.log(`content-type: ${res.headers.get('content-type')}`);
console.log(`cache-control: ${res.headers.get('cache-control')}`);
console.log(`bytes: ${body.length}\n`);

console.log('import / export lines with exact character codes:');
let problem = 0;
lines.forEach((line, i) => {
  if (!/^\s*(import|export)\b/.test(line)) return;
  const quotes = [...line].filter((ch) => ch === "'" || ch === '"').length;
  const okLine = quotes % 2 === 0;
  if (!okLine) problem++;
  console.log(`  ${okLine ? 'ok ' : 'BAD'} line ${i + 1}: ${line.trim().slice(0, 110)}`);
  if (!okLine) {
    console.log(`      quote count = ${quotes} (must be even)`);
    const spec = line.match(/from\s+([^\s;]+)/);
    if (spec) {
      const raw = spec[1];
      console.log(`      specifier text = ${JSON.stringify(raw)}`);
      console.log(`      char codes     = ${[...raw].map((c) => c.charCodeAt(0)).join(',')}`);
      console.log(`      starts with a quote? ${raw[0] === "'" || raw[0] === '"'}`);
    }
  }
});

// Strip the ?v= stamps, then syntax-check the module form by rewriting the
// module syntax into a classic-script equivalent (vm.SourceTextModule would
// need --experimental-vm-modules).
const stripped = body.replace(/(\.js)\?v=[0-9a-f]+/g, '$1');
const flat = stripped.split('\n').map((l) => {
  const t = l.trim();
  if (/^import\s+['"]/.test(t)) return '';
  if (/^import\s/.test(l)) {
    const rest = t.replace(/^import\s/, '');
    if (rest.startsWith('*')) return '';
    const bindings = rest.slice(0, rest.lastIndexOf(' from ')).trim();
    if (bindings.includes('{')) {
      const o = bindings.indexOf('{');
      const c = bindings.indexOf('}', o);
      const names = c < 0 ? '' : bindings.slice(o + 1, c).replace(/,\s*$/, '');
      return names ? `const { ${names} } = null;` : '';
    }
    return bindings ? `const ${bindings} = null;` : '';
  }
  if (/^export\s*\*/.test(t) || /^export\s*\{/.test(t)) return '';
  return l.replace(/^(\s*)export\s+/, '$1');
}).join('\n');
try {
  new vm.Script(flat, { filename: TARGET + ' (module-flattened)' });
  console.log('\n  \u2713 module parses after stamp removal and import flattening');
} catch (e) {
  console.log(`\n  \u2717 module FAILED: ${e.message}`);
  const m = e.message.match(/at (\d+):(\d+)/);
  if (m) {
    const n = Number(m[1]);
    for (let i = Math.max(0, n - 2); i < Math.min(lines.length, n + 1); i++) {
      console.log(`      ${i + 1}| ${lines[i].slice(0, 120)}`);
    }
  }
  problem++;
}

console.log(`\n  ${problem === 0 ? 'PASS' : 'FAIL'} — ${problem} problem(s)\n`);
server.kill();
process.exit(problem ? 1 : 0);
