/**
 * tools/vendor.mjs — make `threejs/` a complete, self-contained three.js runtime.
 *
 * The `threejs/` folder holds the three.js r180 build (three.module.js +
 * three.core.js). three.js split its examples/addons out of the core build, so
 * this script copies the addon modules the game uses from the installed
 * `three` package into `threejs/examples/jsm/` and rewrites their bare `three`
 * imports to relative paths.
 *
 * After running it, the game can be served straight from `threejs/` with no
 * node_modules at all:
 *
 *   node tools/vendor.mjs
 *   node tools/serve.mjs --vendor
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules', 'three');
const DEST = path.join(ROOT, 'threejs');

/** Modules the game imports, plus everything they pull in. */
const ENTRY_ADDONS = [
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/OutputPass.js',
  'postprocessing/FXAAPass.js',
  'postprocessing/Pass.js',
  'shaders/FXAAShader.js',
  'shaders/CopyShader.js',
  'shaders/LuminosityHighPassShader.js',
  'shaders/OutputShader.js',
  'utils/BufferGeometryUtils.js',
];

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\2/g;

function rewrite(source, fileRel) {
  const fileDir = path.posix.dirname(fileRel);
  return source.replace(IMPORT_RE, (match, prefix, quote, spec) => {
    if (spec === 'three') {
      // depth from this file back to threejs/three.module.js
      const depth = fileDir.split('/').filter(Boolean).length;
      return `${prefix}${quote}${'../'.repeat(depth)}three.module.js${quote}`;
    }
    if (spec.startsWith('three/addons/')) {
      const target = spec.slice('three/addons/'.length);
      const depth = fileDir.split('/').filter(Boolean).length;
      return `${prefix}${quote}${'../'.repeat(depth)}${target}${quote}`;
    }
    if (spec.startsWith('three/examples/jsm/')) {
      const target = spec.slice('three/examples/jsm/'.length);
      const depth = fileDir.split('/').filter(Boolean).length;
      return `${prefix}${quote}${'../'.repeat(depth)}${target}${quote}`;
    }
    if (spec.startsWith('three/')) {
      // e.g. three/tsl — map to the sibling build file when it exists
      const target = spec.slice('three/'.length);
      if (fs.existsSync(path.join(DEST, target + '.js'))) {
        const depth = fileDir.split('/').filter(Boolean).length;
        return `${prefix}${quote}${'../'.repeat(depth)}${target}.js${quote}`;
      }
    }
    return match;
  });
}

async function copyAddon(rel, seen) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const from = path.join(SRC, 'examples', 'jsm', rel);
  if (!fs.existsSync(from)) {
    console.warn('  ! missing addon (skipped):', rel);
    return;
  }
  let body = await fsp.readFile(from, 'utf8');

  // collect local dependencies BEFORE rewriting, while specifiers are original
  const deps = [];
  for (const m of body.matchAll(IMPORT_RE)) {
    const spec = m[3];
    if (!spec.startsWith('.')) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    if (resolved.endsWith('.js')) deps.push(resolved);
  }

  const dirRel = path.posix.join('examples', 'jsm', rel);
  body = rewrite(body, dirRel);

  const to = path.join(DEST, 'examples', 'jsm', rel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, body, 'utf8');
  for (const d of deps) await copyAddon(d, seen);
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Cannot find node_modules/three — run `npm install` first.');
    process.exit(1);
  }
  const version = JSON.parse(await fsp.readFile(path.join(SRC, 'package.json'), 'utf8')).version;
  console.log(`vendoring three.js addons from three@${version} into threejs/`);

  const seen = new Set();
  for (const entry of ENTRY_ADDONS) await copyAddon(entry, seen);

  // a small marker so the server can recognise a vendored tree
  await fsp.writeFile(path.join(DEST, 'VENDORED.json'), JSON.stringify({
    source: `three@${version}`,
    generatedAt: new Date().toISOString(),
    modules: [...seen].sort(),
  }, null, 2), 'utf8');

  console.log(`  copied ${seen.size} addon modules`);
  console.log('  done — run `node tools/serve.mjs --vendor` to serve from threejs/');
}

main().catch((e) => { console.error(e); process.exit(1); });
