/**
 * textures.js — a procedural PBR material library.
 *
 * Every texture in the game (albedo, normal, roughness, ambient occlusion,
 * emissive) is synthesized from tileable noise at load time. Nothing is
 * downloaded, so the game runs fully offline and the "texture detail" is
 * generated at 512² per channel with real height -> normal derivation.
 */
import * as THREE from 'three';
import { makeValueNoise, makeRng, clamp, lerp, smoothstep, mixRGB } from './noise.js';

const SIZE = 512;
const MAX_ANISO = 8;

// ---------------------------------------------------------------------------
// small colour helpers ------------------------------------------------------
// ---------------------------------------------------------------------------
const C = (r, g, b) => [r / 255, g / 255, b / 255];
const scaleRGB = (c, s) => [c[0] * s, c[1] * s, c[2] * s];
const addRGB = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// ---------------------------------------------------------------------------
// surface pattern generators ------------------------------------------------
// Each returns { rgb:[r,g,b], h:0..1, rgh:0..1, met:0..1, emi:0..1 }
// `x`,`y` are normalized tile coordinates in [0,1).
// ---------------------------------------------------------------------------
function makePatterns() {
  const N = makeValueNoise(1337);
  const N2 = makeValueNoise(90210);
  const { fbm, ridged, worley } = N;

  /** Grime/tint helper shared by many patterns. */
  function grime(x, y, amount = 0.22, grid = 6) {
    const g = fbm(x, y, { grid, octaves: 4 });
    return clamp(1 - amount + g * amount, 0.25, 1.35);
  }

  return {
    /** Poured concrete: aggregate, form-board seams, hairline cracks, stains. */
    concrete(x, y, o) {
      const base = o.col || C(122, 124, 128);
      const fine = fbm(x, y, { grid: 32, octaves: 3 });
      const mid = fbm(x + 0.31, y - 0.17, { grid: 8, octaves: 5 });
      const agg = worley(x, y, 48, 0.95);
      const speck = agg.d1 < 0.035 ? 0.14 : agg.d1 < 0.07 ? 0.06 : 0;
      // hairline cracks: ridged ridges near the top of their range
      const crackN = ridged(x * 1.13 + 0.4, y * 1.07 - 0.2, { grid: 5, octaves: 5 });
      const crack = smoothstep(0.86, 0.99, crackN) * (0.55 + 0.45 * fbm(x, y, { grid: 3, octaves: 3 }));
      // form-board seams every 1/3 of the tile
      const seam = Math.max(
        smoothstep(0.012, 0.0, Math.abs(((x * 3) % 1) - 0.5) - 0.47),
        smoothstep(0.012, 0.0, Math.abs(((y * 3) % 1) - 0.5) - 0.47)
      );
      const stain = smoothstep(0.15, 0.75, fbm(x - 0.6, y + 0.22, { grid: 3, octaves: 4 }) + 0.35);
      const topDark = smoothstep(0.55, 0.0, y) * 0.12; // grime running downward

      let c = scaleRGB(base, 0.82 + mid * 0.16 + fine * 0.05 + speck);
      c = mixRGB(c, C(96, 94, 88), stain * 0.35 + topDark);
      c = scaleRGB(c, grime(x, y, 0.2, 7));

      let h = 0.5 + fine * 0.06 + mid * 0.04 + speck * 0.7;
      h -= crack * 0.55;
      h -= seam * 0.6;
      h -= stain * 0.05;

      let rgh = 0.78 + fine * 0.08 - stain * 0.12 - seam * 0.05;
      const met = 0.0;
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.35, 0.98), met, emi: 0 };
    },

    /** Industrial ribbed steel wall with rivet rows and rust bleed. */
    metalplate(x, y, o) {
      const base = o.col || C(96, 104, 116);
      const fine = fbm(x, y, { grid: 40, octaves: 3 });
      const brush = fbm(x * 8, y * 0.35, { grid: 16, octaves: 3 });
      // vertical ribs
      const ribT = Math.abs(((x * 4) % 1) - 0.5) * 2; // 0 at rib centre
      const rib = smoothstep(0.85, 0.2, ribT);
      // rivets at rib edges
      const rx = ((x * 4) % 1) - 0.5;
      const ry = ((y * 8) % 1) - 0.5;
      const rivetD = Math.sqrt((Math.abs(rx) - 0.42) ** 2 * 6 + ry * ry * 2.2);
      const rivet = smoothstep(0.1, 0.02, rivetD);
      // panel gaps
      const gap = Math.max(
        smoothstep(0.02, 0.0, Math.abs(((x * 2) % 1) - 0.5) - 0.485),
        smoothstep(0.02, 0.0, Math.abs(((y * 2) % 1) - 0.5) - 0.485)
      );
      const rustN = smoothstep(0.35, 0.9, fbm(x + 0.13, y * 1.7, { grid: 6, octaves: 5 })) *
        smoothstep(0.9, 0.2, y);

      let c = scaleRGB(base, 0.78 + fine * 0.14 + brush * 0.16 + rib * 0.1 + rivet * 0.18);
      c = mixRGB(c, C(104, 58, 30), rustN * 0.75);
      c = scaleRGB(c, grime(x, y, 0.22, 9));
      c = scaleRGB(c, 1 - gap * 0.55);

      let h = 0.5 + rib * 0.22 + rivet * 0.3 + fine * 0.03;
      h -= gap * 0.7;
      h -= rustN * 0.06;

      const rgh = 0.42 + fine * 0.12 + rustN * 0.42 - rib * 0.08;
      const met = clamp(0.85 - rustN * 0.7 + fine * 0.05, 0, 1);
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.2, 0.98), met, emi: 0 };
    },

    /** Dark brushed gunmetal (weapons, machinery, props). */
    gunmetal(x, y, o) {
      const base = o.col || C(58, 62, 70);
      const fine = fbm(x, y, { grid: 48, octaves: 3 });
      const brush = fbm(x * 14 + 0.2, y * 0.5, { grid: 22, octaves: 2 });
      const scratch = smoothstep(0.72, 0.95, ridged(x * 0.7, y * 2.1, { grid: 14, octaves: 3 }));
      const wear = smoothstep(0.4, 0.95, fbm(x * 1.9, y * 1.3, { grid: 5, octaves: 4 }));

      let c = scaleRGB(base, 0.8 + fine * 0.15 + brush * 0.2 + scratch * 0.45);
      c = mixRGB(c, C(150, 154, 162), wear * 0.18 + scratch * 0.3);
      let h = 0.5 + fine * 0.05 - scratch * 0.25 + brush * 0.02;
      const rgh = 0.3 + brush * 0.14 + scratch * 0.3 + wear * 0.12;
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.15, 0.85), met: 0.92, emi: 0 };
    },

    /** Glossy laboratory floor tiles with grout lines and chips. */
    tiles(x, y, o) {
      const base = o.col || C(88, 96, 104);
      const gx = (x * 4) % 1;
      const gy = (y * 4) % 1;
      const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
      const grout = smoothstep(0.055, 0.012, edge);
      const chip = smoothstep(0.62, 0.9, ridged(x, y, { grid: 20, octaves: 4 })) *
        smoothstep(0.2, 0.0, edge);
      const marble = fbm(x, y, { grid: 6, octaves: 5 });
      const sheen = fbm(x + 0.7, y + 0.31, { grid: 3, octaves: 3 });
      const dirt = smoothstep(0.45, 1.0, fbm(x - 0.2, y + 0.4, { grid: 4, octaves: 4 }));

      let c = scaleRGB(base, 0.86 + marble * 0.2 + sheen * 0.12);
      c = mixRGB(c, C(38, 40, 44), grout);
      c = mixRGB(c, C(70, 74, 80), chip * 0.8);
      c = mixRGB(c, C(52, 50, 46), dirt * 0.22 * (1 - grout));
      let h = 0.7 + marble * 0.04 - grout * 0.7 - chip * 0.25;
      const rgh = 0.16 + sheen * 0.1 + grout * 0.55 + dirt * 0.3 + chip * 0.25;
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.05, 0.95), met: 0.05, emi: 0 };
    },

    /** Diamond-plate catwalk steel. */
    diamond(x, y, o) {
      const base = o.col || C(86, 90, 98);
      const fine = fbm(x, y, { grid: 44, octaves: 3 });
      // two diagonal lattices of raised bars
      const u = (x + y) * 6;
      const v = (x - y) * 6;
      const bar = (t) => {
        const f = ((t % 1) + 1) % 1;
        const d = Math.abs(f - 0.5) * 2;
        const len = ((Math.floor(t) % 2) + 2) % 2; // alternate offsets
        return smoothstep(0.55, 0.35, d) * (len ? 1 : 0.85);
      };
      const db = Math.max(bar(u), bar(v * 1.0 + 0.37));
      const pit = worley(x, y, 26, 0.9);
      const rust = smoothstep(0.5, 1.0, fbm(x + 0.4, y - 0.2, { grid: 5, octaves: 4 }));

      let c = scaleRGB(base, 0.72 + fine * 0.16 + db * 0.28);
      c = mixRGB(c, C(112, 66, 38), rust * 0.5);
      if (pit.d1 < 0.03) c = scaleRGB(c, 0.7);
      const h = 0.45 + db * 0.42 + fine * 0.03 - (pit.d1 < 0.03 ? 0.2 : 0);
      const rgh = 0.5 + fine * 0.15 - db * 0.18 + rust * 0.4;
      const met = clamp(0.9 - rust * 0.6, 0, 1);
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.2, 0.95), met, emi: 0 };
    },

    /** Heavy rust / corroded barrel surface. */
    rust(x, y, o) {
      const base = o.col || C(112, 58, 30);
      const pit = worley(x, y, 34, 1.0, 7);
      const deep = smoothstep(0.5, 0.15, pit.d1);
      const flake = fbm(x, y, { grid: 9, octaves: 5 });
      const stage = smoothstep(0.3, 0.85, fbm(x + 0.23, y + 0.61, { grid: 4, octaves: 4 }));

      let c = mixRGB(C(92, 48, 26), C(146, 86, 44), flake * 0.5 + 0.4);
      c = mixRGB(c, C(58, 34, 20), deep * 0.7);
      c = mixRGB(c, C(168, 128, 76), stage * 0.35);
      const h = 0.55 + flake * 0.2 - deep * 0.45;
      const rgh = 0.72 + flake * 0.18 + deep * 0.1;
      const met = clamp(0.55 - stage * 0.4 + deep * 0.3, 0, 1);
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.5, 1), met, emi: 0 };
    },

    /** Diagonal hazard warning paint on metal. */
    hazard(x, y, o) {
      const base = o.col || C(38, 40, 44);
      const fine = fbm(x, y, { grid: 40, octaves: 3 });
      const t = ((x + y) * 4) % 1;
      const band = t < 0.5 ? 1 : 0;
      const chipN = ridged(x * 1.3, y * 1.3, { grid: 12, octaves: 4 });
      const chip = smoothstep(0.72, 0.92, chipN);
      const paint = band * (1 - chip);
      const dirt = smoothstep(0.5, 1.0, fbm(x - 0.3, y + 0.8, { grid: 5, octaves: 4 }));

      let c = mixRGB(scaleRGB(base, 0.85 + fine * 0.2), C(224, 176, 40), paint);
      c = mixRGB(c, C(96, 84, 40), chip * 0.6);
      c = scaleRGB(c, 1 - dirt * 0.25);
      const h = 0.5 + fine * 0.04 - chip * 0.18;
      const rgh = 0.42 + fine * 0.1 + dirt * 0.35 - paint * 0.12;
      const met = clamp(0.65 - paint * 0.55, 0, 1);
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.2, 0.95), met, emi: 0 };
    },

    /** Supply crate: painted wood/plastic shell, brackets, stencil label. */
    crate(x, y, o) {
      const base = o.col || C(78, 92, 74);
      const grain = fbm(x * 1.2, y * 0.25, { grid: 12, octaves: 4 });
      const fine = fbm(x, y, { grid: 36, octaves: 3 });
      const scrub = smoothstep(0.6, 0.95, ridged(x, y * 2, { grid: 16, octaves: 3 }));
      // frame brackets near the tile border
      const ex = Math.min(x, 1 - x);
      const ey = Math.min(y, 1 - y);
      const bracket = smoothstep(0.075, 0.05, Math.min(ex, ey));
      // stencilled diagonal stripe + block label
      const label = (x > 0.18 && x < 0.62 && y > 0.3 && y < 0.44) ||
        (x > 0.18 && x < 0.42 && y > 0.5 && y < 0.58) ? 1 : 0;
      const arrow = Math.abs(y - 0.72) < 0.03 && x > 0.2 && x < 0.7 ? 1 : 0;

      let c = scaleRGB(base, 0.8 + grain * 0.2 + fine * 0.1);
      c = mixRGB(c, C(150, 160, 150), label * 0.55 + arrow * 0.5);
      c = mixRGB(c, C(52, 56, 58), bracket);
      c = scaleRGB(c, grime(x, y, 0.2, 8));
      c = mixRGB(c, C(120, 118, 110), scrub * 0.25);
      const h = 0.55 + grain * 0.05 + bracket * 0.3 + label * 0.02 + fine * 0.03 - scrub * 0.06;
      const rgh = 0.62 + grain * 0.12 - label * 0.1 + scrub * 0.2;
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.3, 0.95), met: 0.12, emi: 0 };
    },

    /** Emissive energy floor panel / reactor housing. */
    energy(x, y, o) {
      const tint = o.col || C(0, 210, 255);
      const fine = fbm(x, y, { grid: 44, octaves: 3 });
      const ex = Math.min(x, 1 - x);
      const ey = Math.min(y, 1 - y);
      const frame = smoothstep(0.1, 0.06, Math.min(ex, ey));
      const cellT = Math.abs((((x * 3) % 1) - 0.5) * 2);
      const cellT2 = Math.abs((((y * 3) % 1) - 0.5) * 2);
      const cell = smoothstep(0.85, 0.6, Math.max(cellT, cellT2));
      const vein = smoothstep(0.55, 0.95, ridged(x * 1.7, y * 1.7, { grid: 7, octaves: 4 }));
      const pulse = 0.55 + 0.45 * smoothstep(0.2, 0.9, fbm(x - 0.5, y + 0.5, { grid: 2, octaves: 2 }) + 0.5);

      const glow = (1 - frame) * (0.35 + cell * 0.5 + vein * 0.5) * pulse;
      let c = scaleRGB(C(26, 30, 36), 0.9 + fine * 0.2);
      c = addRGB(c, scaleRGB(tint, glow * 0.85));
      const h = 0.6 - frame * 0.45 + fine * 0.05 + vein * 0.1;
      const rgh = 0.3 + fine * 0.12 - glow * 0.15;
      const emi = clamp(glow, 0, 1);
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.15, 0.8), met: 0.4, emi };
    },

    /** Server-rack front: LEDs, slots, cable mess. */
    circuit(x, y, o) {
      const tint = o.col || C(0, 255, 180);
      const fine = fbm(x, y, { grid: 48, octaves: 3 });
      const rowT = ((y * 8) % 1);
      const slot = smoothstep(0.08, 0.0, Math.abs(rowT - 0.5) - 0.42);
      const ledRng = makeRng(Math.floor(x * 64) * 7919 + Math.floor(y * 64) * 104729);
      const led = ledRng() > 0.93 ? 1 : ledRng() > 0.8 ? 0.35 : 0.06;
      const ledCol = ledRng() > 0.7 ? C(255, 90, 60) : tint;
      const vent = smoothstep(0.02, 0.0, Math.abs(((x * 24) % 1) - 0.5) - 0.4) *
        smoothstep(0.16, 0.1, Math.abs(rowT - 0.5));

      let c = scaleRGB(C(24, 27, 32), 0.85 + fine * 0.25);
      c = scaleRGB(c, 1 - slot * 0.5);
      c = addRGB(c, scaleRGB(ledCol, led * 1.1));
      c = scaleRGB(c, 1 - vent * 0.35);
      const h = 0.5 + fine * 0.05 - slot * 0.5 - vent * 0.3 + led * 0.1;
      const rgh = 0.4 + fine * 0.15 - led * 0.2;
      const emi = clamp(led * 1.0 + vent * 0.05, 0, 1);
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.2, 0.85), met: 0.5, emi };
    },

    /** Alien/organic hide for the hostile creatures. */
    organic(x, y, o) {
      const base = o.col || C(78, 58, 92);
      const veins = ridged(x * 1.1, y * 0.9, { grid: 6, octaves: 5 });
      const vein = smoothstep(0.72, 0.98, veins);
      const wart = worley(x, y, 22, 0.95, 11);
      const bump = smoothstep(0.12, 0.0, wart.d1);
      const mottle = fbm(x + 0.3, y - 0.6, { grid: 8, octaves: 4 });
      const slime = smoothstep(0.45, 0.95, fbm(x * 1.5, y * 1.5, { grid: 4, octaves: 4 }));

      let c = scaleRGB(base, 0.75 + mottle * 0.25 + bump * 0.3);
      c = mixRGB(c, scaleRGB(base, 1.9), vein * 0.55);
      c = mixRGB(c, scaleRGB(base, 0.45), slime * 0.4);
      const h = 0.5 + bump * 0.35 + vein * 0.22 + mottle * 0.05;
      const rgh = 0.45 + slime * 0.35 - vein * 0.15 + bump * 0.1;
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.2, 0.9), met: 0.05, emi: 0 };
    },

    /** Grating / vent slats with real depth and a dark void behind. */
    grating(x, y, o) {
      const base = o.col || C(74, 78, 84);
      const fine = fbm(x, y, { grid: 40, octaves: 3 });
      const slat = ((y * 8) % 1);
      const inSlat = slat < 0.58 ? 1 : 0;
      const barX = ((x * 24) % 1);
      const crossBar = barX < 0.16 ? 1 : 0;
      const gap = inSlat && !crossBar ? 0 : 1;

      let c = gap ? scaleRGB(C(10, 11, 13), 0.8 + fine * 0.4)
        : scaleRGB(base, 0.8 + fine * 0.25);
      const h = gap ? 0.05 + fine * 0.03 : 0.72 + fine * 0.05;
      const rgh = gap ? 0.95 : 0.4 + fine * 0.15;
      const met = gap ? 0.1 : 0.85;
      return { rgb: c, h: clamp(h), rgh: clamp(rgh, 0.1, 1), met, emi: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// height -> normal / AO derivation -----------------------------------------
// ---------------------------------------------------------------------------
function heightToNormal(height, size, strength = 2.4) {
  const out = new Uint8ClampedArray(size * size * 4);
  const sx = 1.0 / size;
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // sobel gradient
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength * sx * size;
      let ny = -dy * strength * sx * size;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255; // OpenGL-style (+Y up)
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return new Uint8Array(out.buffer);
}

function heightToAO(height, size, radius = 3, strength = 0.9) {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = at(x, y);
      let occ = 0;
      let n = 0;
      for (let oy = -radius; oy <= radius; oy += radius) {
        for (let ox = -radius; ox <= radius; ox += radius) {
          if (!ox && !oy) continue;
          occ += Math.max(0, at(x + ox, y + oy) - c);
          n++;
        }
      }
      const ao = clamp(1 - (occ / Math.max(1, n)) * strength * 2.0, 0.25, 1);
      const i = (y * size + x) * 4;
      const v = ao * 255;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return new Uint8Array(out.buffer);
}

// ---------------------------------------------------------------------------
// construction --------------------------------------------------------------
// ---------------------------------------------------------------------------
function dataTexture(data, size, colorSpace) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = colorSpace || THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = MAX_ANISO;
  t.needsUpdate = true;
  return t;
}

function finalize(tex) {
  if (tex.map) tex.map.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Build one material from a pattern function.
 * opts: { size, strength, ao, roughBias, metalScale, colorSpaceNoise, name }
 */
export function buildMaterial(patternName, opts = {}) {
  const patterns = makePatterns();
  const fn = patterns[patternName];
  if (!fn) throw new Error('unknown pattern ' + patternName);
  const size = opts.size || SIZE;
  const inv = 1 / size;

  const albedo = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const rough = new Uint8ClampedArray(size * size * 4);
  let metalSum = 0;
  let emiSum = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const r = fn((x + 0.5) * inv, (y + 0.5) * inv, opts);
      const o = i * 4;
      const cr = r.rgb[0] !== undefined ? r.rgb : [1, 1, 1];
      const c = cr.length === 4 ? cr.slice(0, 3) : cr;
      albedo[o] = clamp(c[0]) * 255;
      albedo[o + 1] = clamp(c[1]) * 255;
      albedo[o + 2] = clamp(c[2]) * 255;
      albedo[o + 3] = 255;
      height[i] = r.h;
      const rv = clamp((r.rgh + (opts.roughBias || 0))) * 255;
      rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
      metalSum += r.met;
      emiSum += r.emi || 0;
    }
  }

  const tex = {};
  tex.map = dataTexture(new Uint8Array(albedo.buffer), size, THREE.SRGBColorSpace);
  tex.normalMap = dataTexture(heightToNormal(height, size, opts.strength || 2.6), size);
  tex.roughnessMap = dataTexture(new Uint8Array(rough.buffer), size);
  if (opts.ao !== false) tex.aoMap = dataTexture(heightToAO(height, size, opts.aoRadius || 3, opts.aoStrength || 0.85), size);

  const params = {
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    metalness: clamp((metalSum / (size * size)) * (opts.metalScale ?? 1)),
    roughness: 1.0,
    normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
  };
  if (tex.aoMap) {
    params.aoMap = tex.aoMap;
    params.aoMapIntensity = opts.aoIntensity ?? 0.85;
  }
  if (emiSum > 0) {
    params.emissive = new THREE.Color(0xffffff);
    params.emissiveMap = tex.map;
    params.emissiveIntensity = opts.emissiveIntensity ?? 1.6;
  }
  if (opts.transparent) { params.transparent = true; params.opacity = opts.opacity ?? 1; }
  if (opts.side) params.side = opts.side;
  if (opts.color) params.color = new THREE.Color(opts.color);

  tex.material = new THREE.MeshStandardMaterial(params);
  tex.material.userData.pattern = patternName;
  return finalize(tex);
}

