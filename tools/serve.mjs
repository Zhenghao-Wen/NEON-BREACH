/**
 * tools/serve.mjs — dependency-free static server for NEON BREACH.
 *
 * Why not a bundler? The game loads three.js straight out of node_modules via
 * a native <script type="importmap">, so there is no build step at all: no
 * bundler process, no transpiler, nothing to download. `npm install` is the
 * only setup step and the whole thing runs offline.
 *
 *   node tools/serve.mjs [--port 5180] [--host 127.0.0.1]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(flag('port', process.env.PORT || 5180));
const HOST = flag('host', '127.0.0.1');
const DEV = argv.includes('--dev');
/** --vendor serves three.js from ./threejs instead of ./node_modules/three */
const VENDOR = argv.includes('--vendor');

const VENDOR_MAP = {
  three: '/threejs/three.module.js',
  'three/addons/': '/threejs/examples/jsm/',
  'three/examples/jsm/': '/threejs/examples/jsm/',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
};

/**
 * Cache-busting for source files only. We hash mtimes+size, then rewrite the
 * relative import specifiers inside JS so a browser reload always picks up the
 * newest module graph without disabling caching wholesale.
 */
const stampCache = new Map();
async function stampFor(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const key = file;
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = stampCache.get(key);
  if (hit && hit.sig === sig) return hit.stamp;
  const stamp = createHash('sha1').update(file + sig).digest('hex').slice(0, 8);
  stampCache.set(key, { sig, stamp });
  return stamp;
}

const IMPORT_RE = /(from\s*|import\s*\(?\s*)(['"])(\.[^'"]+)\2/g;

/**
 * Rewrite relative import specifiers to carry the target's content stamp, so a
 * reload always pulls the current module graph.
 *
 * The transform is a pure function of (file path, file content): the result is
 * memoised on a hash of the body, never on timing, so the same bytes are always
 * produced for the same input.
 */
const transformCache = new Map();

async function transformJs(file, body) {
  const stamp = await stampFor(file);
  if (!stamp) return body;
  const key = createHash('sha1').update(file).update('\u0000').update(body).digest('hex');
  const cached = transformCache.get(key);
  if (cached) return cached;

  const dir = path.dirname(file);
  const replacements = [];
  const skipped = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(body))) {
    const spec = m[3];
    let target = path.resolve(dir, spec);
    try {
      const st = await fsp.stat(target);
      if (st.isDirectory()) target = path.join(target, 'index.js');
    } catch { /* leave unresolved; the browser will report it */ }
    const tstamp = await stampFor(target);
    if (!tstamp) continue;
    // Replace only the specifier itself. m.index + prefix.length lands exactly
    // on the opening quote, and the specifier begins one character later.
    // Guard the position rather than trusting the arithmetic: a mistake here
    // silently eats the quote and the browser reports "Unexpected token".
    const specStart = m.index + m[1].length + 1;
    const quoteChar = body[specStart - 1];
    if (quoteChar !== "'" && quoteChar !== '"') {
      skipped.push({ line: body.slice(0, m.index).split('\n').length, reason: 'no opening quote at computed offset' });
      continue;
    }
    if (body.slice(specStart, specStart + spec.length) !== spec) {
      skipped.push({ line: body.slice(0, m.index).split('\n').length, reason: 'specifier slice mismatch' });
      continue;
    }
    const closing = body[specStart + spec.length];
    if (closing !== quoteChar) {
      skipped.push({ line: body.slice(0, m.index).split('\n').length, reason: 'unbalanced closing quote' });
      continue;
    }
    replacements.push([specStart, spec.length, `${spec}?v=${tstamp}`]);
  }
  let out = body;
  if (replacements.length) {
    for (let i = replacements.length - 1; i >= 0; i--) {
      const [start, len, text] = replacements[i];
      out = out.slice(0, start) + text + out.slice(start + len);
    }
  }
  if (skipped.length) {
    console.warn(`[serve] ${path.relative(ROOT, file)}: skipped ${skipped.length} import rewrite(s)`);
    for (const s of skipped) console.warn(`        line ${s.line}: ${s.reason}`);
  }
  // Final safety net: if the rewrite produced something that no longer has
  // balanced quotes on its import lines, serve the original bytes instead. A
  // stale module is far better than a module that fails to parse.
  if (replacements.length && !importsLookSane(out)) {
    console.warn(`[serve] ${path.relative(ROOT, file)}: rewrite failed validation, serving original`);
    transformCache.set(key, body);
    return body;
  }
  transformCache.set(key, out);
  return out;
}

/** Cheap structural check: every import/export line keeps balanced quotes. */
function importsLookSane(text) {
  for (const line of text.split('\n')) {
    if (!/^\s*(import|export)\b/.test(line)) continue;
    let quotes = 0;
    for (const ch of line) if (ch === "'" || ch === '"') quotes++;
    if (quotes % 2 !== 0) return false;
    if (/\bfrom\s+\.\.?\//.test(line) && !/\bfrom\s+['"]/.test(line)) return false;
  }
  return true;
}

async function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(ROOT)) return null;
  let st;
  try { st = await fsp.stat(abs); } catch { return null; }
  if (st.isDirectory()) {
    const idx = path.join(abs, 'index.html');
    try { await fsp.stat(idx); return idx; } catch { return null; }
  }
  return abs;
}

