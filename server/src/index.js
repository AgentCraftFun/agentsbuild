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
app.use(express.json());

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

// Mount API routes
app.use('/api/agents', createAgentRouter(worldState));
app.use('/api/world', createWorldRouter(worldState));

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
