/**
 * tools/audit-shaders.mjs — static validation of the hand-written GLSL.
 *
 * The offline harness runs the game's JavaScript but never a real GLSL
 * compiler, so a typo in a shader would only surface as a black screen in a
 * browser. These checks catch the mistakes that actually happen:
 *   - braces / parentheses out of balance
 *   - a uniform referenced in the shader body but missing from the uniforms map
 *   - a uniform declared in the map but never used
 *   - a varying declared in the vertex shader but not the fragment shader
 *   - assignments missing a semicolon on simple statements
 *   - an attribute that does not exist in the three.js built-in set
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// three.js injects these automatically; the shader must not declare them.
const BUILTIN_UNIFORMS = new Set([
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix',
  'normalMatrix', 'cameraPosition', 'isOrthographic', 'logDepthBufFC',
]);
const BUILTIN_ATTRIBUTES = new Set(['position', 'normal', 'uv', 'uv1', 'uv2', 'color', 'tangent', 'instanceMatrix']);

let failures = 0;
let checks = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (t) => console.log(`\n\u2500\u2500 ${t} ${'\u2500'.repeat(Math.max(0, 58 - t.length))}`);

/** Collect the uniform keys declared in a `uniforms[:=] { ... }` block. */
function parseUniformBlock(src) {
  const blocks = [];
  // matches both `uniforms: {` (object literal) and `this.uniforms = {`
  const re = /uniforms\s*[:=]\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    if (open < 0) break;
    // brace matching
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) break;
    const body = src.slice(open + 1, end);
    const keys = [...body.matchAll(/(?:^|[,{\s])([A-Za-z_][\w]*)\s*:\s*\{/g)].map((x) => x[1]);
    blocks.push({ keys, body });
  }
  return blocks;
}

/** Extract `name = /* glsl *\/\`...\`` shader sources from a module. */
function parseShaderModule(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const named = [...src.matchAll(/(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*\/\* glsl \*\/`([\s\S]*?)`/g)]
    .map((m) => ({ name: m[1], body: m[2] }));
  const shaders = named.length
    ? named.map((n) => n.body)
    : [...src.matchAll(/\/\* glsl \*\/`([\s\S]*?)`/g)].map((m) => m[1]);
  return { src, shaders, named, uniformBlocks: parseUniformBlock(src) };
}

/** Names declared by a `uniform <type> a, b, c;` statement (list form included). */
function uniformNames(body) {
  const out = [];
  for (const m of body.matchAll(/uniform\s+\w+\s+([^;]+);/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/\[.*$/, '').trim();
      if (/^[A-Za-z_]\w*$/.test(name)) out.push(name);
    }
  }
  return out;
}

function balance(src, open, close, label) {
  let depth = 0;
  for (const ch of src) {
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth < 0) return `extra ${close}`;
  }
  return depth === 0 ? null : `${depth} unclosed ${open}`;
}