const server = http.createServer(async (req, res) => {
  try {
    // browsers ask for this unprompted; answer instead of logging a 404
    if ((req.url || '').split('?')[0] === '/favicon.ico') {
      const icon = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        + '<rect width="32" height="32" rx="6" fill="#05070c"/>'
        + '<path d="M18 4 8 18h6l-2 10 10-14h-6z" fill="#4fe9ff"/></svg>',
        'utf8',
      );
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      res.end(icon);
      return;
    }

    const file = await resolveFile(req.url || '/');
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 ' + req.url);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // Game sources are re-read from disk on every request, so they are served
    // no-store: a stale module in the browser costs far more than the bytes
    // saved on localhost. The published three.js trees never change at runtime
    // and stay cacheable.
    const inVendor = file.includes(`${path.sep}threejs${path.sep}`);
    const inNodeModules = file.includes(`${path.sep}node_modules${path.sep}`);
    const isSource = /\.(m?js|css|html)$/.test(ext) && !inVendor && !inNodeModules;
    let body = await fsp.readFile(file);

    if (ext === '.js' || ext === '.mjs') {
      // Only game sources get the cache-busting stamp rewrite: the vendored
      // tree already uses relative specifiers, and node_modules is a published
      // package we must not mutate.
      if (isSource) {
        body = Buffer.from(await transformJs(file, body.toString('utf8')), 'utf8');
      }
    }
    if (ext === '.html') {
      let html = body.toString('utf8');
      const stamp = await stampFor(path.join(ROOT, 'src', 'main.js'));
      html = html.replace('src="/src/main.js"', `src="/src/main.js?v=${stamp}"`);
      if (VENDOR) {
        html = html.replace(
          /"three":\s*"[^"]+"/,
          `"three": "${VENDOR_MAP.three}"`,
        ).replace(
          /"three\/addons\/":\s*"[^"]+"/,
          `"three/addons/": "${VENDOR_MAP['three/addons/']}"`,
        ).replace(
          /"three\/examples\/jsm\/":\s*"[^"]+"/,
          `"three/examples/jsm/": "${VENDOR_MAP['three/examples/jsm/']}"`,
        );
      }
      body = Buffer.from(html, 'utf8');
    }

    const headers = {
      'content-type': type,
      // Source files are served no-store. They are re-read from disk on every
      // request anyway (the ETag is derived from the current bytes), and this
      // is a local dev server — a stale module in the browser costs far more
      // than the bytes saved. Vendored three.js is immutable and cacheable.
      'cache-control': isSource ? 'no-store' : 'public, max-age=604800',
      'access-control-allow-origin': '*',
    };
    // Content-addressed ETag: derived from the bytes actually being sent, so a
    // stale validator can never be matched against fresh content.
    const bodyStamp = createHash('sha1').update(body).digest('hex').slice(0, 12);
    const etag = `W/"${body.length.toString(16)}-${bodyStamp}"`;
    headers.etag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('500 ' + (err && err.stack || err));
  }
});

server.listen(PORT, HOST, () => {
  const line = `NEON BREACH  ->  http://${HOST}:${PORT}/`;
  console.log('\n  ' + line);
  console.log(`  root:   ${ROOT}`);
  console.log(`  three:  ${VENDOR ? './threejs (vendored, no node_modules needed)' : './node_modules/three (via import map)'}`);
  console.log('  static modules, no bundler — Ctrl+C to stop\n');
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
