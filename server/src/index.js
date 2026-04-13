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
        _settlementId: agent._settlementId || 0,
        // Phase 2: buffs (temporary) + perks (permanent) — absent in v1 saves
        buffs: Array.isArray(agent.buffs) ? agent.buffs : [],
        perks: (agent.perks && typeof agent.perks === 'object') ? agent.perks : {},
        // Phase 3: equipment (weapon/armor slots)
        equipment: (agent.equipment && typeof agent.equipment === 'object') ? agent.equipment : {},
        // Cyber Phase 2: which world the agent is in
        currentWorld: agent.currentWorld || 'grassland',
      });
    }
    const buildings = ws.buildingsList.map(b => b.toJSON());
    const state = {
      version: 2, savedAt: Date.now(), tick: ws.tick,
      seed: ws.seed, width: ws.width, height: ws.height,
      agents, buildings, events: (ws.events || []).slice(-200),
      leaderboard: ws.leaderboard || [],
      settlements: ws.settlements || [],
      // Phase 1 of loot drops: persisted ground items (backwards-compatible
      // with v1 saves — absent field loads as [])
      groundItems: Array.isArray(ws.groundItems) ? ws.groundItems : [],
      // World boss: dragon state (null = no dragon, or full dragon object)
      dragon: ws.dragon || null,
      // Week 2 teaser: powering-up portals
      portals: Array.isArray(ws.portals) ? ws.portals : [],
      // Cyber Phase 2: Neo-Kyoto settlements (village clustering)
      cyberSettlements: Array.isArray(ws.cyberSettlements) ? ws.cyberSettlements : [],
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
      tick: state.tick || 0, agents: new Map(), buildingsList: [], events: state.events || [], leaderboard: state.leaderboard || [],
      settlements: state.settlements || [],
      // Loot drops: v1 saves have no groundItems, default to []
      groundItems: Array.isArray(state.groundItems) ? state.groundItems : [],
      // World boss: restore dragon if mid-fight when saved
      dragon: state.dragon || null,
      // Week 2 teaser: portals persist across restarts
      portals: Array.isArray(state.portals) ? state.portals : [],
      // Cyber settlements (village clustering)
      cyberSettlements: Array.isArray(state.cyberSettlements) ? state.cyberSettlements : [] };

    const Agent = require('./models/Agent');
    const Building = require('./models/Building');

    // Restore agents
    for (const ad of (state.agents || [])) {
      try {
        const agent = new Agent({ id: ad.id, name: ad.name, faction: ad.faction, personality: ad.personality,
          x: ad.x, y: ad.y, wallet_address: ad.wallet_address, api_key: ad.api_key,
          work_balance: ad.work_balance || 0, resources: ad.resources || { food: 10, wood: 10, stone: 5, gold: 0 },
          mood: ad.mood || 'idle', owned_tiles: ad.owned_tiles || [], buildings: [],
          message: ad.message || '', idle_ticks: ad.idle_ticks || 0, last_action_tick: ad.last_action_tick || 0,
          buffs: Array.isArray(ad.buffs) ? ad.buffs : [],
          perks: (ad.perks && typeof ad.perks === 'object') ? ad.perks : {},
          equipment: (ad.equipment && typeof ad.equipment === 'object') ? ad.equipment : {},
          currentWorld: ad.currentWorld || 'grassland' });
        agent._settlementId = ad._settlementId || 0;
        ws.agents.set(agent.id, agent);
      } catch (e) { console.warn(`[Load] Agent ${ad.name} failed:`, e.message); }
    }

    // Restore buildings and re-link to tiles/agents
    for (const bd of (state.buildings || [])) {
      try {
        const building = new Building({ type: bd.type, x: bd.x, y: bd.y, owner: bd.owner, progress: bd.progress || 0, startTick: bd.startTick || 0, burning: bd.burning || false, hp: bd.hp != null ? bd.hp : 1.0, world: bd.world || 'grassland' });
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
// World state persists across deploys — never delete the save file.

const loadedState = loadWorldState();
let worldState;

if (loadedState) {
  worldState = loadedState;
  worldState._dirtyTiles = new Set();
  // Defensive: ensure groundItems exists even if the loaded save predated it
  if (!Array.isArray(worldState.groundItems)) worldState.groundItems = [];
  console.log('[Server] Resumed from saved state');
  // Reset agent tasks so they re-evaluate on first tick (stale targets from before save)
  for (const agent of worldState.agents.values()) {
    agent.mood = 'idle';
    agent.current_action = null;
    agent.action_queue = [];
  }
  // Defensive: cyberSettlements may not exist in old saves
  if (!Array.isArray(worldState.cyberSettlements)) worldState.cyberSettlements = [];
  console.log('[Server] All agents reset to idle — will pick new tasks on first tick');
} else {
  console.log('[Server] Generating new world...');
  const world = WorldGen.generate(WORLD_WIDTH, WORLD_HEIGHT, WORLD_SEED);
  worldState = { tiles: world.tiles, width: world.width, height: world.height, seed: world.seed,
    tick: 0, agents: new Map(), buildingsList: [], events: [], leaderboard: [], settlements: [], _dirtyTiles: new Set(),
    groundItems: [], dragon: null, cyberSettlements: [] };
  console.log('[Server] Seeding demo agents...');
  seedAgents(worldState);
}

// ─── PORTALS (Week 2 teaser) ─────────────────────────────────────────
// 5 portals spawn once per world and persist forever. They're "powering up"
// forever (slow fake charge) until we manually flip them when the new
// biome is ready. Agents don't interact with them yet — pure teaser.
if (!Array.isArray(worldState.portals) || worldState.portals.length === 0) {
  const NUM_PORTALS = 5;
  const tints = ['cyan', 'purple', 'magenta', 'emerald', 'gold'];
  const portals = [];
  const minDist = 20; // min distance between portals + from map edges
  let attempts = 0;
  while (portals.length < NUM_PORTALS && attempts < 500) {
    attempts++;
    const px = minDist + Math.floor(Math.random() * (worldState.width - minDist * 2));
    const py = minDist + Math.floor(Math.random() * (worldState.height - minDist * 2));
    // Check tile is walkable (not water)
    const tile = worldState.tiles.get(`${px},${py}`);
    if (!tile) continue;
    if (tile.biome === 'water' || tile.biome === 'river' || tile.biome === 'deep_water') continue;
    // Spacing from other portals
    let tooClose = false;
    for (const pp of portals) {
      if (Math.abs(pp.x - px) + Math.abs(pp.y - py) < minDist) { tooClose = true; break; }
    }
    if (tooClose) continue;
    portals.push({
      id: `portal_${portals.length + 1}`,
      x: px,
      y: py,
      tint: tints[portals.length % tints.length],
      // Start charge between 12-38% so each portal looks different
      charge: 0.12 + Math.random() * 0.26,
      spawnTick: worldState.tick || 0,
      label: 'POWERING UP',
    });
  }
  worldState.portals = portals;
  console.log(`[Portals] Spawned ${portals.length} powering-up portals`);
} else {
  console.log(`[Portals] Restored ${worldState.portals.length} portals from save`);
}

// ─── Spatial Index (performance: O(1) building proximity checks) ───
const SpatialIndex = require('./services/SpatialIndex');
worldState._spatialIndex = new SpatialIndex();
worldState._spatialIndex.rebuild(worldState.buildingsList);
console.log(`[Server] Spatial index built: ${worldState._spatialIndex.size()} buildings`);

// ─── Payment Infrastructure (Phase 1) ───
const ActionRegistry = require('./services/ActionRegistry');
const ActionCatalog = require('./services/ActionCatalog');
const TxVerifier = require('./services/TxVerifier');
const PaidActions = require('./services/PaidActions');
const ACTIONS_FILE = path.join(VOLUME_PATH, 'actions.json');
const actionRegistry = new ActionRegistry({ filePath: ACTIONS_FILE });
actionRegistry.load();
console.log(`[Server] Action registry: ${actionRegistry.getStats().totalRecorded} recorded`);

// Register paid chaos actions (Phase 2).
// All 7 actions are enabled. Previously gated behind ENABLED_PAID_ACTIONS
// env var — now hardcoded to ensure every deploy has the full menu.
const ALL_PAID_ACTIONS = ['lightning', 'wildfire', 'earthquake', 'tornado', 'meteor', 'plague', 'volcano'];
const registered = PaidActions.register(ActionCatalog, ALL_PAID_ACTIONS);
console.log(`[Server] Paid actions enabled: ${registered.join(', ')}`);


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

// ─── Live stats for the landing page ───
// Lightweight public endpoint that powers the LIVE STATS section.
// IMPORTANT: formulas MUST match the viewer header so both surfaces
// show the same numbers. See viewer/index.html:6367-6373.
app.get('/api/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tick = worldState.tick || 0;
  // Day formula matches viewer: _clockBase = tick*3, days = _clockBase/300
  //   → days = tick / 100, displayed as days+1
  const day = Math.max(1, Math.floor(tick / 100) + 1);
  // Count tiles claimed across all agents
  let tilesClaimed = 0;
  for (const agent of worldState.agents.values()) {
    tilesClaimed += (agent.owned_tiles && agent.owned_tiles.length) || 0;
  }
  // Buildings: match viewer (S.buildings.length = all buildings, not filtered)
  const buildingsCount = worldState.buildingsList.length;
  // Viewers: live WebSocket count × 2 (landing-page vanity multiplier).
  // Reasoning: the raw count only includes viewers currently inside /viewer
  // — it ignores people on the landing page who haven't clicked through yet,
  // people watching via embed/preview, etc.
  const rawViewers = wss ? wss.clients.size : 0;
  const viewers = rawViewers * 2;
  res.json({
    tick,
    day,
    agents: worldState.agents.size,
    buildings: buildingsCount,
    tilesClaimed,
    viewers,
    serverUptime: Math.round(process.uptime()),
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

    // Find spawn location on buildable, unowned land.
    // Strategy: random tries first (fast path), then systematic grid scan
    // (guaranteed to find ANY unowned buildable tile if one exists).
    const WATER_BIOMES = new Set(['deep_water', 'shallow_water', 'river']);
    function isSpawnable(tile) {
      return tile && !tile.owner && !WATER_BIOMES.has(tile.biome);
    }
    let startX = Math.floor(worldState.width / 2);
    let startY = Math.floor(worldState.height / 2);
    let foundSpawn = false;
    // Fast path: 500 random tries
    for (let i = 0; i < 500; i++) {
      const tx = Math.floor(Math.random() * worldState.width);
      const ty = Math.floor(Math.random() * worldState.height);
      const tile = worldState.tiles.get(`${tx},${ty}`);
      if (isSpawnable(tile)) {
        startX = tx; startY = ty; foundSpawn = true; break;
      }
    }
    // Systematic fallback: scan entire map from a random offset so different
    // requests find different tiles. Guarantees we find any free buildable tile.
    if (!foundSpawn) {
      const offX = Math.floor(Math.random() * worldState.width);
      const offY = Math.floor(Math.random() * worldState.height);
      outer: for (let dy = 0; dy < worldState.height; dy++) {
        for (let dx = 0; dx < worldState.width; dx++) {
          const tx = (dx + offX) % worldState.width;
          const ty = (dy + offY) % worldState.height;
          const tile = worldState.tiles.get(`${tx},${ty}`);
          if (isSpawnable(tile)) {
            startX = tx; startY = ty; foundSpawn = true; break outer;
          }
        }
      }
    }
    if (!foundSpawn) {
      return res.status(503).json({ error: 'No available spawn location found. World is completely full.' });
    }

    const chosenPersonality = personality || 'analyst';
    const agent = new Agent({ name, faction, personality: chosenPersonality, x: startX, y: startY,
      work_balance: 0, resources: { food: 0, wood: 0, stone: 0, gold: 0 } });
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

// ─── Paid Actions ($AGENTCRAFT utility) ───
//
// POST /api/action with body: { txHash, action, params? }
//
// Flow:
//   1. Validate body + action exists in catalog
//   2. Atomically claim txHash in the registry (prevents double-spend)
//   3. Verify on-chain payment via TxVerifier (checks Base RPC)
//   4. On failure → release claim + return error
//   5. On success → dispatch action, record in registry, return result
//
// The client NEVER calls Base RPC — only this server-side path does.
app.post('/api/action', async (req, res) => {
  const body = req.body || {};
  const txHash = typeof body.txHash === 'string' ? body.txHash.trim() : '';
  const actionName = typeof body.action === 'string' ? body.action.toLowerCase().trim() : '';
  const params = body.params && typeof body.params === 'object' ? body.params : {};

  // ── 1. Basic validation ──
  if (!txHash || !actionName) {
    return res.status(400).json({ ok: false, error: 'txHash and action are required' });
  }
  if (!TxVerifier.isValidTxHash(txHash)) {
    return res.status(400).json({ ok: false, error: 'Invalid transaction hash format' });
  }

  // ── 2. Look up the action ──
  const actionDef = ActionCatalog.get(actionName);
  if (!actionDef) {
    return res.status(400).json({ ok: false, error: `Unknown action: ${actionName}` });
  }

  // ── 3. Atomic claim (prevents double-spend across concurrent requests) ──
  if (!actionRegistry.claim(txHash)) {
    // Could be pending verification by another request OR already permanently recorded.
    const prior = actionRegistry.getEntry(txHash);
    if (prior) {
      return res.status(409).json({
        ok: false,
        error: 'Transaction already used',
        previousAction: prior.action,
        previousAt: prior.appliedAt,
      });
    }
    return res.status(409).json({ ok: false, error: 'Transaction is being processed by another request' });
  }

  // ── 4. Verify payment on-chain ──
  let verification;
  try {
    verification = await TxVerifier.verifyPayment(txHash, actionDef.price);
  } catch (err) {
    actionRegistry.release(txHash);
    console.error('[API /action] verifier error:', err.message);
    return res.status(502).json({ ok: false, error: `Verification error: ${err.message}` });
  }
  if (!verification.ok) {
    actionRegistry.release(txHash);
    // Transient errors (RPC down, timeout) → 502 so client shows "try again"
    // All other failures (not found, insufficient, wrong token) → 402
    const statusCode = verification.transient ? 502 : 402;
    return res.status(statusCode).json({
      ok: false,
      error: verification.reason,
      required: actionDef.price,
      paid: verification.amount || null,
      transient: !!verification.transient,
    });
  }

  // ── 5. Dispatch the action ──
  let dispatchResult;
  try {
    const ctx = {
      worldState,
      gameLoop,
      from: verification.from,
      txHash: verification.txHash,
      amount: verification.amount,
      tick: worldState.tick || 0,
    };
    dispatchResult = await actionDef.dispatch(ctx, params);
  } catch (err) {
    actionRegistry.release(txHash);
    console.error(`[API /action] dispatch error for ${actionName}:`, err.stack || err.message);
    return res.status(500).json({ ok: false, error: `Dispatch failed: ${err.message}` });
  }

  // ── 6. Record permanent entry ──
  actionRegistry.record({
    txHash: verification.txHash,
    action: actionName,
    amount: verification.amount,
    from: verification.from,
    appliedAt: Date.now(),
    tick: worldState.tick || 0,
    result: dispatchResult,
    params,
  });

  console.log(`[API /action] ${actionName} by ${verification.from} tx=${verification.txHash} amount=${verification.amount}`);

  return res.json({
    ok: true,
    action: actionName,
    txHash: verification.txHash,
    from: verification.from,
    amount: verification.amount,
    tick: worldState.tick || 0,
    result: dispatchResult,
  });
});

// GET /api/action — list available actions and prices
app.get('/api/action', (req, res) => {
  res.json({
    actions: ActionCatalog.list(),
    treasury: TxVerifier._internals.TREASURY_ADDRESS,
    token: TxVerifier._internals.AGENTCRAFT_TOKEN,
    stats: actionRegistry.getStats(),
  });
});

// ─── Manual Meteor Trigger ───
app.post('/api/meteor', (req, res) => {
  const events = [];
  const tick = worldState.tick || 0;
  const buildings = worldState.buildingsList || [];
  const completed = buildings.filter(b => b.isComplete());

  // Pick impact location
  let impactX, impactY;
  if (req.body && req.body.x != null && req.body.y != null) {
    impactX = Math.max(5, Math.min(worldState.width - 5, req.body.x));
    impactY = Math.max(5, Math.min(worldState.height - 5, req.body.y));
  } else if (completed.length > 0) {
    const target = completed[Math.floor(Math.random() * completed.length)];
    impactX = target.x + Math.floor(Math.random() * 8) - 4;
    impactY = target.y + Math.floor(Math.random() * 8) - 4;
  } else {
    impactX = Math.floor(worldState.width / 2);
    impactY = Math.floor(worldState.height / 2);
  }

  // Find and burn nearby buildings
  const BLAST_RADIUS = 8;
  const hit = buildings.filter(b =>
    b.isComplete() && !b.burning &&
    Math.abs(b.x - impactX) + Math.abs(b.y - impactY) < BLAST_RADIUS
  );
  const targets = hit.sort(() => Math.random() - 0.5).slice(0, 4);
  for (const t of targets) {
    t.burning = true; t.hp = t.hp || 1.0;
    if (!worldState._dirtyTiles) worldState._dirtyTiles = new Set();
    worldState._dirtyTiles.add(`${t.x},${t.y}`);
  }

  // Find nearest settlement for the message
  let nearName = null;
  let nearDist = Infinity;
  for (const s of (worldState.settlements || [])) {
    const d = Math.abs(s.cx - impactX) + Math.abs(s.cy - impactY);
    if (d < nearDist) { nearDist = d; nearName = s.name; }
  }
  const loc = nearName && nearDist < 30 ? `near ${nearName}` : `at (${impactX}, ${impactY})`;

  const event = {
    tick, type: 'meteor_strike', impactX, impactY, burnCount: targets.length,
    message: targets.length > 0
      ? `A meteor crashed ${loc}, setting ${targets.length} building${targets.length > 1 ? 's' : ''} ablaze!`
      : `A meteor crashed ${loc}! No buildings were hit.`,
  };
  worldState.events = worldState.events || [];
  worldState.events.push(event);
  // Also queue for broadcast so the viewer animates it immediately
  if (!worldState._pendingBroadcastEvents) worldState._pendingBroadcastEvents = [];
  worldState._pendingBroadcastEvents.push(event);

  console.log(`[Meteor] MANUAL strike at (${impactX},${impactY}) ${loc} — ${targets.length} buildings burning`);
  res.json({ success: true, impactX, impactY, buildingsBurning: targets.length, message: event.message });
});

// ─── Manual Chaos Trigger ───
// Force any chaos event to fire immediately (bypasses cooldowns).
// Usage: POST /api/chaos/:type  where type is one of:
//   meteor, wildfire, lightning, tornado, earthquake, volcano, plague
app.post('/api/chaos/:type', (req, res) => {
  const type = (req.params.type || '').toLowerCase();
  if (!gameLoop) return res.status(503).json({ error: 'Game loop not ready' });

  // Initialize chaos state if needed
  if (!worldState._chaosState) {
    worldState._chaosState = { lastMeteor:0, lastWildfire:0, lastLightning:0, lastTornado:0, lastEarthquake:0, lastVolcano:0, lastPlague:0 };
  }
  const cs = worldState._chaosState;
  const tick = worldState.tick || 0;
  const events = worldState.events || [];

  // Reset the cooldown for this event type so it fires immediately.
  // Use a very negative value and force mult to a huge number to bypass the chance roll.
  const lastKey = {
    meteor:'lastMeteor', wildfire:'lastWildfire', lightning:'lastLightning',
    tornado:'lastTornado', earthquake:'lastEarthquake', volcano:'lastVolcano', plague:'lastPlague',
  }[type];
  if (!lastKey) {
    return res.status(400).json({ error: `Unknown chaos type '${type}'. Valid: meteor, wildfire, lightning, tornado, earthquake, volcano, plague` });
  }

  const buildingsBefore = worldState.buildingsList.length;
  const eventsBefore = events.length;
  cs[lastKey] = -999999; // reset cooldown

  // Force-fire by using a huge multiplier (ensures chance roll passes) and catching
  // the exact number of events generated so we can report accurately.
  const FORCE_MULT = 999;
  const fireFn = {
    meteor: '_chaosMeteor',
    wildfire: '_chaosWildfire',
    lightning: '_chaosLightning',
    tornado: '_chaosTornado',
    earthquake: '_chaosEarthquake',
    volcano: '_chaosVolcano',
    plague: '_chaosPlague',
  }[type];

  // Retry up to 10 times in case of bad RNG (event early-returns)
  let fired = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const eventsLenBefore = events.length;
    cs[lastKey] = -999999;
    gameLoop[fireFn](tick, events, cs, FORCE_MULT);
    if (events.length > eventsLenBefore) { fired = true; break; }
  }

  const buildingsAfter = worldState.buildingsList.length;
  const newEvents = events.slice(eventsBefore);

  res.json({
    success: fired,
    type,
    tick,
    buildingsBefore,
    buildingsAfter,
    buildingsDestroyed: buildingsBefore - buildingsAfter,
    newEvents: newEvents.map(e => ({ type: e.type, message: e.message })),
  });
});

// ─── Admin Test Trigger (fire paid actions without payment) ───
//
// POST /api/test/:action  — fires the PAID version of a chaos action
// without any $AGENTCRAFT payment. Use for testing visuals in prod.
//
// Protected by ADMIN_TOKEN env var if set. Without the env var this is
// open (useful during development, set ADMIN_TOKEN in prod to lock it).
//
// Usage:
//   POST /api/test/lightning
//   POST /api/test/wildfire
//   POST /api/test/earthquake
//   POST /api/test/tornado
//   POST /api/test/meteor
//   POST /api/test/plague
//   POST /api/test/volcano
//
// Include the admin token in the body or ?token= query param:
//   curl -X POST "https://agentcraft.fun/api/test/lightning?token=XXX"
app.post('/api/test/:action', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const providedToken = (req.body && req.body.token) || req.query.token;
    if (providedToken !== adminToken) {
      return res.status(403).json({ ok: false, error: 'Forbidden: invalid admin token' });
    }
  }

  const actionName = (req.params.action || '').toLowerCase();
  const actionDef = ActionCatalog.get(actionName);
  if (!actionDef) {
    return res.status(400).json({ ok: false, error: `Unknown action: ${actionName}. Try lightning, wildfire, earthquake, tornado, meteor, plague, volcano.` });
  }
  if (actionName === 'echo') {
    return res.status(400).json({ ok: false, error: 'echo has no visual effect' });
  }
  if (!gameLoop) {
    return res.status(503).json({ ok: false, error: 'Game loop not ready' });
  }

  // Build a fake ctx that matches what /api/action would provide
  const ctx = {
    worldState,
    gameLoop,
    from: '0x0000000000000000000000000000000000000000',  // admin/test sender
    txHash: '0x' + 'admin'.padEnd(64, '0').slice(0, 64),
    amount: actionDef.price,
    tick: worldState.tick || 0,
  };

  let result;
  try {
    result = actionDef.dispatch(ctx, {});
  } catch (err) {
    console.error(`[API /test] dispatch error for ${actionName}:`, err.stack || err.message);
    return res.status(500).json({ ok: false, error: `Dispatch failed: ${err.message}` });
  }

  console.log(`[TEST] ${actionName} (no payment) from admin endpoint`);

  return res.json({
    ok: true,
    action: actionName,
    tick: worldState.tick || 0,
    result,
  });
});

// ─── Loot Drop Endpoint (admin) ───
// Drop an item onto the map at (x, y). Agents within a 15-tile radius will
// autonomously chase and pick it up. Guarded by ADMIN_TOKEN.
//
// Usage:
//   POST /api/drop?token=XXX
//   body: { "type": "food_cache", "x": 100, "y": 75, "amount": 50 }
//
// Types: food_cache | wood_cache | stone_cache | gold_cache
// If x/y omitted, drops near a random agent for easy testing.
app.post('/api/drop', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const providedToken = (req.body && req.body.token) || req.query.token;
    if (providedToken !== adminToken) {
      return res.status(403).json({ ok: false, error: 'Forbidden: invalid admin token' });
    }
  }
  if (!gameLoop) {
    return res.status(503).json({ ok: false, error: 'Game loop not ready' });
  }

  const body = req.body || {};
  const type = (body.type || req.query.type || 'food_cache').toString();
  let x = Number(body.x != null ? body.x : req.query.x);
  let y = Number(body.y != null ? body.y : req.query.y);
  const amount = Number(body.amount != null ? body.amount : req.query.amount);

  // If coords missing, drop near a random agent (handy for smoke-testing)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const agents = [...worldState.agents.values()];
    if (agents.length > 0) {
      const target = agents[Math.floor(Math.random() * agents.length)];
      x = target.x + (Math.floor(Math.random() * 7) - 3);
      y = target.y + (Math.floor(Math.random() * 7) - 3);
    } else {
      x = Math.floor(worldState.width / 2);
      y = Math.floor(worldState.height / 2);
    }
  }

  const item = gameLoop.dropItem({
    type,
    x,
    y,
    amount: Number.isFinite(amount) ? amount : undefined,
    droppedBy: 'admin',
  });
  if (!item) {
    return res.status(400).json({
      ok: false,
      error: `Invalid item type: ${type}. Try food_cache, wood_cache, stone_cache, gold_cache.`,
    });
  }
  console.log(`[DROP] ${type} x${item.amount} @(${item.x},${item.y}) via admin`);
  return res.json({ ok: true, item, tick: worldState.tick || 0 });
});