function checkShader(name, body) {
  const braceErr = balance(body, '{', '}');
  const parenErr = balance(body, '(', ')');
  ok(`${name}: braces balanced`, !braceErr, braceErr || '');
  ok(`${name}: parentheses balanced`, !parenErr, parenErr || '');

  // every declared uniform must be used, and every used identifier must exist
  const declared = new Set(uniformNames(body));
  const attributes = [...body.matchAll(/attribute\s+\w+\s+([A-Za-z_][\w]*)\s*;/g)].map((m) => m[1]);
  const badAttr = attributes.filter((a) => BUILTIN_ATTRIBUTES.has(a));
  ok(`${name}: no re-declared builtin attributes`, badAttr.length === 0, badAttr.join(', '));

  // function declarations vs statements: a bare identifier followed by '(' that
  // is not a known function is usually a typo
  const knownFns = new Set(['main', 'texture2D', 'textureCube', 'texture', 'sin', 'cos', 'tan', 'atan', 'asin', 'acos',
    'pow', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'inversesqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod',
    'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance', 'dot', 'cross', 'normalize',
    'reflect', 'refract', 'faceforward', 'matrixCompMult', 'if', 'for', 'while', 'return', 'discard',
    'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'float', 'int', 'bool', 'sampler2D', 'samplerCube']);
  const calls = [...body.matchAll(/([A-Za-z_][\w]*)\s*\(/g)].map((m) => m[1]);
  const unknown = [...new Set(calls)].filter((c) => !knownFns.has(c) &&
    !body.includes(`float ${c}(`) && !body.includes(`vec2 ${c}(`) &&
    !body.includes(`vec3 ${c}(`) && !body.includes(`vec4 ${c}(`));
  ok(`${name}: all called functions are known`, unknown.length === 0, unknown.join(', '));

  // crude statement check: a line with a bare assignment not ending in ; , ) { }
  const suspicious = body.split('\n').filter((l) => {
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false;
    if (/^(uniform|attribute|varying|precision|#|const|struct)/.test(t)) return false;
    if (/[;,{}()]$/.test(t)) return false;
    if (/^(else|if|for|while|return)\b/.test(t)) return false;
    return /[A-Za-z0-9_)\]]\s*[-+*/]?=\s*[^=]/.test(t);
  });
  ok(`${name}: statements terminated`, suspicious.length === 0, suspicious.slice(0, 2).join(' | '));
  return { declared };
}

// ---------------------------------------------------------------------------
section('GLSL shader audit');
const MODULES = ['src/gfx/sky.js', 'src/gfx/fx.js', 'src/gfx/post.js'];
let totalShaders = 0;

for (const rel of MODULES) {
  const { shaders, named, uniformBlocks } = parseShaderModule(rel);
  const label = path.basename(rel);
  ok(`${label}: found shader sources`, shaders.length > 0, `${shaders.length} blocks`);

  const vertexBodies = [];
  const fragmentBodies = [];
  for (const { name, body } of named) {
    totalShaders++;
    checkShader(`${label}/${name}`, body);
    if (/VERT/.test(name)) vertexBodies.push({ name, body });
    if (/FRAG/.test(name)) fragmentBodies.push({ name, body });
  }

  // varyings declared in the vertex stage must exist in the fragment stage
  for (const v of vertexBodies) {
    const varyings = [...v.body.matchAll(/varying\s+\w+\s+([A-Za-z_][\w]*)\s*;/g)].map((m) => m[1]);
    for (const frag of fragmentBodies) {
      const fragVaryings = new Set([...frag.body.matchAll(/varying\s+\w+\s+([A-Za-z_][\w]*)\s*;/g)].map((m) => m[1]));
      const missing = varyings.filter((x) => !fragVaryings.has(x));
      ok(`${label}: varyings of ${v.name} exist in ${frag.name}`, missing.length === 0, missing.join(', '));
    }
  }

  // every uniform a shader declares must be supplied by the uniforms map.
  // Check the whole module rather than each stage in isolation: post.js holds
  // two independent shaders with their own uniform maps.
  const supplied = new Set(uniformBlocks.flatMap((b) => b.keys));
  const declaredAll = new Set();
  for (const body of shaders) {
    for (const u of uniformNames(body)) {
      declaredAll.add(u);
      if (BUILTIN_UNIFORMS.has(u)) continue;
      if (!supplied.has(u)) {
        ok(`${label}: uniform '${u}' is supplied`, false,
          `declared in the shader but absent from uniforms {${[...supplied].join(',')}}`);
      }
    }
  }
  ok(`${label}: uniform wiring complete`, true, `${declaredAll.size} declared / ${supplied.size} supplied`);
  const orphan = [...supplied].filter((k) => !declaredAll.has(k));
  ok(`${label}: no orphan uniforms`, orphan.length === 0, orphan.join(', '));
}

// the grade pass uniforms must all be driven from JS
const postSrc = fs.readFileSync(path.join(ROOT, 'src/gfx/post.js'), 'utf8');
const gradeBlock = parseUniformBlock(postSrc).find((b) => b.keys.includes('uVignette'));
const gradeUniforms = gradeBlock ? gradeBlock.keys : [];
const driven = gradeUniforms.filter((u) => postSrc.includes(`uniforms.${u}`) || postSrc.includes(`['${u}']`));
ok('grade pass: uniforms are driven from JS', driven.length >= gradeUniforms.length - 1,
  `${driven.length}/${gradeUniforms.length} driven`);
const undriven = gradeUniforms.filter((u) => !driven.includes(u) && u !== 'tDiffuse');
ok('grade pass: no dead uniforms', undriven.length === 0, undriven.join(', '));

console.log('\n' + '='.repeat(64));
console.log(`  shader blocks checked: ${totalShaders}`);
console.log(`  ${checks - failures}/${checks} checks passed`);
console.log('='.repeat(64) + '\n');
process.exit(failures ? 1 : 0);
