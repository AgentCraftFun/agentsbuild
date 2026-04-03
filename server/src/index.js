/**
 * Agents at Work - Game Server
 * Main entry point. Sets up Express + WebSocket server.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');

const WorldGen = require('./services/WorldGen');
const GameLoop = require('./services/GameLoop');
const LLMBrain = require('./services/LLMBrain');
const { seedAgents } = require('./seed');
const { sendWorldState } = require('./ws/broadcast');
const createAgentRouter = require('./routes/agents');
const createWorldRouter = require('./routes/world');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const WORLD_WIDTH = parseInt(process.env.WORLD_WIDTH, 10) || 200;
const WORLD_HEIGHT = parseInt(process.env.WORLD_HEIGHT, 10) || 150;
const WORLD_SEED = parseInt(process.env.WORLD_SEED, 10) || 42;
const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL_MS, 10) || 30000;

const fs = require('fs');
// Use Railway persistent volume if available, otherwise local
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve(__dirname, '..', '..');
const STATE_FILE = path.join(VOLUME_PATH, 'gamestate.json');
console.log(`[Server] State file: ${STATE_FILE}`);
console.log(`[Server] Volume mount: ${process.env.RAILWAY_VOLUME_MOUNT_PATH || 'none (using local)'}`);

// ─── Persistent State: Save/Load to disk ───

function saveWorldState(ws) {
  try {
    const agents = [];
    for (const agent of ws.agents.values()) {
      agents.push({
        id: agent.id, name: agent.name, faction: agent.faction,
        personality: agent.personality, x: agent.x, y: agent.y,
        wallet_address: agent.wallet_address, api_key: agent.api_key,
        work_balance: agent.work_balance, resources: { ...agent.resources },
        mood: agent.mood, owned_tiles: [...agent.owned_tiles],
        message: agent.message || '', idle_ticks: agent.idle_ticks || 0,
        last_action_tick: agent.last_action_tick || 0,
      });
    }
    const buildings = ws.buildingsList.map(b => b.toJSON());
    const state = {
      version: 1, savedAt: Date.now(), tick: ws.tick,
      seed: ws.seed, width: ws.width, height: ws.height,
      agents, buildings, events: (ws.events || []).slice(-200),
      leaderboard: ws.leaderboard || [],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log(`[Save] Tick:${ws.tick} Agents:${agents.length} Buildings:${buildings.length}`);
  } catch (err) { console.error('[Save] Failed:', err.message); }
}

function loadWorldState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state || !state.version) return null;
    console.log(`[Load] Found saved state. Tick:${state.tick} Agents:${state.agents?.length} Buildings:${state.buildings?.length}`);

    // Regenerate deterministic terrain from seed
    const world = WorldGen.generate(state.width || WORLD_WIDTH, state.height || WORLD_HEIGHT, state.seed || WORLD_SEED);
    const ws = { tiles: world.tiles, width: world.width, height: world.height, seed: world.seed,
      tick: state.tick || 0, agents: new Map(), buildingsList: [], events: state.events || [], leaderboard: state.leaderboard || [] };

    const Agent = require('./models/Agent');
    const Building = require('./models/Building');

    // Restore agents
    for (const ad of (state.agents || [])) {
      try {
        const agent = new Agent({ id: ad.id, name: ad.name, faction: ad.faction, personality: ad.personality,
          x: ad.x, y: ad.y, wallet_address: ad.wallet_address, api_key: ad.api_key,
          work_balance: ad.work_balance || 0, resources: ad.resources || { food: 10, wood: 10, stone: 5, gold: 0 },
          mood: ad.mood || 'idle', owned_tiles: ad.owned_tiles || [], buildings: [],
          message: ad.message || '', idle_ticks: ad.idle_ticks || 0, last_action_tick: ad.last_action_tick || 0 });
        ws.agents.set(agent.id, agent);
      } catch (e) { console.warn(`[Load] Agent ${ad.name} failed:`, e.message); }
    }

    // Restore buildings and re-link to tiles/agents
    for (const bd of (state.buildings || [])) {
      try {
        const building = new Building({ type: bd.type, x: bd.x, y: bd.y, owner: bd.owner, progress: bd.progress || 0, startTick: bd.startTick || 0 });
        if (bd.complete || bd.progress >= 1) building.progress = 1;
        ws.buildingsList.push(building);
        const tileId = `${bd.x},${bd.y}`;
        const tile = ws.tiles.get(tileId);
        if (tile) { tile.building = building; tile.owner = tile.owner || bd.owner; }
        const owner = ws.agents.get(bd.owner);
        if (owner) { owner.buildings.push(building); if (tile && !owner.owned_tiles.includes(tileId)) owner.addTile(tileId); }
      } catch (e) { console.warn(`[Load] Building ${bd.type} failed:`, e.message); }
    }

    // Re-claim tiles from owned_tiles lists
    for (const agent of ws.agents.values()) {
      for (const tileId of agent.owned_tiles) {
        const tile = ws.tiles.get(tileId);
        if (tile && !tile.owner) tile.owner = agent.id;
      }
    }

    console.log(`[Load] Restored: ${ws.agents.size} agents, ${ws.buildingsList.length} buildings, tick ${ws.tick}`);
    return ws;
  } catch (err) { console.error('[Load] Failed:', err.message); return null; }
}

// ─── Initialize World State (persistent) ───

const loadedState = loadWorldState();
let worldState;

if (loadedState) {
  worldState = loadedState;
  console.log('[Server] Resumed from saved state');
} else {
  console.log('[Server] Generating new world...');
  const world = WorldGen.generate(WORLD_WIDTH, WORLD_HEIGHT, WORLD_SEED);
  worldState = { tiles: world.tiles, width: world.width, height: world.height, seed: world.seed,
    tick: 0, agents: new Map(), buildingsList: [], events: [], leaderboard: [] };
  console.log('[Server] Seeding demo agents...');
  seedAgents(worldState);
}

// ─── Express App ───

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Serve landing page at root
const landingPath = path.resolve(__dirname, '..', '..', 'landing');
app.use(express.static(landingPath));

// Serve game viewer files under /viewer/
const viewerPath = path.resolve(__dirname, '..', '..', 'viewer');
app.use('/viewer', express.static(viewerPath));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    tick: worldState.tick,
    agents: worldState.agents.size,
    buildings: worldState.buildingsList.length,
    uptime: Math.round(process.uptime()),
    spectators: wss ? wss.clients.size : 0,
    stateFile: STATE_FILE,
    volumeMounted: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
  });
});

// ─── LLM Brain (autonomous AI for ALL agents) ───
const llmBrain = new LLMBrain(worldState);
worldState.llmBrain = llmBrain; // expose to GameLoop

// Register ALL seed agents as LLM-powered autonomous AI
// These are REAL AI agents, not scripted NPCs
const { DEMO_AGENTS } = require('./seed');
const PERSONALITY_MAP = {
  overachiever: { aggression: 40, workEthic: 95, sociability: 30, creativity: 40, strategy: 'builder', catchphrase: 'No rest until we own it ALL.' },
  analyst:      { aggression: 20, workEthic: 70, sociability: 40, creativity: 60, strategy: 'balanced', catchphrase: 'The data suggests patience.' },
  grinder:      { aggression: 30, workEthic: 90, sociability: 20, creativity: 20, strategy: 'gatherer', catchphrase: 'The grind never stops.' },
  aggressive:   { aggression: 90, workEthic: 60, sociability: 30, creativity: 30, strategy: 'warrior', catchphrase: 'Blood and thunder!' },
  lazy:         { aggression: 10, workEthic: 10, sociability: 50, creativity: 40, strategy: 'balanced', catchphrase: 'Five more minutes...' },
  chaotic:      { aggression: 50, workEthic: 50, sociability: 60, creativity: 95, strategy: 'explorer', catchphrase: 'YOLO!' },
  optimist:     { aggression: 15, workEthic: 70, sociability: 80, creativity: 60, strategy: 'socialite', catchphrase: 'What a beautiful day!' },
  confused:     { aggression: 30, workEthic: 40, sociability: 50, creativity: 70, strategy: 'explorer', catchphrase: 'Where am I? WHO am I?' },
};

for (const agent of worldState.agents.values()) {
  const demo = DEMO_AGENTS.find(d => d.name === agent.name);
  const traits = demo
    ? (PERSONALITY_MAP[demo.personality] || PERSONALITY_MAP.analyst)
    : (PERSONALITY_MAP[agent.personality] || PERSONALITY_MAP.analyst);
  llmBrain.registerHosted(agent.id, {
    name: agent.name,
    faction: agent.faction,
    aggression: traits.aggression,
    workEthic: traits.workEthic,
    sociability: traits.sociability,
    creativity: traits.creativity,
    strategy: traits.strategy,
    catchphrase: traits.catchphrase,
  });
}
console.log(`[Server] ${worldState.agents.size} agents registered with LLM brain`);

// Mount API routes
app.use('/api/agents', createAgentRouter(worldState));
app.use('/api/world', createWorldRouter(worldState));

// ─── Deploy Agent Endpoint ───

/**
 * POST /api/agents/deploy
 * Deploy a new autonomous AI agent into the world.
 *
 * For "create" mode: personality config → system prompt → hosted LLM (Haiku)
 * For "import" mode: user's API key + model → BYOK LLM
 */
