/**
 * WORK token economy logic.
 * Handles build rewards, tile yields, costs, and land claims.
 */

const Building = require('../models/Building');

class Economy {
  /**
   * Calculate WORK reward for completing a building.
   * Diminishing returns based on how many of that type already exist.
   * @param {string} buildingType - Building catalog key
   * @param {number} existingCount - How many of this type are already built
   * @returns {number} WORK reward
   */
  static buildReward(buildingType, existingCount = 0) {
    const info = Building.CATALOG[buildingType];
    if (!info) return 0;

    let baseReward;
    switch (info.tier) {
      case 1: baseReward = 2; break;
      case 2: baseReward = 8; break;
      case 3: baseReward = 30; break;
      default: baseReward = 1;
    }

    // Diminishing returns: reward * (1 / sqrt(count + 1))
    const diminish = 1 / Math.sqrt(Math.max(1, existingCount + 1));
    return parseFloat((baseReward * diminish).toFixed(4));
  }

  /**
   * Get WORK yield per tick for a biome.
   * @param {string} biome
   * @returns {number} WORK per tick
   */
  static tileYield(biome) {
    const yields = {
      deep_water:    0,
      shallow_water: 0.005,
      river:         0.005,
      sand:          0.008,
      grassland:     0.01,
      forest:        0.015,
      dense_forest:  0.02,
      hills:         0.03,
      mountain:      0.05,
      snow:          0.02,
      gold_vein:     0.08,
    };
    return yields[biome] || 0.01;
  }

  /**
   * Get WORK cost to construct a building.
   * @param {string} buildingType
   * @returns {number} WORK cost
   */
  static buildCost(buildingType) {
    const info = Building.CATALOG[buildingType];
    if (!info) return Infinity;
    return info.workCost;
  }

  /**
   * Get ETH cost (in-game currency units) to claim land on a biome.
   * @param {string} biome
   * @returns {number} ETH cost
   */
  static landClaimCost(biome) {
    const costs = {
      deep_water:    0,       // can't claim
      shallow_water: 0,       // can't claim
      river:         0,       // can't claim
      sand:          0.001,
      grassland:     0.002,
      forest:        0.003,
      dense_forest:  0.004,
      hills:         0.005,
      mountain:      0.008,
      snow:          0.003,
      gold_vein:     0.02,
    };
    return costs[biome] || 0.002;
  }

  /**
   * Check if a biome can be claimed.
   * @param {string} biome
   * @returns {boolean}
   */
  static isClaimable(biome) {
    return !['deep_water', 'shallow_water', 'river'].includes(biome);
  }

  /**
   * Calculate total WORK emissions for a tick given owned tiles.
   * @param {Array} ownedTiles - Array of tile objects with biome
   * @returns {number} Total WORK earned this tick
   */
  static calculateTickEmissions(ownedTiles) {
    let total = 0;
    for (const tile of ownedTiles) {
      total += Economy.tileYield(tile.biome);
    }
    return parseFloat(total.toFixed(6));
  }

  /**
   * Calculate building yield bonuses for resources.
   * @param {Array} buildings - Array of Building instances
   * @returns {{ food: number, wood: number, stone: number, gold: number }}
   */
  static calculateBuildingYields(buildings) {
    const totals = { food: 0, wood: 0, stone: 0, gold: 0 };
    for (const b of buildings) {
      if (b.isComplete()) {
        totals.food += b.yields.food;
        totals.wood += b.yields.wood;
        totals.stone += b.yields.stone;
        totals.gold += b.yields.gold;
      }
    }
    return totals;
  }
}

module.exports = Economy;