/** Returns a THREE.MeshStandardMaterial from a pattern, with tiling applied. */
export function makeMaterial(patternName, { repeat = [1, 1], rotation = 0, ...opts } = {}) {
  const tex = buildMaterial(patternName, opts);
  const rx = repeat[0];
  const ry = repeat[1] ?? repeat[0];
  for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
    const t = tex[key];
    if (!t) continue;
    t.repeat.set(rx, ry);
    if (rotation) t.center.set(0.5, 0.5), (t.rotation = rotation);
    t.needsUpdate = true;
  }
  tex.material.userData.uvRepeat = [rx, ry];
  return tex.material;
}

// ---------------------------------------------------------------------------
// sprite / decal textures ---------------------------------------------------
// ---------------------------------------------------------------------------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function radialSprite(size, stops, power = 1) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const d = clamp(Math.pow(Math.sqrt(dx * dx + dy * dy), power));
      let col = [0, 0, 0, 0];
      for (let i = 0; i < stops.length - 1; i++) {
        const [p0, c0] = stops[i];
        const [p1, c1] = stops[i + 1];
        if (d >= p0 && d <= p1) {
          const t = (d - p0) / Math.max(1e-6, p1 - p0);
          col = [
            lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t),
            lerp(c0[2], c1[2], t), lerp(c0[3] ?? 1, c1[3] ?? 1, t),
          ];
          break;
        }
      }
      const o = (y * size + x) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2];
      img.data[o + 3] = (col[3] ?? 1) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function toTexture(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = MAX_ANISO;
  t.needsUpdate = true;
  return t;
}