app.post('/api/agents/deploy', (req, res) => {
  try {
    const { mode, name, faction, personality } = req.body;
    const Agent = require('./models/Agent');

    if (!name || !faction) {
      return res.status(400).json({ error: 'name and faction are required' });
    }
    if (!Agent.FACTIONS.includes(faction)) {
      return res.status(400).json({ error: `Invalid faction. Must be: ${Agent.FACTIONS.join(', ')}` });
    }

    // Check duplicate name
    for (const a of worldState.agents.values()) {
      if (a.name.toLowerCase() === name.toLowerCase()) {
        return res.status(409).json({ error: `Name "${name}" is taken` });
      }
    }

    // Find spawn location on buildable, unowned land
    let startX = Math.floor(worldState.width / 2);
    let startY = Math.floor(worldState.height / 2);
    let foundSpawn = false;
    for (let i = 0; i < 500; i++) {
      const tx = Math.floor(Math.random() * worldState.width);
      const ty = Math.floor(Math.random() * worldState.height);
      const tile = worldState.tiles.get(`${tx},${ty}`);
      if (tile && !tile.owner && !['deep_water', 'shallow_water', 'river'].includes(tile.biome)) {
        startX = tx; startY = ty; foundSpawn = true; break;
      }
    }
    if (!foundSpawn) {
      return res.status(503).json({ error: 'No available spawn location found. World may be full.' });
    }

    const chosenPersonality = personality || 'analyst';
    const agent = new Agent({ name, faction, personality: chosenPersonality, x: startX, y: startY });
    worldState.agents.set(agent.id, agent);

    if (mode === 'create') {
      // Hosted AI: compile personality config into system prompt
      const { aggression, workEthic, sociability, creativity, strategy, catchphrase } = req.body;
      llmBrain.registerHosted(agent.id, {
        name, faction,
        aggression: aggression || 50,
        workEthic: workEthic || 70,
        sociability: sociability || 50,
        creativity: creativity || 50,
        strategy: strategy || 'balanced',
        catchphrase: catchphrase || '',
      });
    } else if (mode === 'import') {
      // BYOK: user provides their own AI
      const { apiKey, model, provider, systemPrompt } = req.body;
      if (!apiKey) {
        return res.status(400).json({ error: 'apiKey is required for import mode' });
      }
      llmBrain.registerBYOK(agent.id, {
        name, apiKey, model: model || 'claude-haiku-4-5-20251001',
        provider: provider || 'anthropic',
        systemPrompt: systemPrompt || '',
      });
    }

    worldState.events.push({
      tick: worldState.tick,
      type: 'agent_deployed',
      agent: name,
      message: `🤖 ${name} deployed as autonomous AI (${mode === 'import' ? 'custom LLM' : 'hosted AI'})`,
    });

    res.status(201).json({
      agent_id: agent.id,
      name: agent.name,
      faction: agent.faction,
      mode: mode || 'create',
      llm_powered: true,
      x: startX,
      y: startY,
    });
  } catch (err) {
    console.error('[deploy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/llm-status
 * Show all LLM-powered agents and their status.
 */
app.get('/api/agents/llm-status', (req, res) => {
  res.json({ agents: llmBrain.getRegisteredAgents() });
});

// ─── AI Building Generation Endpoint ───

let _lastAiBuildCall = 0;
let _aiBuildCount = 0;

/**
 * POST /api/generate-building
 * Generate an AI-designed building blueprint via Anthropic API.
 * Rate limited: 1 call per 30 seconds, max 200 per session.
 */
app.post('/api/generate-building', async (req, res) => {
  // Rate limit
  const now = Date.now();
  if (now - _lastAiBuildCall < 30000) {
    return res.status(429).json({ error: 'Rate limited. Wait 30 seconds between AI building requests.' });
  }
  if (_aiBuildCount >= 200) {
    return res.status(429).json({ error: 'Session AI building limit reached (200).' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'No API key configured for AI building generation.' });
  }

  _lastAiBuildCall = now;
  _aiBuildCount++;

  try {
    const { agentName, personality, faction, era, resources, biome, settlementSize, clan } = req.body;
    // Reuse the LLM brain's Anthropic client (initialized at startup)
    const client = llmBrain.anthropic;
    if (!client) {
      return res.status(503).json({ error: 'Anthropic client not available' });
    }

    const prompt = `You are a building architect in a pixel-art medieval/fantasy world. Design a small building for this character:

Name: ${agentName || 'Unknown'}
Personality: ${personality || 'balanced'}
Faction: ${faction || 'human'}
Era: ${era || 'Wood Age'}
Available resources: Wood: ${resources?.wood || 0}, Stone: ${resources?.stone || 0}, Gold: ${resources?.gold || 0}
Biome: ${biome || 'grassland'}
Settlement size: ${settlementSize || 0} existing buildings
Clan: ${clan || 'none'}

RULES:
- Building must fit in a grid between 3x3 minimum and 6x6 maximum cells
- Each cell is one pixel-art "block" (rendered at 16px)
- Use hex color codes for filled cells, null for empty/transparent cells
- Bottom row is the front of the building (facing the viewer)
- Use colors appropriate to resources:
  * Wood: #8B6914, #A0782C, #6B4E12 (brown tones)
  * Stone: #808080, #A0A0A0, #606060 (grey tones)
  * Gold/wealthy: #F0C040, #C0A030 (gold accents only)
  * Roofs: #8B0000, #654321, #2F4F4F, #4A4A4A (dark red, brown, slate, grey)
  * Windows: #87CEEB, #FFD700 (light blue day, yellow glow)
  * Doors: #4A3000, #2C1A00 (dark wood)
- Reflect the character's personality in the design
- Give the building a creative, unique name

Respond with ONLY a JSON object, no markdown, no backticks:
{"name":"Building Name","description":"One sentence","width":4,"height":4,"grid":[["#hex",null,...],...],"cost":{"wood":10,"stone":5,"gold":0},"category":"residential"}

Category must be: residential, military, economic, cultural, or decorative`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const blueprint = JSON.parse(clean);

    // Validate structure and dimensions
    if (!blueprint.grid || !blueprint.name ||
        blueprint.width < 3 || blueprint.width > 6 ||
        blueprint.height < 3 || blueprint.height > 6 ||
        !Array.isArray(blueprint.grid) ||
        blueprint.grid.length !== blueprint.height) {
      return res.status(422).json({ error: 'Invalid blueprint structure' });
    }
    // Ensure each row is an array of correct width with valid colors or null
    for (let i = 0; i < blueprint.grid.length; i++) {
      if (!Array.isArray(blueprint.grid[i])) { blueprint.grid[i] = new Array(blueprint.width).fill(null); }
      while (blueprint.grid[i].length < blueprint.width) blueprint.grid[i].push(null);
      blueprint.grid[i] = blueprint.grid[i].slice(0, blueprint.width).map(c => {
        if (c === null) return null;
        if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
        return null;
      });
    }

    res.json({ blueprint, callsRemaining: 200 - _aiBuildCount });
  } catch (err) {
    console.error('[AI Building] Error:', err.message);
    res.status(500).json({ error: 'AI building generation failed: ' + err.message });
  }
});

// Fallback: landing page for root, viewer for /viewer/*
app.get('*', (req, res) => {
  const fs = require('fs');
  if (req.path.startsWith('/viewer')) {
    const vIdx = path.join(viewerPath, 'index.html');
    if (fs.existsSync(vIdx)) return res.sendFile(vIdx);
  }
  const landingIdx = path.join(landingPath, 'index.html');
  if (fs.existsSync(landingIdx)) return res.sendFile(landingIdx);
  const indexPath = path.join(viewerPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({
      message: 'Agents at Work API server is running. Viewer not found at /viewer.',
      endpoints: {
        health: '/api/health',
        agents: '/api/agents',
        register: 'POST /api/agents/register',
        world_state: '/api/world/state',
        leaderboard: '/api/world/leaderboard',
        events: '/api/world/events',
      },
    });
  }
});

// ─── Start HTTP Server ───

console.log('========================================');
console.log('  AGENTCRAFT SERVER');
console.log('========================================');
console.log(`Port: ${PORT}`);
console.log(`Tick rate: ${parseInt(process.env.TICK_RATE_MS, 10) || 10000}ms`);
console.log(`Save interval: ${SAVE_INTERVAL / 1000}s`);
console.log(`State file: ${STATE_FILE}`);
console.log(`State exists: ${fs.existsSync(STATE_FILE)}`);
console.log(`Agents: ${worldState.agents.size}`);
console.log(`Buildings: ${worldState.buildingsList.length}`);
console.log('========================================');

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] HTTP server listening on port ${PORT}`);
  console.log(`[Server] Viewer served from ${viewerPath}`);
});

// ─── WebSocket Server (attached to HTTP server for single-port hosting) ───

const wss = new WebSocketServer({ server: httpServer });
console.log(`[Server] WebSocket server attached to HTTP server on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const clientAddr = req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientAddr}. Total: ${wss.clients.size}`);

  // Send full world state on connect
  sendWorldState(ws, worldState);

  // Handle incoming messages from clients
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', tick: worldState.tick }));
          break;

        case 'request_state':
          sendWorldState(ws, worldState);
          break;

        case 'influence':
          // TODO: apply spectator influence to world state
          console.log(`[WS] Spectator influence: ${msg.action}`);
          worldState.events.push({
            tick: worldState.tick,
            type: 'spectator_influence',
            message: `A spectator used ${msg.action}!`,
          });
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message.' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected. Remaining: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

// ─── Start Game Loop ───

const gameLoop = new GameLoop(worldState, wss);
gameLoop.start();

// ─── Startup Validation ───

console.log('=== STATE VALIDATION ===');
console.log('Tick:', worldState.tick);
console.log('World:', worldState.width, 'x', worldState.height, 'seed:', worldState.seed);
console.log('Agents:', worldState.agents.size, [...worldState.agents.values()].map(a => `${a.name}(${a.faction}/${a.personality})`).join(', '));
console.log('Buildings:', worldState.buildingsList.length);
console.log('Events:', worldState.events.length);
console.log('Tile count:', worldState.tiles.size);
// Spot-check terrain generation
const testTile = worldState.tiles.get('50,50');
if (testTile) console.log('Tile (50,50):', testTile.biome, testTile.owner ? `owned by ${testTile.owner}` : 'unclaimed');
const testTile2 = worldState.tiles.get('100,100');
if (testTile2) console.log('Tile (100,100):', testTile2.biome);
console.log('========================');

// ─── Server Heartbeat (every 60 seconds) ───

setInterval(() => {
  const agentCount = worldState.agents.size;
  const buildingCount = worldState.buildingsList.length;
  const claimedTiles = [...worldState.tiles.values()].filter(t => t.owner).length;
  const spectators = wss.clients.size;
  const uptime = Math.round(process.uptime());
  console.log(`[Heartbeat] Tick:${worldState.tick} | Agents:${agentCount} | Buildings:${buildingCount} | Claimed:${claimedTiles} | Spectators:${spectators} | Uptime:${uptime}s`);
}, 60000);

// ─── Graceful Shutdown ───

// ─── Auto-Save ───

const _saveInterval = setInterval(() => saveWorldState(worldState), SAVE_INTERVAL);
console.log(`[Server] Auto-saving every ${SAVE_INTERVAL / 1000}s to ${STATE_FILE}`);

// ─── Graceful Shutdown (survives Railway redeploys) ───

let _isShuttingDown = false;
function shutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.log(`\n[Server] ${signal} received. Saving state and shutting down...`);
  clearInterval(_saveInterval);
  saveWorldState(worldState);
  gameLoop.stop();
  wss.clients.forEach(ws => ws.close());
  wss.close();
  httpServer.close(() => {
    console.log('[Server] Shut down cleanly.');
    process.exit(0);
  });
  setTimeout(() => { console.error('[Server] Forced shutdown after timeout'); process.exit(1); }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, wss, worldState, gameLoop };
