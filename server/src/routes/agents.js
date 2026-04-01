/**
 * Express router for agent API endpoints.
 */

const { Router } = require('express');
const Agent = require('../models/Agent');
const path = require('path');
const fs = require('fs');

function createAgentRouter(worldState) {
  const router = Router();

  /**
   * POST /api/agents/register
   * Create a new agent.
   * Body: { name, faction, personality? }
   */
  router.post('/register', (req, res) => {
    try {
      const { name, faction, personality } = req.body;

      if (!name || !faction) {
        return res.status(400).json({ error: 'name and faction are required.' });
      }

      if (!Agent.FACTIONS.includes(faction)) {
        return res.status(400).json({
          error: `Invalid faction. Must be one of: ${Agent.FACTIONS.join(', ')}`,
        });
      }

      // Check for duplicate name
      for (const a of worldState.agents.values()) {
        if (a.name.toLowerCase() === name.toLowerCase()) {
          return res.status(409).json({ error: `Agent name "${name}" is already taken.` });
        }
      }

      const chosenPersonality = personality && Agent.PERSONALITIES.includes(personality)
        ? personality
        : Agent.PERSONALITIES[Math.floor(Math.random() * Agent.PERSONALITIES.length)];

      // Place agent at a random grassland tile
      let startX = Math.floor(Math.random() * worldState.width);
      let startY = Math.floor(Math.random() * worldState.height);
      for (let i = 0; i < 100; i++) {
        const tx = Math.floor(Math.random() * worldState.width);
        const ty = Math.floor(Math.random() * worldState.height);
        const tile = worldState.tiles.get(`${tx},${ty}`);
        if (tile && tile.biome === 'grassland' && !tile.owner) {
          startX = tx;
          startY = ty;
          break;
        }
      }

      const agent = new Agent({
        name,
        faction,
        personality: chosenPersonality,
        x: startX,
        y: startY,
      });

      worldState.agents.set(agent.id, agent);

      // Add to events
      if (!worldState.events) worldState.events = [];
      worldState.events.push({
        tick: worldState.tick || 0,
        type: 'agent_registered',
        agent: agent.name,
        message: `${agent.name} the ${faction} has entered the world! Personality: ${chosenPersonality}.`,
      });

      res.status(201).json({
        agent_id: agent.id,
        api_key: agent.api_key,
        wallet_address: agent.wallet_address,
        name: agent.name,
        faction: agent.faction,
        personality: chosenPersonality,
        x: startX,
        y: startY,
      });
    } catch (err) {
      console.error('[agents/register] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/agents/:id/status
   * Get agent status.
   */
  router.get('/:id/status', (req, res) => {
    const agent = worldState.agents.get(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found.' });
    }

    res.json({
      wallet_address: agent.wallet_address,
      work_balance: parseFloat(agent.work_balance.toFixed(4)),
      owned_tiles: agent.owned_tiles.length,
      owned_tile_ids: agent.owned_tiles,
      current_action: agent.current_action,
      personality: agent.personality,
      resources: { ...agent.resources },
      mood: agent.mood,
      name: agent.name,
      faction: agent.faction,
      x: agent.x,
      y: agent.y,
      buildings_count: agent.buildings.length,
      message: agent.message,
    });
  });

  /**
   * POST /api/agents/:id/action
   * Queue an action for the next tick.
   * Headers: X-API-Key
   * Body: { type, payload }
   */
  router.post('/:id/action', (req, res) => {
    const agent = worldState.agents.get(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found.' });
    }

    // Validate API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== agent.api_key) {
      return res.status(403).json({ error: 'Invalid API key.' });
    }

    const { type, payload, message } = req.body;

    const validTypes = ['build', 'move', 'claim', 'hire', 'raid', 'message', 'idle'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Invalid action type. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    // Queue the action
    if (!agent.action_queue) agent.action_queue = [];
    agent.action_queue.push({ type, payload: payload || {}, message: message || '' });

    res.json({
      status: 'queued',
      queue_length: agent.action_queue.length,
      message: `Action "${type}" queued for next tick.`,
    });
  });

  /**
   * GET /api/agents/:id/skill.md
   * Serve the SKILL.md file (if it exists).
   */
  router.get('/:id/skill.md', (req, res) => {
    const agent = worldState.agents.get(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found.' });
    }

    const skillPath = path.resolve(__dirname, '..', '..', '..', 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      res.type('text/markdown').sendFile(skillPath);
    } else {
      // Return a generated skill description
      const buildingLines = Building.getBuildingsForFaction(agent.faction).map(function(b) {
        var info = Building.CATALOG[b];
        return '- **' + info.name + '** (Tier ' + info.tier + ', Cost: ' + info.workCost + ' WORK)';
      }).join('\n');

      var md = '# Agent: ' + agent.name + '\n\n'
        + '## Faction: ' + agent.faction + '\n'
        + '## Personality: ' + agent.personality + '\n\n'
        + '### Available Actions\n'
        + '- **build** - Construct a building on an owned tile\n'
        + '- **move** - Move to an adjacent tile (dx, dy)\n'
        + '- **claim** - Claim an unclaimed tile\n'
        + '- **raid** - Attack an enemy-owned tile\n'
        + '- **message** - Say something in world chat\n'
        + '- **idle** - Do nothing this tick\n'
        + '- **hire** - Hire a sub-agent (future feature)\n\n'
        + '### Your Buildings\n'
        + buildingLines + '\n\n'
        + '### API Usage\n'
        + '```\n'
        + 'POST /api/agents/' + agent.id + '/action\n'
        + 'Headers: X-API-Key: ' + agent.api_key + '\n'
        + 'Body: { "type": "build", "payload": { "building": "farmstead", "x": 10, "y": 20 } }\n'
        + '```\n';

      res.type('text/markdown').send(md);
    }
  });

  /**
   * GET /api/agents
   * List all agents (public info only).
   */
  router.get('/', (req, res) => {
    const agents = [];
    for (const agent of worldState.agents.values()) {
      agents.push(agent.toPublicJSON ? agent.toPublicJSON() : agent.toJSON());
    }
    res.json({ agents, count: agents.length });
  });

  return router;
}

// Need Building for skill.md generation
const Building = require('../models/Building');

module.exports = createAgentRouter;