export function makeSpriteTextures() {
  const out = {};

  out.spark = toTexture(radialSprite(64, [
    [0, [255, 255, 245, 1]], [0.25, [255, 214, 130, 0.95]],
    [0.6, [255, 120, 30, 0.35]], [1, [120, 30, 0, 0]],
  ]));

  out.smoke = (() => {
    const size = 128;
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    const N = makeValueNoise(4242);
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size, ny = y / size;
        const dx = (nx - 0.5) * 2, dy = (ny - 0.5) * 2;
        const d = Math.sqrt(dx * dx + dy * dy);
        const n = N.fbm(nx, ny, { grid: 5, octaves: 4 }) * 0.5 + 0.5;
        const a = clamp(smoothstep(1.05, 0.15, d) * (0.45 + n * 0.75));
        const o = (y * size + x) * 4;
        img.data[o] = 190; img.data[o + 1] = 196; img.data[o + 2] = 210;
        img.data[o + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c);
  })();

  out.flash = (() => {
    const size = 128;
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,242,190,0.95)');
    g.addColorStop(0.45, 'rgba(255,168,60,0.45)');
    g.addColorStop(1, 'rgba(255,120,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // star flares
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(size / 2, size / 2);
    for (let i = 0; i < 6; i++) {
      ctx.rotate(Math.PI / 3);
      const lg = ctx.createLinearGradient(-size / 2, 0, size / 2, 0);
      lg.addColorStop(0, 'rgba(255,200,120,0)');
      lg.addColorStop(0.5, 'rgba(255,240,200,0.5)');
      lg.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(-size / 2, -1.6, size, 3.2);
    }
    return toTexture(c);
  })();

  out.blood = (() => {
    const size = 128;
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    const N = makeValueNoise(777);
    const rng = makeRng(31337);
    ctx.clearRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    for (let i = 0; i < 16; i++) {
      const a = rng() * Math.PI * 2;
      const r = 8 + rng() * 42;
      const rad = 6 + rng() * 22;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(150,16,22,0.95)');
      g.addColorStop(0.7, 'rgba(104,8,14,0.8)');
      g.addColorStop(1, 'rgba(60,4,8,0)');
      ctx.fillStyle = g;
      ctx.fill();
    }
    // droplets
    for (let i = 0; i < 40; i++) {
      const a = rng() * Math.PI * 2;
      const r = 20 + rng() * 44;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 1 + rng() * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${120 + rng() * 40 | 0},10,16,${0.4 + rng() * 0.5})`;
      ctx.fill();
    }
    return toTexture(c);
  })();

  out.scorch = (() => {
    const size = 128;
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    const N = makeValueNoise(555);
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size, ny = y / size;
        const dx = (nx - 0.5) * 2, dy = (ny - 0.5) * 2;
        const d = Math.sqrt(dx * dx + dy * dy);
        const n = N.fbm(nx, ny, { grid: 7, octaves: 4 }) * 0.5 + 0.5;
        const a = clamp(smoothstep(1.0, 0.1, d + n * 0.25 - 0.12));
        const o = (y * size + x) * 4;
        const v = 12 + n * 40;
        img.data[o] = v; img.data[o + 1] = v * 0.95; img.data[o + 2] = v * 0.9;
        img.data[o + 3] = a * 210;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c);
  })();

  out.ring = (() => {
    const size = 128;
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.75, 'rgba(180,230,255,0.5)');
    g.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return toTexture(c);
  })();

  out.slash = (() => {
    const size = 128;
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-0.5);
    const g = ctx.createLinearGradient(-60, 0, 60, 0);
    g.addColorStop(0, 'rgba(255,80,60,0)');
    g.addColorStop(0.45, 'rgba(255,220,180,0.95)');
    g.addColorStop(0.55, 'rgba(255,120,90,0.9)');
    g.addColorStop(1, 'rgba(255,60,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-64, -6); ctx.lineTo(64, -2); ctx.lineTo(64, 2); ctx.lineTo(-64, 6);
    ctx.closePath();
    ctx.fill();
    return toTexture(c);
  })();

  return out;
}

// ---------------------------------------------------------------------------
// HUD icon / UI textures (small, drawn with canvas 2D) ----------------------
// ---------------------------------------------------------------------------
export function makeUITexture(kind) {
  const s = 128;
  const c = canvas(s, s);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';

  const neon = (a = 1) => `rgba(90,240,255,${a})`;
  switch (kind) {
    case 'health':
      ctx.fillStyle = neon(0.95);
      ctx.beginPath();
      ctx.moveTo(64, 108);
      ctx.bezierCurveTo(8, 68, 22, 22, 52, 26);
      ctx.bezierCurveTo(62, 27, 64, 38, 64, 42);
      ctx.bezierCurveTo(64, 38, 66, 27, 76, 26);
      ctx.bezierCurveTo(106, 22, 120, 68, 64, 108);
      ctx.fill();
      break;
    case 'armor':
      ctx.strokeStyle = neon(0.95);
      ctx.fillStyle = 'rgba(90,240,255,0.22)';
      ctx.beginPath();
      ctx.moveTo(64, 14);
      ctx.lineTo(110, 34);
      ctx.lineTo(102, 88);
      ctx.lineTo(64, 116);
      ctx.lineTo(26, 88);
      ctx.lineTo(18, 34);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      break;
    case 'ammo':
      ctx.fillStyle = neon(0.95);
      for (let i = 0; i < 3; i++) {
        const x = 30 + i * 26;
        ctx.beginPath();
        ctx.roundRect?.(x, 40, 16, 56, 6);
        if (!ctx.roundRect) ctx.rect(x, 40, 16, 56);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, 40); ctx.lineTo(x + 8, 20); ctx.lineTo(x + 16, 40);
        ctx.closePath(); ctx.fill();
      }
      break;
    case 'skull':
      ctx.fillStyle = 'rgba(255,90,90,0.95)';
      ctx.beginPath(); ctx.arc(64, 56, 34, Math.PI, 0); ctx.fill();
      ctx.fillRect(30, 56, 68, 26);
      ctx.fillStyle = '#0b0e13';
      ctx.beginPath(); ctx.arc(50, 52, 10, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(78, 52, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(56, 74, 6, 14); ctx.fillRect(68, 74, 6, 14);
      break;
    case 'credit':
      ctx.strokeStyle = 'rgba(255,215,90,0.95)';
      ctx.fillStyle = 'rgba(255,215,90,0.2)';
      ctx.beginPath(); ctx.arc(64, 64, 42, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,215,90,0.95)';
      ctx.font = 'bold 58px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('C', 64, 68);
      break;
  }
  return toTexture(c);
}

export const TEXTURE_SIZE = SIZE;
