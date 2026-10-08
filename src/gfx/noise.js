/**
 * noise.js — deterministic tileable noise toolkit.
 * Everything the game's textures are made of. No external assets, no downloads.
 *
 * Key property: all patterns are TILEABLE, so we can repeat them across large
 * surfaces without visible seams.
 */

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash-based value noise with a wrap period => seamless tiling. */
export function makeValueNoise(seed) {
  const perm = new Uint8Array(512);
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const grad = new Float32Array(256 * 2);
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    grad[i * 2] = Math.cos(a);
    grad[i * 2 + 1] = Math.sin(a);
  }

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  /** Tileable gradient (Perlin-style) noise. Period is in grid cells. */
  function perlin(x, y, period) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = ((xi % period) + period) % period;
    const Y = ((yi % period) + period) % period;
    const X1 = (X + 1) % period;
    const Y1 = (Y + 1) % period;

    const g00 = (perm[(perm[X & 255] + Y) & 255] & 255) * 2;
    const g10 = (perm[(perm[X1 & 255] + Y) & 255] & 255) * 2;
    const g01 = (perm[(perm[X & 255] + Y1) & 255] & 255) * 2;
    const g11 = (perm[(perm[X1 & 255] + Y1) & 255] & 255) * 2;

    const d00 = grad[g00] * xf + grad[g00 + 1] * yf;
    const d10 = grad[g10] * (xf - 1) + grad[g10 + 1] * yf;
    const d01 = grad[g01] * xf + grad[g01 + 1] * (yf - 1);
    const d11 = grad[g11] * (xf - 1) + grad[g11 + 1] * (yf - 1);

    const u = fade(xf);
    const v = fade(yf);
    const a = d00 + (d10 - d00) * u;
    const b = d01 + (d11 - d01) * u;
    return a + (b - a) * v; // roughly -0.5..0.5
  }

  /**
   * Fractal Brownian motion. `grid` = number of noise cells across the tile
   * for the first octave (must be an integer for seamless tiling).
   * Returns roughly -1..1.
   */
  function fbm(x, y, { grid = 4, octaves = 5, gain = 0.5, lacunarity = 2 } = {}) {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let g = Math.max(1, Math.round(grid));
    for (let o = 0; o < octaves; o++) {
      sum += amp * perlin(x * g, y * g, g);
      norm += amp;
      amp *= gain;
      g = Math.max(1, Math.round(g * lacunarity));
    }
    return (sum / norm) * 2;
  }

  /** Ridged multifractal — great for cracks, veins, worn metal. */
  function ridged(x, y, { grid = 4, octaves = 5, gain = 0.5, lacunarity = 2 } = {}) {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let g = Math.max(1, Math.round(grid));
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(perlin(x * g, y * g, g) * 2);
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      g = Math.max(1, Math.round(g * lacunarity));
    }
    return sum / norm;
  }

  /** Worley / cellular noise, tileable. Returns { d1, d2, id }. */
  function worley(x, y, grid, jitter = 0.9, seedShift = 0) {
    const g = Math.max(1, Math.round(grid));
    const px = x * g;
    const py = y * g;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    let d1 = 1e9;
    let d2 = 1e9;
    let id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;
        const wx = ((gx % g) + g) % g;
        const wy = ((gy % g) + g) % g;
        const h = perm[(perm[(wx + seedShift) & 255] + wy) & 255];
        const jx = ((h * 37) % 251) / 251;
        const jy = ((h * 89) % 253) / 253;
        const fx = gx + 0.5 + (jx - 0.5) * jitter;
        const fy = gy + 0.5 + (jy - 0.5) * jitter;
        const dx = fx - px;
        const dy = fy - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = h;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return { d1: d1 / g, d2: d2 / g, id: id / 255 };
  }

  return { perlin, fbm, ridged, worley, rng, perm };
}

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const mixRGB = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
