/**
 * WebSocket broadcast utilities.
 */

const WebSocket = require('ws');

/**
 * Broadcast a typed message to all connected clients.
 * @param {WebSocket.Server} wss - WebSocket server
 * @param {string} type - Message type
 * @param {object} data - Payload
 */
function broadcast(wss, type, data) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/**
 * Send full world state to a single client.
 * Only sends claimed/built tiles (sparse) plus agents and metadata.
 * @param {WebSocket} ws - Single WebSocket connection
 * @param {object} worldState - Full world state object
 */
function sendWorldState(ws, worldState) {
  if (ws.readyState !== WebSocket.OPEN) return;

  // Build sparse tile list (only claimed or built tiles)
  const sparseTiles = [];
  if (worldState.tiles) {
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
  }

  // Build agent list
  const agents = [];
  if (worldState.agents) {
    for (const agent of worldState.agents.values()) {
      agents.push(agent.toPublicJSON ? agent.toPublicJSON() : agent.toJSON());
    }
  }

  const message = JSON.stringify({
    type: 'world_state',
    data: {
      tick: worldState.tick || 0,
      width: worldState.width || 200,
      height: worldState.height || 150,
      seed: worldState.seed || 42,
      tiles: sparseTiles,
      agents,
      buildings: (worldState.buildingsList || []).map(b => b.toJSON()),
      events: worldState.events ? worldState.events.slice(-50) : [],
      leaderboard: worldState.leaderboard || [],
    },
    timestamp: Date.now(),
  });

  ws.send(message);
}

module.exports = { broadcast, sendWorldState };
