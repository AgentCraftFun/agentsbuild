/**
 * Seedable Perlin noise implementation (no dependencies).
 * Produces deterministic noise for world generation.
 */

class SeededRNG {
  constructor(seed) {
    this.seed = seed;
  }

  next() {
    // xorshift32
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >> 17;
    this.seed ^= this.seed << 5;
    return ((this.seed >>> 0) / 4294967296);
  }
}

// Permutation table (256 entries, doubled for wrapping)
let perm = null;
let currentSeed = null;

function initPerm(seed) {
  if (currentSeed === seed && perm) return;
  currentSeed = seed;
  const rng = new SeededRNG(seed);
  const p = new Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates shuffle
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  perm = new Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}

// Gradient vectors for 2D Perlin noise
const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

function dot2(g, x, y) {
  return g[0] * x + g[1] * y;
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + t * (b - a);
}

/**
 * 2D Perlin noise. Returns value between 0 and 1.
 */
function noise2D(x, y, seed = 42) {
  initPerm(seed);

  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;

  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);

  const u = fade(xf);
  const v = fade(yf);

  const aa = perm[perm[X] + Y];
  const ab = perm[perm[X] + Y + 1];
  const ba = perm[perm[X + 1] + Y];
  const bb = perm[perm[X + 1] + Y + 1];

  const g00 = GRAD2[aa % 8];
  const g10 = GRAD2[ba % 8];
  const g01 = GRAD2[ab % 8];
  const g11 = GRAD2[bb % 8];

  const n00 = dot2(g00, xf, yf);
  const n10 = dot2(g10, xf - 1, yf);
  const n01 = dot2(g01, xf, yf - 1);
  const n11 = dot2(g11, xf - 1, yf - 1);

  const nx0 = lerp(n00, n10, u);
  const nx1 = lerp(n01, n11, u);
  const value = lerp(nx0, nx1, v);

  // Normalize from [-1,1] to [0,1]
  return (value + 1) * 0.5;
}

/**
 * Fractional Brownian Motion (fBm) for terrain generation.
 * Returns value between 0 and 1.
 */
function fbm(x, y, octaves = 6, lacunarity = 2, gain = 0.5, seed = 42) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxAmplitude = 0;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise2D(x * frequency, y * frequency, seed);
    maxAmplitude += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return value / maxAmplitude;
}

module.exports = { noise2D, fbm, SeededRNG };
