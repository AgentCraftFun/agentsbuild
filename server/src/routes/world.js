/**
 * Express router for world state endpoints.
 */

const { Router } = require('express');

function createWorldRouter(worldState) {
  const router = Router();

  // Cache biome map (terrain never changes after generation)
  let _cachedBiomeResponse = null;

  /**
   * GET /api/world/state
   * Full world snapshot (sparse - only claimed/built tiles).
   */
  router.get('/state', (req, res) => {
    const sparseTiles = [];
    for (const tile of worldState.tiles.values()) {
      if (tile.owner || tile.building) {
        sparseTiles.push({
          x: tile.x,
          y: tile.y,
          tileId: tile.tileId,
          biome: tile.biome,
          owner: tile.owner,
          building: tile.building ? tile.building.toJSON() : null,
        });
      }
    }

    const agents = [];
    for (const agent of worldState.agents.values()) {
      agents.push(agent.toPublicJSON ? agent.toPublicJSON() : agent.toJSON());
    }

    res.json({
      tick: worldState.tick || 0,
      width: worldState.width || 200,
      height: worldState.height || 150,
      seed: worldState.seed || 42,
      tiles: sparseTiles,
      agents,
      buildings: (worldState.buildingsList || []).map(b => b.toJSON()),
      leaderboard: worldState.leaderboard || [],
    });
  });

  /**
   * GET /api/world/leaderboard
   * Agents sorted by territory score.
   */
  router.get('/leaderboard', (req, res) => {
    const entries = [];
    for (const agent of worldState.agents.values()) {
      const completedBuildings = agent.buildings.filter(b => b.isComplete()).length;
      const territory = agent.owned_tiles.length;
      const score = territory * 10 + completedBuildings * 25 + agent.work_balance;
      entries.push({
        rank: 0,
        id: agent.id,
        name: agent.name,
        faction: agent.faction,
        personality: agent.personality,
        territory,
        buildings: completedBuildings,
        total_buildings: agent.buildings.length,
        work_balance: parseFloat(agent.work_balance.toFixed(4)),
        resources: { ...agent.resources },
        score: parseFloat(score.toFixed(2)),
        mood: agent.mood,
        message: agent.message,
      });
    }
    entries.sort((a, b) => b.score - a.score);
    entries.forEach((e, i) => { e.rank = i + 1; });

    res.json({ leaderboard: entries, tick: worldState.tick || 0 });
  });

  /**
   * GET /api/world/events?limit=50
   * Recent event feed entries.
   */
  router.get('/events', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const events = worldState.events || [];
    const recent = events.slice(-limit);

    res.json({
      events: recent,
      total: events.length,
      tick: worldState.tick || 0,
    });
  });

  /**
   * GET /api/world/map
   * Full map data (all tiles with biomes). Large payload.
   * Use ?sparse=true to only get claimed/built tiles.
   */
  router.get('/map', (req, res) => {
    if (req.query.sparse === 'true') {
      const tiles = [];
      for (const tile of worldState.tiles.values()) {
        if (tile.owner || tile.building) {
          tiles.push({
            x: tile.x,
            y: tile.y,
            tileId: tile.tileId,
            biome: tile.biome,
            owner: tile.owner,
            building: tile.building ? tile.building.toJSON() : null,
          });
        }
      }
      return res.json({ tiles, width: worldState.width, height: worldState.height });
    }

    // Full map: send biome data as a flat array for efficiency (cached — terrain is static)
    if (!_cachedBiomeResponse) {
      const biomes = [];
      for (let y = 0; y < worldState.height; y++) {
        for (let x = 0; x < worldState.width; x++) {
          const tile = worldState.tiles.get(`${x},${y}`);
          biomes.push(tile ? tile.biome : 'grassland');
        }
      }
      _cachedBiomeResponse = JSON.stringify({
        width: worldState.width,
        height: worldState.height,
        seed: worldState.seed,
        biomes,
      });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(_cachedBiomeResponse);
  });

  return router;
}

module.exports = createWorldRouter;
