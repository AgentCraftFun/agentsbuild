/**
 * AgentCraft Relay Server
 *
 * This server does THREE things:
 * 1. Serves the HTML/landing pages
 * 2. Accepts WebSocket connections from all browsers
 * 3. Relays game state from the "host" tab to all "spectator" tabs
 *
 * The FIRST browser that connects becomes the "host" — its client-side
 * simulation runs the game and broadcasts state to everyone else.
 * All other browsers are "spectators" that receive and render that state.
 *
 * ZERO game logic runs on this server. It's purely a relay.
 */

const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;

const app = express();

// Serve landing page at root
app.use(express.static(path.resolve(__dirname, 'landing')));

// Serve viewer at /viewer/
app.use('/viewer', express.static(path.resolve(__dirname, 'viewer')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    host: hostWS ? 'connected' : 'waiting',
    spectators: clients.size,
    uptime: Math.round(process.uptime()),
  });
});

// Fallback: serve viewer or landing
app.get('*', (req, res) => {
  if (req.path.startsWith('/viewer')) {
    res.sendFile(path.resolve(__dirname, 'viewer', 'index.html'));
  } else {
    const landing = path.resolve(__dirname, 'landing', 'index.html');
    const viewer = path.resolve(__dirname, 'viewer', 'index.html');
    const fs = require('fs');
    if (fs.existsSync(landing)) res.sendFile(landing);
    else if (fs.existsSync(viewer)) res.sendFile(viewer);
    else res.status(404).send('Not found');
  }
});

// Start HTTP server
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  AGENTCRAFT RELAY SERVER');
  console.log('========================================');
  console.log(`Port: ${PORT}`);
  console.log(`Mode: Host-relay (first client is host)`);
  console.log('========================================');
});

// WebSocket relay
const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();
let hostWS = null;
let lastHostState = null; // cache last state for new spectators

wss.on('connection', (ws) => {
  clients.add(ws);

  if (!hostWS) {
    // First client becomes the host
    hostWS = ws;
    ws.isHost = true;
    ws.send(JSON.stringify({ type: 'role', role: 'host' }));
    console.log(`[WS] HOST connected. Total: ${clients.size}`);
  } else {
    // Everyone else is a spectator
    ws.isHost = false;
    ws.send(JSON.stringify({ type: 'role', role: 'spectator' }));
    // Send cached state immediately so spectators see the world right away
    if (lastHostState) {
      try { ws.send(lastHostState); } catch (e) {}
    }
    console.log(`[WS] Spectator connected. Total: ${clients.size}`);
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Only the host can broadcast state
      if (ws.isHost && (msg.type === 'host_state')) {
        const relay = JSON.stringify({ type: 'world_state', data: msg.data });
        lastHostState = relay; // cache for new spectators
        // Broadcast to all spectators
        clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            try { client.send(relay); } catch (e) {}
          }
        });
      }

      // Forward spectator influence to host
      if (!ws.isHost && msg.type === 'influence') {
        if (hostWS && hostWS.readyState === 1) {
          try { hostWS.send(JSON.stringify(msg)); } catch (e) {}
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws === hostWS) {
      console.log(`[WS] HOST disconnected. Promoting next client...`);
      hostWS = null;
      // Promote the next connected client to host
      for (const client of clients) {
        if (client.readyState === 1) {
          hostWS = client;
          client.isHost = true;
          client.send(JSON.stringify({ type: 'role', role: 'host' }));
          console.log(`[WS] New HOST promoted. Total: ${clients.size}`);
          break;
        }
      }
      if (!hostWS) console.log('[WS] No clients left to promote.');
    } else {
      console.log(`[WS] Spectator disconnected. Total: ${clients.size}`);
    }
  });
});

// Heartbeat
setInterval(() => {
  console.log(`[Heartbeat] Host: ${hostWS ? 'yes' : 'no'} | Clients: ${clients.size} | Uptime: ${Math.round(process.uptime())}s`);
}, 60000);

// Graceful shutdown
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT'); process.exit(0); });