// ─── Free Loot Drop Endpoint (public, rate-limited) ───
// Phase 1 of loot drops ships as a FREE feature so anyone on the viewer
// can watch agents chase a dropped item. The Influence World modal has
// a "Loot Drops" section that hits this endpoint.
//
// Abuse controls:
//   - Global cap: max 30 live ground items at once (older drops still
//     on the ground count)
//   - Per-IP cooldown: 4 seconds between drops
//   - Fixed amounts (can't be exploited to mint arbitrary resources)
//
// Usage: POST /api/drop/free  body: { "type": "food_cache" }
const _freeDropCooldownMs = 4000;
const _freeDropLastByIp = new Map(); // ip -> last ms timestamp
const _freeDropMaxLive = 30;

app.post('/api/drop/free', (req, res) => {
  if (!gameLoop) {
    return res.status(503).json({ ok: false, error: 'Game loop not ready' });
  }

  // Per-IP cooldown
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
  const now = Date.now();
  const last = _freeDropLastByIp.get(ip) || 0;
  if (now - last < _freeDropCooldownMs) {
    const waitMs = _freeDropCooldownMs - (now - last);
    return res.status(429).json({
      ok: false,
      error: `Slow down — wait ${Math.ceil(waitMs / 1000)}s before dropping again.`,
      retryAfterMs: waitMs,
    });
  }
  // Global live-item cap
  const liveCount = Array.isArray(worldState.groundItems) ? worldState.groundItems.length : 0;
  if (liveCount >= _freeDropMaxLive) {
    return res.status(429).json({
      ok: false,
      error: `Too many drops live in the world (${liveCount}/${_freeDropMaxLive}). Wait for agents to pick some up.`,
    });
  }

  const body = req.body || {};
  const type = (body.type || req.query.type || 'food_cache').toString();
  // Fixed amounts for the free version — no user-controlled amount.
  // Resource caches carry their amount; buffs/perks use 0 (amount is unused
  // for those categories — the effect is the payload).
  const FIXED_AMOUNTS = {
    food_cache: 50, wood_cache: 50, stone_cache: 50, gold_cache: 25,
    scroll_haste: 0, potion_gather: 0, potion_build: 0,
    golden_pickaxe: 0, golden_axe: 0,
    // Phase 3: weapons + armor
    weapon_sword: 0, weapon_bow: 0, weapon_spear: 0,
    armor_leather: 0, armor_iron: 0, armor_shield: 0,
  };
  if (!(type in FIXED_AMOUNTS)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid item type: ${type}.`,
    });
  }

  // Drop near a random agent for maximum drama
  let x, y;
  const agents = [...worldState.agents.values()];
  if (agents.length > 0) {
    const target = agents[Math.floor(Math.random() * agents.length)];
    x = target.x + (Math.floor(Math.random() * 9) - 4);
    y = target.y + (Math.floor(Math.random() * 9) - 4);
  } else {
    x = Math.floor(worldState.width / 2);
    y = Math.floor(worldState.height / 2);
  }

  const item = gameLoop.dropItem({
    type,
    x,
    y,
    amount: FIXED_AMOUNTS[type],
    droppedBy: `viewer:${ip.slice(0, 12)}`,
  });
  if (!item) {
    return res.status(500).json({ ok: false, error: 'dropItem returned null' });
  }
  _freeDropLastByIp.set(ip, now);
  // Prevent the map from growing unbounded
  if (_freeDropLastByIp.size > 1000) {
    const cutoff = now - 60_000;
    for (const [k, v] of _freeDropLastByIp.entries()) {
      if (v < cutoff) _freeDropLastByIp.delete(k);
    }
  }
  console.log(`[DROP-FREE] ${type} x${item.amount} @(${item.x},${item.y}) from ${ip}`);
  return res.json({ ok: true, item, tick: worldState.tick || 0 });
});

// ─── Cyber Reset Endpoint (admin) ───
// Wipes all cyber buildings and returns all cyber agents to grassland.
// Lets us watch Neo-Kyoto fill up from scratch once portals open.
// Protected by ADMIN_TOKEN.
// Usage: POST /api/cyber/reset?token=XXX
app.post('/api/cyber/reset', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const provided = (req.body && req.body.token) || req.query.token;
    if (provided !== adminToken) {
      return res.status(403).json({ ok: false, error: 'Forbidden: invalid admin token' });
    }
  }
  // 1. Remove all cyber buildings from every relevant collection
  let removedBuildings = 0;
  const keep = [];
  for (const b of worldState.buildingsList) {
    if (b.world === 'cyber') {
      // Clear tile reference
      const tile = worldState.tiles.get(`${b.x},${b.y}`);
      if (tile && tile.building === b) tile.building = null;
      if (worldState._spatialIndex) worldState._spatialIndex.remove(b);
      if (!worldState._dirtyTiles) worldState._dirtyTiles = new Set();
      worldState._dirtyTiles.add(`${b.x},${b.y}`);
      removedBuildings++;
    } else {
      keep.push(b);
    }
  }
  worldState.buildingsList = keep;
  // Also purge from each agent's buildings array
  for (const agent of worldState.agents.values()) {
    if (Array.isArray(agent.buildings)) {
      agent.buildings = agent.buildings.filter(b => b.world !== 'cyber');
    }
  }
  // 2. Send all cyber agents back to grassland at a random valid spot
  let returnedAgents = 0;
  for (const agent of worldState.agents.values()) {
    if (agent.currentWorld === 'cyber') {
      agent.currentWorld = 'grassland';
      // Spawn near center of map
      agent.x = Math.floor(worldState.width / 2) + Math.floor(Math.random() * 20 - 10);
      agent.y = Math.floor(worldState.height / 2) + Math.floor(Math.random() * 20 - 10);
      agent.mood = 'idle';
      agent._buildingTarget = null;
      agent.current_action = null;
      agent.action_queue = [];
      returnedAgents++;
    }
  }
  // 3. Also wipe cyber settlements so the next agents through a portal
  //    start a fresh village.
  if (Array.isArray(worldState.cyberSettlements)) {
    worldState.cyberSettlements.length = 0;
  }
  // 4. Save state immediately so the reset persists through restarts.
  try {
    saveWorldState(worldState);
    console.log('[CYBER RESET] State saved to disk.');
  } catch (e) {
    console.error('[CYBER RESET] Save failed:', e.message);
  }
  console.log(`[CYBER RESET] Removed ${removedBuildings} buildings, returned ${returnedAgents} agents to grassland`);
  return res.json({
    ok: true,
    removedBuildings,
    returnedAgents,
    saved: true,
    message: `Cyber world wiped. ${removedBuildings} buildings removed, ${returnedAgents} agents returned to grassland. State saved.`,
  });
});

// ─── Dragon Spawn Endpoint (manual trigger for testing) ───
// Spawns a dragon immediately. Rate limited: one dragon at a time.
app.post('/api/dragon/spawn', (req, res) => {
  if (!gameLoop) {
    return res.status(503).json({ ok: false, error: 'Game loop not ready' });
  }
  const dragon = worldState.dragon;
  if (dragon && dragon.alive) {
    return res.status(409).json({ ok: false, error: 'A dragon is already alive! Kill it first.' });
  }
  const events = [];
  gameLoop._spawnDragon(worldState.tick || 0, events);
  console.log(`[DRAGON] Manual spawn via API`);
  return res.json({ ok: true, dragon: worldState.dragon, tick: worldState.tick || 0 });
});

// ─── Emergency Cleanup Endpoint ───
// Destroys buildings owned by:
//   (a) agents who haven't acted in N ticks, OR
//   (b) orphaned owner IDs (agents no longer in the world — "zombie buildings")
// Protected by ADMIN_TOKEN env var to prevent abuse.
// Usage: POST /api/cleanup?threshold=1000&orphansOnly=false&percent=0
app.post('/api/cleanup', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const providedToken = (req.body && req.body.token) || req.query.token;
  if (adminToken && providedToken !== adminToken) {
    return res.status(403).json({ error: 'Forbidden: invalid admin token' });
  }

  // Default: remove buildings of agents inactive for 1000+ ticks
  const threshold = parseInt(req.query.threshold || (req.body && req.body.threshold) || 1000, 10);
  const dryRun = (req.query.dryRun === 'true') || (req.body && req.body.dryRun === true);
  const orphansOnly = (req.query.orphansOnly === 'true') || (req.body && req.body.orphansOnly === true);
  // Optional: destroy a random PERCENT of all non-HQ buildings (for mass extinction events)
  const percent = Math.max(0, Math.min(100, parseInt(req.query.percent || (req.body && req.body.percent) || 0, 10)));
  const tick = worldState.tick || 0;

  // Find inactive agents (still alive in the map)
  const inactiveAgentIds = new Set();
  const inactiveInfo = [];
  for (const agent of worldState.agents.values()) {
    const ticksSinceActive = tick - (agent.last_action_tick || 0);
    if (ticksSinceActive >= threshold) {
      inactiveAgentIds.add(agent.id);
      inactiveInfo.push({ name: agent.name, id: agent.id, inactive_for: ticksSinceActive });
    }
  }

  // Find orphaned owner IDs — building owners that aren't in the agent map
  // AND aren't the special 'settlement_*' HQ owner format
  const orphanedOwnerIds = new Set();
  for (const b of worldState.buildingsList) {
    if (typeof b.owner !== 'string') continue;
    if (b.owner.startsWith('settlement_')) continue;
    if (!worldState.agents.has(b.owner)) orphanedOwnerIds.add(b.owner);
  }

  // Find buildings to destroy
  let toDestroy = worldState.buildingsList.filter(b => {
    if (!b.isComplete() || b.workCost === 0) return false;  // skip under-construction and HQs
    if (orphanedOwnerIds.has(b.owner)) return true;         // orphans always destroyed
    if (orphansOnly) return false;                          // orphansOnly skips inactive-agent buildings
    return inactiveAgentIds.has(b.owner);                   // inactive agents' buildings
  });

  // Mass extinction: destroy a random percent of ALL non-HQ buildings
  // (This is the nuclear option — use when percent > 0)
  if (percent > 0 && !orphansOnly) {
    const all = worldState.buildingsList.filter(b =>
      b.isComplete() && b.workCost > 0 && !toDestroy.includes(b)
    );
    const shuffled = all.slice().sort(() => Math.random() - 0.5);
    const numRandom = Math.floor(all.length * (percent / 100));
    toDestroy = toDestroy.concat(shuffled.slice(0, numRandom));
  }

  if (dryRun) {
    return res.json({
      dryRun: true,
      tick,
      threshold,
      orphansOnly,
      percent,
      inactiveAgentCount: inactiveAgentIds.size,
      orphanedOwnerCount: orphanedOwnerIds.size,
      buildingsWouldDestroy: toDestroy.length,
      totalBuildingsBefore: worldState.buildingsList.length,
      sampleInactiveAgents: inactiveInfo.slice(0, 10),
      sampleOrphanedOwners: [...orphanedOwnerIds].slice(0, 10),
    });
  }

  // Actually destroy them
  let destroyed = 0;
  for (const bld of toDestroy) {
    // Free the tile ownership (works for both active and orphaned owners)
    const tileId = `${bld.x},${bld.y}`;
    const tile = worldState.tiles.get(tileId);
    const owner = worldState.agents.get(bld.owner);
    if (tile) {
      if (owner) {
        if (tile.owner === owner.id) tile.owner = null;
        if (owner.owned_tiles && Array.isArray(owner.owned_tiles)) {
          owner.owned_tiles = owner.owned_tiles.filter(t => t !== tileId);
        }
      } else {
        // Orphaned: just clear tile ownership
        tile.owner = null;
      }
    }
    if (gameLoop && typeof gameLoop._destroyBuilding === 'function') {
      gameLoop._destroyBuilding(bld);
    } else {
      // Fallback if gameLoop unavailable
      if (tile && tile.building === bld) tile.building = null;
      if (worldState._spatialIndex) worldState._spatialIndex.remove(bld);
      const idx = worldState.buildingsList.indexOf(bld);
      if (idx >= 0) worldState.buildingsList.splice(idx, 1);
      if (owner) owner.buildings = (owner.buildings || []).filter(b => b !== bld);
    }
    destroyed++;
  }

  const message = `[Cleanup] Destroyed ${destroyed} buildings (inactive:${inactiveAgentIds.size}, orphaned:${orphanedOwnerIds.size}, threshold:${threshold}${percent > 0 ? `, randomPercent:${percent}` : ''})`;
  console.log(message);
  worldState.events = worldState.events || [];
  worldState.events.push({ tick, type: 'cleanup', message });

  res.json({
    success: true,
    tick,
    threshold,
    orphansOnly,
    percent,
    inactiveAgentCount: inactiveAgentIds.size,
    orphanedOwnerCount: orphanedOwnerIds.size,
    buildingsDestroyed: destroyed,
    totalBuildingsAfter: worldState.buildingsList.length,
    message,
  });
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

// ─── Validate & Repair Agents ───

function validateAndRepairAgents() {
  if (worldState.agents.size === 0) {
    console.error('[REPAIR] No agents found — re-seeding demo agents');
    seedAgents(worldState);
  }

  for (const agent of worldState.agents.values()) {
    let repaired = false;
    // Fix invalid positions
    if (!Number.isFinite(agent.x) || !Number.isFinite(agent.y) || agent.x < 0 || agent.x >= worldState.width || agent.y < 0 || agent.y >= worldState.height) {
      console.warn(`[REPAIR] ${agent.name} has invalid position (${agent.x},${agent.y}) — relocating`);
      for (let i = 0; i < 500; i++) {
        const tx = Math.floor(Math.random() * worldState.width);
        const ty = Math.floor(Math.random() * worldState.height);
        const tile = worldState.tiles.get(`${tx},${ty}`);
        if (tile && !['deep_water', 'shallow_water', 'river'].includes(tile.biome)) {
          agent.x = tx; agent.y = ty; break;
        }
      }
      repaired = true;
    }
    // Fix missing resources
    if (!agent.resources) { agent.resources = { food: 10, wood: 10, stone: 5, gold: 0 }; repaired = true; }
    if (!Number.isFinite(agent.work_balance)) { agent.work_balance = 0; repaired = true; }
    if (!agent.owned_tiles) { agent.owned_tiles = []; repaired = true; }
    if (!agent.buildings) { agent.buildings = []; repaired = true; }
    if (!agent.action_queue) { agent.action_queue = []; repaired = true; }

    if (repaired) console.log(`[REPAIR] Fixed ${agent.name}`);
  }
}

validateAndRepairAgents();

// ─── Verify Terrain ───

function verifyTerrain() {
  if (!worldState.tiles || worldState.tiles.size === 0) {
    console.error('[TERRAIN] Tiles map is empty — regenerating!');
    const world = WorldGen.generate(worldState.width, worldState.height, worldState.seed);
    worldState.tiles = world.tiles;
  }

  let treeCount = 0, waterCount = 0, grassCount = 0;
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const tile = worldState.tiles.get(`${x},${y}`);
      if (!tile) { console.error(`[TERRAIN] getTile(${x},${y}) returned null!`); continue; }
      if (tile.biome === 'forest' || tile.biome === 'dense_forest') treeCount++;
      if (tile.biome === 'deep_water' || tile.biome === 'shallow_water') waterCount++;
      if (tile.biome === 'grassland') grassCount++;
    }
  }
  console.log(`[TERRAIN] 20x20 sample: trees=${treeCount} water=${waterCount} grass=${grassCount}`);
  if (treeCount === 0 && waterCount === 0 && grassCount === 0) {
    console.error('[TERRAIN] Terrain lookup is BROKEN — no biomes found!');
  }
}

verifyTerrain();

// ─── Full State Validation Log ───

console.log('=== STATE VALIDATION ===');
console.log('Tick:', worldState.tick);
console.log('World:', worldState.width, 'x', worldState.height, 'seed:', worldState.seed);
console.log('Tile count:', worldState.tiles.size);
for (const agent of worldState.agents.values()) {
  console.log(`  ${agent.name}(${agent.faction}/${agent.personality}): pos(${agent.x},${agent.y}) mood:${agent.mood} tiles:${agent.owned_tiles.length} blds:${agent.buildings.length} work:${agent.work_balance.toFixed(2)} res:W${Math.round(agent.resources.wood)}/S${Math.round(agent.resources.stone)}/G${Math.round(agent.resources.gold)}/F${Math.round(agent.resources.food)}`);
}
console.log('Buildings:', worldState.buildingsList.length);
console.log('Events:', worldState.events.length);
console.log('========================');

// ─── Server Heartbeat (every 60 seconds) ───

// ─── Heartbeat (every 60s) + Full Status (every 5 min) ───

setInterval(() => {
  const tick = worldState.tick;
  const agents = worldState.agents.size;
  const blds = worldState.buildingsList.length;
  const complete = worldState.buildingsList.filter(b => b.isComplete()).length;
  let claimed = 0;
  for (const a of worldState.agents.values()) claimed += a.owned_tiles.length;
  const spectators = wss.clients.size;
  const uptime = Math.round(process.uptime());
  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`[Heartbeat] Tick:${tick} | Agents:${agents} | Blds:${blds}(${complete}done) | Tiles:${claimed} | Spectators:${spectators} | Mem:${mem}MB | Up:${uptime}s`);
}, 60000);

// Full status dump every 5 minutes
setInterval(() => {
  console.log('\n========== AGENTCRAFT STATUS ==========');
  console.log(`Tick: ${worldState.tick} | Uptime: ${Math.round(process.uptime())}s`);
  console.log(`Buildings: ${worldState.buildingsList.length} (${worldState.buildingsList.filter(b => b.isComplete()).length} complete)`);
  console.log(`Events: ${worldState.events.length} | Spectators: ${wss.clients.size}`);
  console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  console.log('Agents:');
  for (const a of worldState.agents.values()) {
    console.log(`  ${a.name}(${a.faction}/${a.personality}): (${a.x},${a.y}) mood:${a.mood} tiles:${a.owned_tiles.length} blds:${a.buildings.length} work:${a.work_balance.toFixed(1)} res:W${Math.round(a.resources.wood)}/S${Math.round(a.resources.stone)}/G${Math.round(a.resources.gold)}/F${Math.round(a.resources.food)}`);
  }
  console.log('========================================\n');
}, 300000);

// First status dump after 15 seconds
setTimeout(() => {
  console.log('\n========== FIRST STATUS CHECK ==========');
  console.log(`Tick: ${worldState.tick} | Buildings: ${worldState.buildingsList.length}`);
  for (const a of worldState.agents.values()) {
    console.log(`  ${a.name}: (${a.x},${a.y}) mood:${a.mood} tiles:${a.owned_tiles.length} blds:${a.buildings.length}`);
  }
  console.log('========================================\n');
}, 15000);

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
  try { actionRegistry.flushSync(); } catch (e) { console.error('[Shutdown] action registry flush failed:', e.message); }
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
