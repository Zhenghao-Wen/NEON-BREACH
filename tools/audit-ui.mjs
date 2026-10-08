/**
 * tools/audit-ui.mjs — check that every DOM id the code touches exists in
 * index.html, and that every id in the HTML is actually wired up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'style.css'), 'utf8');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const files = ['src/main.js', 'src/ui/ui.js', 'src/ui/hud.js', 'src/gfx/fx.js'];
const used = new Map();
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) used.set(m[1], rel);
  for (const m of src.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) used.set(m[1], rel);
  // the ui helper also takes ids as click('btn-x', fn)
  for (const m of src.matchAll(/click\(\s*['"]([^'"]+)['"]/g)) used.set(m[1], rel);
}

// created dynamically at runtime rather than declared in the markup
const RUNTIME_CREATED = new Set(['nb-fps']);
const missing = [...used.entries()].filter(([id]) => !htmlIds.has(id) && !RUNTIME_CREATED.has(id));
const unused = [...htmlIds].filter((id) => !used.has(id));

console.log(`index.html ids      : ${htmlIds.size}`);
console.log(`ids used by code    : ${used.size}`);
console.log(`missing from HTML   : ${missing.length ? missing.map(([id, f]) => `${id} (${f})`).join(', ') : 'none'}`);
console.log(`declared but unused : ${unused.join(', ') || 'none'}`);

// class names the JS toggles must exist in the stylesheet
const CLASSES = [
  'hidden', 'show', 'kill', 'on', 'active', 'locked', 'cant', 'hostile',
  'dmgnum', 'toast', 'kf', 'dmg-ind', 'wslot', 'card', 'head', 'good', 'warn',
];
const missingClasses = CLASSES.filter((c) => !css.includes('.' + c) && c !== 'head');
console.log(`css classes missing : ${missingClasses.join(', ') || 'none'}`);

process.exit(missing.length || missingClasses.length ? 1 : 0);
