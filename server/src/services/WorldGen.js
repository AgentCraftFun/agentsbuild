/**
 * Procedural world generation. Uses the same fBm noise as the viewer
 * to produce deterministic, matching terrain.
 */

const { fbm } = require('../utils/noise');

class WorldGen {
  /**
   * Generate the full world map.
   * @param {number} width - Map width in tiles (default 200)
   * @param {number} height - Map height in tiles (default 150)
   * @param {number} seed - RNG seed (default 42)
   * @returns {Object} - { tiles: Map<string, tile>, width, height, seed }
   */
  static generate(width = 200, height = 150, seed = 42) {
    const tiles = new Map();

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tileId = `${x},${y}`;
        const noiseValue = fbm(x * 0.02, y * 0.02, 6, 2, 0.5, seed);

        // River generation: sinusoidal path
        const isRiver = WorldGen.isRiverTile(x, y, width, height);

        let biome;
        if (isRiver) {
          biome = 'river';
        } else {
          biome = WorldGen.getBiome(noiseValue);
        }

        tiles.set(tileId, {
          x,
          y,
          tileId,
          biome,
          noiseValue,
          owner: null,
          building: null,
        });
      }
    }

    return { tiles, width, height, seed };
  }

  /**
   * Check if a tile is part of a river.
   * Two rivers: one vertical, one horizontal, with sinusoidal wobble.
   */
  static isRiverTile(x, y, width, height) {
    // Vertical river around x = width * 0.45
    const riverX = Math.floor(width * 0.45 + Math.sin(y * 0.08) * 6);
    if (Math.abs(x - riverX) <= 1) return true;

    // Horizontal river around y = height * 0.55
    const riverY = Math.floor(height * 0.55 + Math.sin(x * 0.06) * 5);
    if (Math.abs(y - riverY) <= 1) return true;

    return false;
  }

  /**
   * Map a noise value to a biome string.
   * Thresholds must match the viewer exactly.
   */
  static getBiome(noiseValue) {
    if (noiseValue < 0.25) return 'deep_water';
    if (noiseValue < 0.32) return 'shallow_water';
    if (noiseValue < 0.38) return 'sand';
    if (noiseValue < 0.55) return 'grassland';
    if (noiseValue < 0.62) return 'forest';
    if (noiseValue < 0.70) return 'dense_forest';
    if (noiseValue < 0.78) return 'hills';
    if (noiseValue < 0.85) return 'mountain';
    if (noiseValue < 0.92) return 'snow';
    // Rare gold vein tiles
    return 'gold_vein';
  }

  /**
   * Get resource yields per tick for a biome.
   */
  static getTileYield(biome) {
    const yields = {
      deep_water:    { food: 0,    wood: 0,    stone: 0,    gold: 0,     workPerTick: 0 },
      shallow_water: { food: 0.5,  wood: 0,    stone: 0,    gold: 0,     workPerTick: 0.005 },
      river:         { food: 0.3,  wood: 0,    stone: 0,    gold: 0,     workPerTick: 0.005 },
      sand:          { food: 0,    wood: 0,    stone: 0.5,  gold: 0.1,   workPerTick: 0.008 },
      grassland:     { food: 1,    wood: 0.5,  stone: 0,    gold: 0,     workPerTick: 0.01 },
      forest:        { food: 0.3,  wood: 2,    stone: 0,    gold: 0,     workPerTick: 0.015 },
      dense_forest:  { food: 0.2,  wood: 3,    stone: 0,    gold: 0,     workPerTick: 0.02 },
      hills:         { food: 0.1,  wood: 0.2,  stone: 2,    gold: 0.5,   workPerTick: 0.03 },
      mountain:      { food: 0,    wood: 0,    stone: 3,    gold: 1,     workPerTick: 0.05 },
      snow:          { food: 0,    wood: 0,    stone: 1,    gold: 0.5,   workPerTick: 0.02 },
      gold_vein:     { food: 0,    wood: 0,    stone: 0.5,  gold: 5,     workPerTick: 0.08 },
    };
    return yields[biome] || yields.grassland;
  }

  /**
   * Check if a biome is buildable (not water).
   */
  static isBuildable(biome) {
    return !['deep_water', 'shallow_water', 'river'].includes(biome);
  }

  /**
   * Find random tiles matching a biome filter.
   */
  static findTiles(worldTiles, biomeFn, count = 1) {
    const candidates = [];
    for (const tile of worldTiles.values()) {
      if (biomeFn(tile.biome)) candidates.push(tile);
    }
    const results = [];
    for (let i = 0; i < count && candidates.length > 0; i++) {
      const idx = Math.floor(Math.random() * candidates.length);
      results.push(candidates.splice(idx, 1)[0]);
    }
    return results;
  }
}

module.exports = WorldGen;
