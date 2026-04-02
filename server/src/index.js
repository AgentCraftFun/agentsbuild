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
const WS_PORT = parseInt(process.env.WS_PORT, 10) || 3001;
const WORLD_WIDTH = parseInt(process.env.WORLD_WIDTH, 10) || 200;
const WORLD_HEIGHT = parseInt(process.env.WORLD_HEIGHT, 10) || 150;
const WORLD_SEED = parseInt(process.env.WORLD_SEED, 10) || 42;

// ─── Initialize World State (in-memory) ───

console.log('[Server] Generating world...');
const world = WorldGen.generate(WORLD_WIDTH, WORLD_HEIGHT, WORLD_SEED);
const worldState = {
  tiles: world.tiles,
  width: world.width,
  height: world.height,
  seed: world.seed,
  tick: 0,
  agents: new Map(),
  buildingsList: [],
  events: [],
  leaderboard: [],
};

// Seed demo agents
console.log('[Server] Seeding demo agents...');
seedAgents(worldState);

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
    uptime: process.uptime(),
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
  if (demo) {
    const traits = PERSONALITY_MAP[demo.personality] || PERSONALITY_MAP.analyst;
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

// ─── Graceful Shutdown ───

function shutdown(signal) {
  console.log(`\n[Server] ${signal} received. Shutting down...`);
  gameLoop.stop();
  wss.close();
  httpServer.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, wss, worldState, gameLoop };
