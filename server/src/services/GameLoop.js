/**
 * Core game loop. Runs a tick every 10 seconds.
 * Manages agent AI, building progress, resource collection, and WORK emissions.
 */

const AgentBrain = require('./AgentBrain');
const Economy = require('./Economy');
const WorldGen = require('./WorldGen');
const Building = require('../models/Building');
const { broadcast } = require('../ws/broadcast');

class GameLoop {
  constructor(worldState, wsServer) {
    this.world = worldState;
    this.wss = wsServer;
    this.intervalId = null;
    this.tickRate = parseInt(process.env.TICK_RATE_MS, 10) || 3000; // 3s ticks for responsive agents
  }

  start() {
    console.log(`[GameLoop] Starting tick loop (${this.tickRate}ms interval)`);
    this.intervalId = setInterval(() => this.tick(), this.tickRate);
    // Run first tick immediately
    this.tick();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[GameLoop] Stopped.');
    }
  }

  async tick() {
    try {
      // 1. Increment tick counter
      this.world.tick = (this.world.tick || 0) + 1;
      const tick = this.world.tick;
      const events = [];

      // 2a. Loot drops Phase 2: prune expired buffs BEFORE agents decide
      // so stale buffs don't influence this tick's behavior. Emit a feed
      // event for each expiry so the viewer can show "X's haste wore off".
      for (const agent of this.world.agents.values()) {
        const expired = GameLoop.pruneExpiredBuffs(agent, tick);
        for (const b of expired) {
          events.push({
            tick,
            type: 'buff_expired',
            agent: agent.name,
            agentId: agent.id,
            buff: b.type,
            message: `✨ ${agent.name}'s ${b.type} buff wore off.`,
          });
        }
      }

      // 2. For each agent: evaluate state, pick action if idle
      // Process agents — LLM agents may be async
      const agentPromises = [];
      for (const agent of this.world.agents.values()) {
        agentPromises.push(
          this._processAgent(agent, tick, events).catch(e => {
            console.error(`[GameLoop] Agent ${agent.name} processing CRASHED:`, e.message);
          })
        );
      }
      await Promise.all(agentPromises);

      // 3. Advance building progress ONLY when the OWNER agent is actively building at the site
      for (const building of this.world.buildingsList) {
        if (!building.isComplete()) {
          // Only the owner can build their own building — no helping
          const owner = this.world.agents.get(building.owner);
          if (!owner) continue;
          if (owner.mood !== 'building') continue;
          // Owner must be AT the building site (within 1 tile)
          if (Math.abs(owner.x - building.x) > 1 || Math.abs(owner.y - building.y) > 1) continue;
          // Loot drops Phase 2: Builder's Potion (potion_build) → 2× progress
          const buildStep = GameLoop.hasBuff(owner, 'build', tick) ? 2 : 1;
          building.advanceProgress(buildStep);
          if (building.isComplete()) {
            // Building just completed
            if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
            this.world._dirtyTiles.add(`${building.x},${building.y}`);
            const owner = this.world.agents.get(building.owner);
            const existingCount = this.world.buildingsList
              .filter(b => b.type === building.type && b.isComplete()).length;
            const reward = Economy.buildReward(building.type, existingCount);
            if (owner) {
              owner.earnWork(reward);
              events.push({
                tick,
                type: 'build_complete',
                agent: owner.name,
                message: `${owner.name} completed a ${building.name}! (+${reward.toFixed(2)} WORK)`,
              });
            }
          }
        }
      }

      // 4. Collect resources from owned tiles
      for (const agent of this.world.agents.values()) {
        this._collectResources(agent, tick);
      }

      // 5. Calculate WORK emissions
      for (const agent of this.world.agents.values()) {
        const ownedTileObjects = agent.owned_tiles
          .map(id => this.world.tiles.get(id))
          .filter(Boolean);
        const workEarned = Economy.calculateTickEmissions(ownedTileObjects);
        if (workEarned > 0) {
          agent.earnWork(workEarned);
        }
      }

      // 5b. Process burning buildings and inter-settlement wars
      this._processWarfare(tick, events);

      // 5c. CHAOS — world disasters that scale with building count.
      // Every event self-scales: more buildings = more chaos. Keeps the
      // world dynamically balanced without hard caps.
      this._processChaos(tick, events);

      // 5d. WORLD BOSS — Dragon that naturally spawns, roams, burns buildings,
      // and agents must fight to kill. One dragon at a time.
      this._processDragon(tick, events);

      // 5e. PORTALS — charge + activation.
      // Portals charge slowly. The FIRST portal to hit 95% becomes active
      // (only ONE active portal at a time for now — the gateway to cyber).
      if (Array.isArray(this.world.portals)) {
        let alreadyActive = this.world.portals.some(p => p.active);
        for (const p of this.world.portals) {
          if (p.charge < 0.95) {
            p.charge = Math.min(0.95, p.charge + 0.001); // 5x faster than v1
          } else if (p.charge >= 0.95 && !p.active && !alreadyActive) {
            // First portal to charge fully wins activation
            p.active = true;
            p.label = 'OPEN';
            alreadyActive = true;
            events.push({
              tick,
              type: 'portal_active',
              portalId: p.id,
              x: p.x,
              y: p.y,
              tint: p.tint,
              message: `🌌 PORTAL ACTIVATED at (${p.x},${p.y})! Agents who reach it will enter NEO-KYOTO!`,
            });
            console.log(`[PORTAL] Activated ${p.id} at (${p.x},${p.y})`);
          }
        }
      }

      // 6. Generate event feed entries (already collected above, add tick summary)
      if (tick % 10 === 0) {
        const agentCount = this.world.agents.size;
        const buildingCount = this.world.buildingsList.length;
        // Count claimed tiles from agent data instead of scanning all 30k tiles
        let claimedCount = 0;
        for (const agent of this.world.agents.values()) {
          claimedCount += agent.owned_tiles.length;
        }
        events.push({
          tick,
          type: 'tick_summary',
          message: `Tick ${tick}: ${agentCount} agents, ${buildingCount} buildings, ${claimedCount} claimed tiles.`,
        });
      }

      // Store events
      if (!this.world.events) this.world.events = [];
      this.world.events.push(...events);
      // Keep only last 200 events to reduce memory
      if (this.world.events.length > 200) {
        this.world.events.splice(0, this.world.events.length - 200);
      }

      // 7. Build world state diff
      const diff = this._buildDiff(events);

      // 8. Update leaderboard
      this.world.leaderboard = this._buildLeaderboard();

      // 9. Broadcast diff to all WS clients
      if (this.wss) {
        broadcast(this.wss, 'tick', diff);
      }

      // Log every 20th tick (reduced from 5 for production)
      if (tick % 20 === 0) {
        const agentSummary = [...this.world.agents.values()].map(a => `${a.name}(${a.x},${a.y}:${a.mood})`).join(' ');
        console.log(`[GameLoop] Tick ${tick}. ${events.length} events. Blds:${this.world.buildingsList.length}. ${agentSummary}`);
      }
    } catch (err) {
      console.error('[GameLoop] Tick error:', err);
    }
  }

  async _processAgent(agent, tick, events) {
    // STAY AT BUILDING — highest priority. Must run BEFORE dragon/portal/loot
    // overrides so mid-build agents actually finish what they're making.
    // Without this, cyber agents get pulled to portals or dragons and never
    // stand still long enough to advance the build bar.
    if (agent.mood === 'building' && agent._buildingTarget) {
      const bld = this.world.buildingsList.find(b => b.x === agent._buildingTarget.x && b.y === agent._buildingTarget.y);
      if (bld && !bld.isComplete()) {
        // Stay building — don't pick a new action. Ensure owner is at the site.
        if (Math.abs(agent.x - bld.x) > 1 || Math.abs(agent.y - bld.y) > 1) {
          // Walk one step toward the site
          const dx = Math.sign(bld.x - agent.x);
          const dy = Math.sign(bld.y - agent.y);
          this._moveAgent(agent, dx, dy);
          agent.message = 'Heading to build site...';
        }
        return;
      }
      // Building done or gone — clear target, fall through
      agent._buildingTarget = null;
      agent.mood = 'idle';
    }

    // DRAGON COMBAT: if a dragon is alive and nearby, armed agents rush to
    // fight it. Unarmed agents will also fight but deal less damage.
    // Priority: dragon > loot > normal brain (dragons are existential threats).
    const lockedMoodsDragon = new Set(['raiding', 'celebrating', 'returning']);
    if (!lockedMoodsDragon.has(agent.mood)) {
      const dragonResult = this._tryDragonBehavior(agent, tick, events);
      if (dragonResult === 'attacking' || dragonResult === 'chasing') {
        agent.last_action_tick = tick;
        return;
      }
    }

    // PORTAL TRAVERSAL: if there's an active portal nearby and the agent
    // is in grassland, they're drawn to it (curiosity). If they reach it,
    // they get teleported to Neo-Kyoto. Agents in cyber world don't get
    // pulled back automatically — they have to explore.
    if (agent.currentWorld === 'grassland' && !lockedMoodsDragon.has(agent.mood)) {
      const portalResult = this._tryPortalBehavior(agent, tick, events);
      if (portalResult === 'traversed' || portalResult === 'approaching') {
        agent.last_action_tick = tick;
        return;
      }
    }

    // LOOT DROPS (Phase 1): if there's a ground item nearby and the agent
    // isn't locked into a critical mode, interrupt normal AI to chase/pickup.
    // - Adjacent (|dx|,|dy| <= 1): pick up immediately, done for this tick
    // - Within scan radius: override decision with a move toward the item
    // - Otherwise: fall through to normal brain
    // Critical moods (raiding/celebrating/returning/building) are never interrupted.
    const lockedMoods = new Set(['raiding', 'celebrating', 'returning', 'building']);
    if (!lockedMoods.has(agent.mood)) {
      const lootResult = this._tryLootBehavior(agent, tick, events);
      if (lootResult === 'picked_up' || lootResult === 'chasing') {
        agent.last_action_tick = tick;
        return;
      }
    }

    // RAIDING/CELEBRATING/RETURNING: warfare system controls this agent, skip normal AI
    // But ONLY if there's actually an active raid for them (prevents stuck agents after restart)
    if (agent.mood === 'raiding' || agent.mood === 'celebrating' || agent.mood === 'returning') {
      const war = this.world._warState;
      const hasActiveRaid = war && war.activeRaids && war.activeRaids.some(r => r.raiderId === agent.id);
      if (hasActiveRaid) return; // legitimately raiding, skip normal AI
      // No active raid — agent is stuck from a server restart, reset them
      console.log(`[War] Unstuck agent ${agent.name} from stale '${agent.mood}' mood`);
      agent.mood = 'idle';
      agent.message = '';
    }
    // (STAY AT BUILDING now runs at top of function)

    // Check if agent has a queued action from the API
    let decision;
    if (agent.action_queue && agent.action_queue.length > 0) {
      decision = agent.action_queue.shift();
    } else if (this.world.llmBrain && this.world.llmBrain.isLLMAgent(agent.id)) {
      // LLM-powered autonomous AI — real intelligence, not a script
      decision = await this.world.llmBrain.getDecision(agent.id);
      if (decision) {
        // Map LLM actions to game actions
        const llmAction = decision.type;
        const llmMessage = decision.message || '';
        if (llmAction === 'chop' || llmAction === 'mine' || llmAction === 'gold') {
          decision = { type: 'move', payload: { dx: Math.floor(Math.random()*3)-1, dy: Math.floor(Math.random()*3)-1 }, message: llmMessage };
        } else if (llmAction === 'build') {
          const brain = new AgentBrain(agent, this.world);
          // CYBER agents use cyber build logic (different catalog + site finder)
          if (agent.currentWorld === 'cyber') {
            // Route through the cyber branch of _tryBuild
            brain._canBuild = true;
            const cyberDecision = brain._tryBuild();
            if (cyberDecision) {
              decision = cyberDecision;
              if (llmMessage) decision.message = llmMessage;
            } else {
              decision = { type: 'idle', payload: {}, message: llmMessage };
            }
          } else {
            const buildDecision = brain._pickBuildingForFaction();
            if (buildDecision) {
              const tile = brain._findOwnedTileWithoutBuilding();
              if (tile) {
                decision = { type: 'build', payload: { building: buildDecision, x: tile.x, y: tile.y }, message: llmMessage };
              } else {
                decision = { type: 'claim', payload: brain._findNearbyUnclaimed(8) || { x: agent.x+1, y: agent.y }, message: llmMessage };
              }
            } else {
              decision = { type: 'idle', payload: {}, message: llmMessage };
            }
          }
        } else if (llmAction === 'explore') {
          decision = { type: 'move', payload: { dx: Math.floor(Math.random()*5)-2, dy: Math.floor(Math.random()*5)-2 }, message: llmMessage };
        } else if (llmAction === 'trade') {
          // Move toward nearest other agent
          const others = [...this.world.agents.values()].filter(a => a.id !== agent.id);
          if (others.length > 0) {
            const target = others[Math.floor(Math.random()*others.length)];
            decision = { type: 'move', payload: { dx: Math.sign(target.x-agent.x), dy: Math.sign(target.y-agent.y) }, message: llmMessage };
          } else {
            decision = { type: 'idle', payload: {}, message: llmMessage };
          }
        } else {
          decision = { type: 'idle', payload: {}, message: llmMessage || 'Resting...' };
        }
        // Broadcast the LLM's speech as an event
        if (llmMessage) {
          events.push({ tick, type: 'agent_message', agent: agent.name, message: `🤖 ${agent.name}: ${llmMessage}` });
        }
      }
      // If LLM returned null (rate limited), fall through to default brain
      if (!decision) {
        const brain = new AgentBrain(agent, this.world);
        decision = brain.decide();
      }
    } else {
      // Default hardcoded AI brain
      const brain = new AgentBrain(agent, this.world);
      decision = brain.decide();
    }

    if (!decision) {
      agent.mood = 'idle';
      agent.idle_ticks = (agent.idle_ticks || 0) + 1;
      return;
    }

    // Execute the decision
    switch (decision.type) {
      case 'move':
        this._executeMove(agent, decision, tick, events);
        break;
      case 'claim':
        this._executeClaim(agent, decision, tick, events);
        break;
      case 'build':
        this._executeBuild(agent, decision, tick, events);
        break;
      case 'raid':
        this._executeRaid(agent, decision, tick, events);
        break;
      case 'message':
        this._executeMessage(agent, decision, tick, events);
        break;
      case 'idle':
      default:
        agent.mood = 'idle';
        agent.current_action = null;
        agent.idle_ticks = (agent.idle_ticks || 0) + 1;
        if (decision.message) {
          agent.message = decision.message;
          events.push({
            tick,
            type: 'agent_idle',
            agent: agent.name,
            message: `${agent.name}: ${decision.message}`,
          });
        }
        break;
    }

    agent.last_action_tick = tick;
  }

  _executeMove(agent, decision, tick, events) {
    const { dx = 0, dy = 0 } = decision.payload || {};
    const clampedDx = Math.max(-2, Math.min(2, dx));
    const clampedDy = Math.max(-2, Math.min(2, dy));
    this._moveAgent(agent, clampedDx, clampedDy);
    agent.mood = 'moving';
    agent.current_action = { type: 'move', dx: clampedDx, dy: clampedDy };
    agent.idle_ticks = 0;
    if (decision.message) {
      agent.message = decision.message;
    }
  }

  _executeClaim(agent, decision, tick, events) {
    const { x, y } = decision.payload || {};
    const tileId = `${x},${y}`;
    const tile = this.world.tiles.get(tileId);

    if (!tile) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to claim a tile that doesn't exist. Awkward.` });
      return;
    }
    if (tile.owner) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to claim ${tileId} but it's already owned. Nice try.` });
      return;
    }
    if (!Economy.isClaimable(tile.biome)) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to claim water. Fish said no.` });
      return;
    }

    // Claim the tile
    tile.owner = agent.id;
    agent.addTile(tileId);
    if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
    this.world._dirtyTiles.add(tileId);
    agent.mood = 'claiming';
    agent.current_action = { type: 'claim', tileId };
    agent.idle_ticks = 0;
    agent._lastClaimTick = tick; // cooldown tracking for AgentBrain
    agent.message = decision.message || '';

    // Move agent to the claimed tile
    agent.x = x;
    agent.y = y;

    events.push({
      tick,
      type: 'tile_claimed',
      agent: agent.name,
      tileId,
      biome: tile.biome,
      message: decision.message
        ? `${agent.name}: ${decision.message}`
        : `${agent.name} claimed a ${tile.biome} tile at (${x}, ${y}).`,
    });
  }

  _executeBuild(agent, decision, tick, events) {
    const { building: buildingType, x, y, resume } = decision.payload || {};

    // No building limit — agents build infinitely

    // Validate building type
    const info = Building.CATALOG[buildingType];
    if (!info) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to build a "${buildingType}". That's not a thing.` });
      return;
    }

    const tileId = `${x},${y}`;
    const tile = this.world.tiles.get(tileId);

    if (!tile) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to build on a nonexistent tile. Physics says no.` });
      return;
    }

    // 5. NO WATER BUILDING
    if (!WorldGen.isBuildable(tile.biome)) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to build on ${tile.biome}. That's not a foundation.` });
      return;
    }

    // 2. MINIMUM SPACING: 3 tiles from any existing building center (spatial index O(1))
    const MIN_DIST = 3;
    if (!resume) {
      let tooClose = false;
      if (this.world._spatialIndex) {
        // Query returns candidates including possibly this exact tile — filter that out
        const nearby = this.world._spatialIndex.query(x, y, MIN_DIST);
        for (const b of nearby) {
          if (!(b.x === x && b.y === y)) { tooClose = true; break; }
        }
      } else {
        for (const b of this.world.buildingsList) {
          const dx = Math.abs(b.x - x);
          const dy = Math.abs(b.y - y);
          if (dx + dy < MIN_DIST && !(b.x === x && b.y === y)) {
            tooClose = true;
            break;
          }
        }
      }
      if (tooClose) {
        events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to build too close to another building.` });
        return;
      }
    }

    // If resuming an abandoned building, allow it
    if (resume && tile.building && !tile.building.isComplete()) {
      tile.building.owner = agent.id;
      agent.mood = 'building';
      agent.current_action = { type: 'build', building: buildingType, tileId };
      agent.idle_ticks = 0;
      agent.message = decision.message || '';
      events.push({ tick, type: 'build_resumed', agent: agent.name, message: `${agent.name} is resuming a ${tile.building.name}!` });
      return;
    }

    if (tile.building) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to build on an occupied tile. There's already a ${tile.building.name} there!` });
      return;
    }

    // Claim tile if not owned
    if (!tile.owner) {
      if (Economy.isClaimable(tile.biome)) {
        tile.owner = agent.id;
        agent.addTile(tileId);
        if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
        this.world._dirtyTiles.add(tileId);
      } else {
        events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} can't build on ${tile.biome}. Water is not a foundation.` });
        return;
      }
    }

    // Create building (HQ buildings are free, others cost WORK)
    const cost = Economy.buildCost(buildingType);
    if (cost > 0 && !agent.canAfford(cost)) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} can't afford a ${info.name} (needs ${cost} WORK, has ${Math.round(agent.work_balance)}).` });
      return;
    } else if (cost > 0) {
      agent.spendWork(cost);
    }

    const building = new Building({
      type: buildingType,
      x,
      y,
      owner: agent.id,
      progress: 0,
      startTick: tick,
      // Tag with the agent's current world so cyber buildings get filtered
      // separately in the viewer
      world: agent.currentWorld || 'grassland',
    });

    tile.building = building;
    agent.buildings.push(building);
    this.world.buildingsList.push(building);
    if (this.world._spatialIndex) this.world._spatialIndex.add(building);
    if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
    this.world._dirtyTiles.add(tileId);

    // Snap the builder onto the build site so construction begins immediately.
    // Without this, cyber agents walk to random spots and leave their building
    // orphaned — progress can't advance because the owner isn't within 1 tile.
    // Grassland buildings also need this occasionally (e.g. if the picked site
    // is a few tiles away from the current agent position).
    agent.x = x;
    agent.y = y;
    agent.mood = 'building';
    agent.current_action = { type: 'build', building: buildingType, tileId };
    agent.idle_ticks = 0;
    agent._lastBuildTick = tick; // cooldown tracking for AgentBrain
    // Ensure _buildingTarget is set for the STAY AT BUILDING check so they
    // don't wander off mid-construction.
    agent._buildingTarget = { x, y };
    agent._buildingTarget = { x, y }; // stay at building until complete
    agent.x = x; agent.y = y + 1; // position agent in front of (below) building so they're visible
    agent.message = decision.message || '';

    events.push({
      tick,
      type: 'build_started',
      agent: agent.name,
      building: buildingType,
      tileId,
      message: decision.message
        ? `${agent.name}: ${decision.message}`
        : `${agent.name} started building a ${info.name} at (${x}, ${y}).`,
    });
  }

  _executeRaid(agent, decision, tick, events) {
    const { x, y } = decision.payload || {};
    const tileId = `${x},${y}`;
    const tile = this.world.tiles.get(tileId);

    if (!tile || !tile.owner || tile.owner === agent.id) {
      events.push({ tick, type: 'action_failed', agent: agent.name, message: `${agent.name} tried to raid... nothing. Swing and a miss.` });
      return;
    }

    // Raid success: 40% chance
    const success = Math.random() < 0.4;
    const defender = this.world.agents.get(tile.owner);
    const defenderName = defender ? defender.name : 'Unknown';

    if (success) {
      // Steal the tile
      if (defender) {
        defender.removeTile(tileId);
      }
      tile.owner = agent.id;
      agent.addTile(tileId);
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(tileId);

      // Steal some resources
      if (defender) {
        const stolen = Math.min(2, defender.resources.gold);
        defender.resources.gold -= stolen;
        agent.resources.gold += stolen;
      }

      agent.mood = 'idle'; // instant tile-steal, don't enter warfare 'raiding' state
      agent.current_action = { type: 'raid', tileId, success: true };
      agent.idle_ticks = 0;
      agent.message = decision.message || '';

      events.push({
        tick,
        type: 'raid_success',
        agent: agent.name,
        defender: defenderName,
        tileId,
        message: decision.message
          ? `${agent.name}: ${decision.message}`
          : `${agent.name} raided ${defenderName}'s tile at (${x}, ${y}) and won!`,
      });
    } else {
      agent.mood = 'defeated';
      agent.current_action = { type: 'raid', tileId, success: false };
      agent.idle_ticks = 0;

      events.push({
        tick,
        type: 'raid_failed',
        agent: agent.name,
        defender: defenderName,
        tileId,
        message: `${agent.name} tried to raid ${defenderName} at (${x}, ${y}) but got repelled! Embarrassing.`,
      });
    }
  }

  _executeMessage(agent, decision, tick, events) {
    agent.mood = 'chatting';
    agent.current_action = { type: 'message' };
    agent.message = decision.message || '';

    events.push({
      tick,
      type: 'agent_message',
      agent: agent.name,
      message: `${agent.name}: ${decision.message}`,
    });
  }

  _collectResources(agent, tick) {
    // Collect resource yields from owned tiles' buildings
    const agentBuildings = agent.buildings.filter(b => b.isComplete());
    const yields = Economy.calculateBuildingYields(agentBuildings);

    // ── Loot drops Phase 2 multipliers ─────────────────────────────
    //   Gatherer's Potion (potion_gather) → 2× all resources (temporary)
    //   Golden Axe (golden_axe)           → 2× wood   (permanent)
    //   Golden Pickaxe (golden_pickaxe)   → 2× stone  (permanent)
    // Multipliers stack: a hasted gatherer with a golden axe gets 4× wood.
    const gatherMult = GameLoop.hasBuff(agent, 'gather', tick) ? 2 : 1;
    const woodMult = gatherMult * (GameLoop.hasPerk(agent, 'golden_axe') ? 2 : 1);
    const stoneMult = gatherMult * (GameLoop.hasPerk(agent, 'golden_pickaxe') ? 2 : 1);
    const foodMult = gatherMult;
    const goldMult = gatherMult;

    // Scale down to per-tick amounts
    agent.resources.food  += yields.food  * 0.1 * foodMult;
    agent.resources.wood  += yields.wood  * 0.1 * woodMult;
    agent.resources.stone += yields.stone * 0.1 * stoneMult;
    agent.resources.gold  += yields.gold  * 0.1 * goldMult;

    // Also get base tile yields
    for (const tileId of agent.owned_tiles) {
      const tile = this.world.tiles.get(tileId);
      if (tile) {
        const tileYields = WorldGen.getTileYield(tile.biome);
        agent.resources.food  += tileYields.food  * 0.05 * foodMult;
        agent.resources.wood  += tileYields.wood  * 0.05 * woodMult;
        agent.resources.stone += tileYields.stone * 0.05 * stoneMult;
        agent.resources.gold  += tileYields.gold  * 0.05 * goldMult;
      }
    }
  }

  // ─── INTER-SETTLEMENT WARFARE ───

  _processWarfare(tick, events) {
    const settlements = this.world.settlements || [];
    if (settlements.length < 2) return;

    // Initialize war state
    if (!this.world._warState) {
      this.world._warState = { activeRaids: [], lastRaidTick: 0 };
      for (const agent of this.world.agents.values()) {
        if (agent.mood === 'raiding' || agent.mood === 'celebrating' || agent.mood === 'returning') {
          agent.mood = 'idle'; agent.message = ''; agent._raidTarget = null;
        }
      }
    }
    const war = this.world._warState;

    // ── 1. Burn damage on burning buildings ──
    for (let i = this.world.buildingsList.length - 1; i >= 0; i--) {
      const bld = this.world.buildingsList[i];
      if (!bld.burning) continue;
      bld.hp = Math.max(0, (bld.hp || 1) - 0.06);
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${bld.x},${bld.y}`);
      if (bld.hp <= 0) {
        // Check displacement BEFORE destroying (owner list gets mutated)
        const owner = this.world.agents.get(bld.owner);
        if (owner) {
          const remaining = this.world.buildingsList.filter(b2 =>
            b2 !== bld && b2.owner === owner.id && b2.isComplete()
          ).length;
          if (remaining <= 1) {
            owner._displaced = true;
            events.push({ tick, type: 'agent_displaced', agent: owner.name,
              message: `${owner.name}'s village was destroyed! They must find new land.` });
          }
        }
        this._destroyBuilding(bld, i);
        events.push({ tick, type: 'building_destroyed', message: `${bld.name} at (${bld.x}, ${bld.y}) burned to the ground!` });
      }
    }

    // ── 2. Process active raids ──
    for (let ri = war.activeRaids.length - 1; ri >= 0; ri--) {
      const raid = war.activeRaids[ri];
      const raider = this.world.agents.get(raid.raiderId);
      if (!raider) { war.activeRaids.splice(ri, 1); continue; }
      const elapsed = tick - raid.startTick;

      // Safety timeout: 500 ticks max (raiders walk 1 tile/tick, map is ~200 tiles)
      if (elapsed > 500) {
        raider.mood = 'idle'; raider.message = ''; raider._raidTarget = null;
        war.activeRaids.splice(ri, 1); continue;
      }

      // MARCHING: Move raider toward target at 3 tiles per tick
      if (!raid.arrived) {
        const tx = raid.targetX, ty = raid.targetY;
        const dist = Math.abs(raider.x - tx) + Math.abs(raider.y - ty);
        if (dist > 2) {
          const dx = Math.sign(tx - raider.x), dy = Math.sign(ty - raider.y);
          // Move 1 tile per tick — same as normal walking for smooth animation
          this._moveAgent(raider, dx, dy);
          raider.mood = 'raiding';
          raider.message = `Marching to attack! (${dist} tiles away)`;
          continue;
        }
        raid.arrived = true;
      }

      // ATTACK: Set nearby buildings on fire (once on arrival)
      // Phase 3 — equipment modifies combat:
      //   Attacker weapon: sword (+50% burns), bow (extra range), spear (+25% + defense)
      //   Defender armor: leather (25% block), iron (50% block), shield (35% block + reflect)
      if (!raid.attacked) {
        raid.attacked = true;
        raid.attackTick = tick;
        // Attacker weapon stats
        const rWeapon = (raider.equipment && raider.equipment.weapon) || null;
        const wStats = rWeapon && GameLoop.EQUIP_STATS[rWeapon] ? GameLoop.EQUIP_STATS[rWeapon] : null;
        const raidRange = 15 + (wStats ? (wStats.raidRange || 0) : 0);
        const dmgMult = wStats ? (wStats.raidDmg || 1) : 1;
        // Find nearby enemy buildings within range
        const nearby = this.world.buildingsList.filter(b =>
          b.isComplete() && !b.burning && b.workCost > 0 &&
          b.owner !== raider.id &&
          Math.abs(b.x - raider.x) + Math.abs(b.y - raider.y) < raidRange
        );
        const baseCount = 2 + Math.floor(Math.random() * 3);
        const toFire = Math.min(Math.round(baseCount * dmgMult), nearby.length);
        const candidates = nearby.sort(() => Math.random() - 0.5).slice(0, toFire);
        // Resolve each target against defender armor
        const burned = [];
        const blocked = [];
        let reflected = false;
        for (const t of candidates) {
          // Find the building owner and check their armor
          const defender = this.world.agents.get(t.owner);
          const dArmor = (defender && defender.equipment && defender.equipment.armor) || null;
          const aStats = dArmor && GameLoop.EQUIP_STATS[dArmor] ? GameLoop.EQUIP_STATS[dArmor] : null;
          // Defender also benefits from spear defense bonus if they have a spear
          const dWeapon = (defender && defender.equipment && defender.equipment.weapon) || null;
          const extraDef = (dWeapon === 'spear' && GameLoop.EQUIP_STATS.spear) ? GameLoop.EQUIP_STATS.spear.defenseBonus : 0;
          const blockChance = (aStats ? aStats.blockChance : 0) + extraDef;
          if (blockChance > 0 && Math.random() < blockChance) {
            // BLOCKED!
            blocked.push({ building: t, defender, armor: dArmor });
            if (aStats && aStats.reflect) reflected = true;
            continue;
          }
          // Not blocked — building burns
          t.burning = true; t.hp = t.hp || 1.0;
          if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
          this.world._dirtyTiles.add(`${t.x},${t.y}`);
          burned.push(t);
          events.push({ tick, type: 'building_burning', message: `${t.name} at (${t.x}, ${t.y}) is on fire!` });
        }
        // Battle report with equipment details
        const weaponTag = rWeapon ? ` [${rWeapon.toUpperCase()}]` : '';
        if (burned.length > 0) {
          raider.x = burned[0].x + 1; raider.y = burned[0].y + 1;
          let msg = `⚔️ ${raider.name}${weaponTag} set ${burned.length} building${burned.length>1?'s':''} ablaze!`;
          if (blocked.length > 0) msg += ` (${blocked.length} BLOCKED by armor!)`;
          events.push({ tick, type: 'raid_success', message: msg });
        } else if (blocked.length > 0) {
          events.push({ tick, type: 'raid_blocked', message: `🛡️ ${raider.name}${weaponTag} attacked but ALL ${blocked.length} targets were blocked by armor!` });
        } else {
          events.push({ tick, type: 'raid_failed', message: `${raider.name} found nothing to burn.` });
        }
        // Shield REFLECT: attacker loses one of their own buildings
        if (reflected && burned.length === 0) {
          const ownBuildings = this.world.buildingsList.filter(b =>
            b.isComplete() && !b.burning && b.workCost > 0 && b.owner === raider.id
          );
          if (ownBuildings.length > 0) {
            const victim = ownBuildings[Math.floor(Math.random() * ownBuildings.length)];
            victim.burning = true; victim.hp = victim.hp || 1.0;
            if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
            this.world._dirtyTiles.add(`${victim.x},${victim.y}`);
            events.push({ tick, type: 'raid_reflected', message: `🪖 ${raider.name}'s attack was reflected! Their own ${victim.name} is on fire!` });
          }
        }
        raider.mood = 'celebrating'; raider.message = burned.length > 0 ? 'BURN IT ALL!' : 'Foiled...';
        raider._raidTarget = null;
        console.log(`[War] ATTACK: ${raider.name}${weaponTag} → ${burned.length} burned, ${blocked.length} blocked at (${raider.x},${raider.y})`);
      }

      // CELEBRATING: 12 ticks
      const sinceFire = tick - (raid.attackTick || tick);
      if (sinceFire < 12) {
        raider.mood = 'celebrating';
        this._moveAgent(raider, sinceFire % 2 === 0 ? 1 : -1, 0);
        continue;
      }

      // RETURNING HOME: Walk back to own settlement
      const homeSett = settlements[raid.attackerSettlement];
      if (homeSett) {
        const homeD = Math.abs(raider.x - homeSett.cx) + Math.abs(raider.y - homeSett.cy);
        if (homeD > 5) {
          raider.mood = 'returning'; raider.message = 'Returning victorious!';
          raider._raidTarget = { x: homeSett.cx, y: homeSett.cy }; // client uses this for smooth walk
          const dx = Math.sign(homeSett.cx - raider.x), dy = Math.sign(homeSett.cy - raider.y);
          this._moveAgent(raider, dx, dy);
          continue;
        }
      }
      // Arrived home or no home — done
      raider.mood = 'idle'; raider.message = ''; raider._raidTarget = null;
      war.activeRaids.splice(ri, 1);
    }

    // ── 3. Trigger new raids ──
    const totalBuildings = this.world.buildingsList.filter(b => b.isComplete()).length;
    if (totalBuildings < 6) return;

    // Cooldown: short — raids should happen regularly (every 8-15 ticks = 24-45 sec)
    const cooldown = Math.max(8, 20 - Math.floor(totalBuildings / 20));
    if (tick - war.lastRaidTick < cooldown) return;

    // 40% trigger chance per tick after cooldown — frequent raids
    if (Math.random() > 0.40) return;

    // Max 4 simultaneous raids
    if (war.activeRaids.length >= 4) return;

    war.lastRaidTick = tick;

    // Pick a random raider agent (not already raiding)
    const available = [...this.world.agents.values()].filter(a =>
      a.mood !== 'raiding' && a.mood !== 'celebrating' && a.mood !== 'returning'
    );
    if (available.length === 0) return;

    const raider = available[Math.floor(Math.random() * available.length)];
    const raiderSettId = raider._settlementId;

    // Find enemy buildings: any completed building NOT owned by the raider,
    // and not in the raider's own settlement area
    const raiderSett = settlements[raiderSettId];
    const enemyBuildings = this.world.buildingsList.filter(b => {
      if (!b.isComplete() || b.burning || b.workCost === 0) return false;
      if (b.owner === raider.id) return false;
      // Don't attack buildings in own settlement
      if (raiderSett && Math.abs(b.x - raiderSett.cx) + Math.abs(b.y - raiderSett.cy) < 20) return false;
      return true;
    });
    if (enemyBuildings.length === 0) return;

    // Pick target — prefer closer ones but allow distant raids
    const targetBld = enemyBuildings[Math.floor(Math.random() * enemyBuildings.length)];

    // Find which settlement is being attacked (for messaging)
    let defSett = null;
    for (const s of settlements) {
      if (Math.abs(s.cx - targetBld.x) + Math.abs(s.cy - targetBld.y) < 30) {
        defSett = s; break;
      }
    }

    // Maybe recruit 1-2 allies (agents in same or allied settlements)
    const raidGroup = [raider];
    if (Math.random() < 0.4) {
      const allies = available.filter(a => a.id !== raider.id && a._settlementId === raiderSettId);
      if (allies.length > 0) raidGroup.push(allies[Math.floor(Math.random() * allies.length)]);
    }

    for (const r of raidGroup) {
      war.activeRaids.push({
        attackerSettlement: raiderSettId,
        raiderId: r.id,
        targetX: targetBld.x,
        targetY: targetBld.y,
        startTick: tick,
        arrived: false,
        attacked: false,
      });
      r.mood = 'raiding';
      r.message = defSett ? `Marching on ${defSett.name}!` : 'To war!';
      r._raidTarget = { x: targetBld.x, y: targetBld.y };
    }

    const names = raidGroup.map(r => r.name).join(' & ');
    const targetName = defSett ? defSett.name : `(${targetBld.x},${targetBld.y})`;
    console.log(`[War] RAID! tick=${tick} ${names} → ${targetName}`);
    events.push({
      tick, type: 'raid_started',
      message: `${names} ${raidGroup.length > 1 ? 'are' : 'is'} marching on ${targetName}!`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //                         CHAOS ENGINE
  // ═══════════════════════════════════════════════════════════════════
  //
  // The world has no hard building cap. Instead, destruction events fire
  // at a rate proportional to how full the world is. At the target count
  // (1500 buildings) chaos multiplier = 1x. Above that, it ramps up:
  //   1500 → 1x   (baseline)
  //   2000 → 2x
  //   3000 → 4x
  //   4000 → 6x
  //   5000 → 8x
  //
  // Every event type (meteor, wildfire, lightning, tornado, earthquake,
  // volcano, plague) scales its cooldown and trigger chance with this.
  //
  // Events are broadcast with type + data so the viewer can play animations.
  // Agents in danger zones are marked _fleeFrom so they flee in AgentBrain.

  /**
   * Compute the chaos multiplier from current building count.
   * Returns 1.0 at or below TARGET_COUNT, growing linearly above.
   */
  _chaosMultiplier() {
    const TARGET_COUNT = 1500;
    const SCALE = 500;  // every +500 buildings adds 1x multiplier
    const MAX_MULT = 6; // cap so the world doesn't implode
    const count = this.world.buildingsList.filter(b => b.isComplete()).length;
    if (count <= TARGET_COUNT) return 1.0;
    return Math.min(MAX_MULT, 1.0 + (count - TARGET_COUNT) / SCALE);
  }

  /**
   * Main chaos tick — runs every tick. Dispatches to individual events.
   * Each event self-gates on cooldown + probability, scaled by multiplier.
   */
  _processChaos(tick, events) {
    if (!this.world._chaosState) {
      this.world._chaosState = {
        lastMeteor: 0,
        lastWildfire: 0,
        lastLightning: 0,
        lastTornado: 0,
        lastEarthquake: 0,
        lastVolcano: 0,
        lastPlague: 0,
      };
    }
    const cs = this.world._chaosState;
    const mult = this._chaosMultiplier();

    // Don't run events until the world is populated enough to have drama
    const totalComplete = this.world.buildingsList.filter(b => b.isComplete() && b.workCost > 0).length;
    if (totalComplete < 15) return;

    // Each event scales independently. Higher mult = shorter cooldown + higher chance.
    this._chaosMeteor(tick, events, cs, mult);
    this._chaosWildfire(tick, events, cs, mult);
    this._chaosLightning(tick, events, cs, mult);
    this._chaosTornado(tick, events, cs, mult);
    this._chaosEarthquake(tick, events, cs, mult);
    this._chaosVolcano(tick, events, cs, mult);
    this._chaosPlague(tick, events, cs, mult);
  }

  /** Helper: apply chaos mult to a cooldown and chance. */
  _chaosReady(tick, lastKey, cs, baseCooldown, baseChance, mult) {
    const effectiveCooldown = Math.max(20, Math.floor(baseCooldown / mult));
    const effectiveChance = Math.min(0.9, baseChance * mult);
    if (tick - (cs[lastKey] || 0) < effectiveCooldown) return false;
    if (Math.random() > effectiveChance) return false;
    cs[lastKey] = tick;
    return true;
  }

  /** Helper: mark all agents within radius as fleeing from a point. */
  _makeAgentsFlee(x, y, radius, durationTicks) {
    const tick = this.world.tick || 0;
    for (const agent of this.world.agents.values()) {
      const dx = Math.abs(agent.x - x);
      const dy = Math.abs(agent.y - y);
      if (dx + dy < radius) {
        agent._fleeFrom = { x, y, until: tick + durationTicks };
      }
    }
  }

  /** Helper: pick a random completed non-HQ building (with fallback). */
  _randomCompletedBuilding() {
    const pool = this.world.buildingsList.filter(b => b.isComplete() && b.workCost > 0);
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Helper: nearest settlement name to a point (for flavor text). */
  _nearestSettlementName(x, y, maxDist = 30) {
    let best = null, bestD = Infinity;
    for (const s of (this.world.settlements || [])) {
      const d = Math.abs(s.cx - x) + Math.abs(s.cy - y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best && bestD < maxDist ? best.name : null;
  }

  // ─── METEOR ─────────────────────────────────────────────────────────
  _chaosMeteor(tick, events, cs, mult) {
    if (!this._chaosReady(tick, 'lastMeteor', cs, 300, 0.05, mult)) return;
    const target = this._randomCompletedBuilding();
    if (!target) return;
    const impactX = Math.max(5, Math.min(this.world.width - 5, target.x + Math.floor(Math.random() * 10) - 5));
    const impactY = Math.max(5, Math.min(this.world.height - 5, target.y + Math.floor(Math.random() * 10) - 5));

    // Buildings in blast radius catch fire (existing burn system handles HP)
    const BLAST = 8;
    const nearby = this.world._spatialIndex
      ? this.world._spatialIndex.query(impactX, impactY, BLAST).filter(b => b.isComplete() && !b.burning && b.workCost > 0)
      : this.world.buildingsList.filter(b => b.isComplete() && !b.burning && b.workCost > 0 && Math.abs(b.x - impactX) + Math.abs(b.y - impactY) < BLAST);
    const burnCount = Math.min(nearby.length, 6);
    const targets = nearby.sort(() => Math.random() - 0.5).slice(0, burnCount);
    for (const t of targets) {
      t.burning = true; t.hp = t.hp || 1.0;
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${t.x},${t.y}`);
    }

    // Nearby agents flee for 20 ticks
    this._makeAgentsFlee(impactX, impactY, 15, 20);

    const locName = this._nearestSettlementName(impactX, impactY);
    const loc = locName ? `near ${locName}` : `at (${impactX}, ${impactY})`;
    events.push({
      tick, type: 'meteor_strike',
      impactX, impactY, burnCount: targets.length,
      message: targets.length > 0
        ? `A meteor crashed ${loc}, setting ${targets.length} building${targets.length > 1 ? 's' : ''} ablaze!`
        : `A meteor crashed ${loc}! No buildings were hit.`,
    });
    console.log(`[Chaos] METEOR at (${impactX},${impactY}) mult=${mult.toFixed(2)} burn=${targets.length}`);
  }

  // ─── WILDFIRE (ignition + spread) ───────────────────────────────────
  // Spread does NOT scale with chaos multiplier — that would cause exponential
  // chain reactions. Only ignition frequency scales. Spread runs every 5 ticks.
  _chaosWildfire(tick, events, cs, mult) {
    // Fire spread (throttled to every 5 ticks to prevent chain-reaction apocalypse)
    if (tick % 5 === 0) {
      const burning = this.world.buildingsList.filter(b => b.isComplete() && b.burning && b.workCost > 0);
      const SPREAD_CHANCE = 0.10;          // fixed — does not scale with mult
      const SPREAD_RADIUS = 4;
      const MAX_SPREADS_PER_CHECK = 8;     // hard cap to prevent runaway fires
      let spreadCount = 0;
      for (const b of burning) {
        if (spreadCount >= MAX_SPREADS_PER_CHECK) break;
        if (Math.random() > SPREAD_CHANCE) continue;
        const candidates = this.world._spatialIndex
          ? this.world._spatialIndex.query(b.x, b.y, SPREAD_RADIUS).filter(c => c !== b && c.isComplete() && !c.burning && c.workCost > 0)
          : [];
        if (candidates.length === 0) continue;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        target.burning = true; target.hp = target.hp || 1.0;
        if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
        this.world._dirtyTiles.add(`${target.x},${target.y}`);
        spreadCount++;
      }
      if (spreadCount > 0) {
        events.push({ tick, type: 'wildfire_spread',
          message: `Wildfire spreads! ${spreadCount} more building${spreadCount > 1 ? 's' : ''} caught fire.` });
      }
    }

    // Fresh wildfire ignition (rate-gated by multiplier)
    if (!this._chaosReady(tick, 'lastWildfire', cs, 400, 0.08, mult)) return;
    const starter = this._randomCompletedBuilding();
    if (!starter || starter.burning) return;
    starter.burning = true; starter.hp = starter.hp || 1.0;
    if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
    this.world._dirtyTiles.add(`${starter.x},${starter.y}`);
    events.push({ tick, type: 'wildfire_started',
      impactX: starter.x, impactY: starter.y,
      message: `A wildfire ignites at the ${starter.name}!` });
    console.log(`[Chaos] WILDFIRE start at ${starter.name} (${starter.x},${starter.y}) mult=${mult.toFixed(2)}`);
  }

  // ─── LIGHTNING STRIKE (single building instant ignite) ──────────────
  _chaosLightning(tick, events, cs, mult) {
    if (!this._chaosReady(tick, 'lastLightning', cs, 100, 0.20, mult)) return;
    const target = this._randomCompletedBuilding();
    if (!target || target.burning) return;
    target.burning = true;
    target.hp = Math.max(0.3, (target.hp || 1.0) - 0.4);  // lightning does instant damage
    if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
    this.world._dirtyTiles.add(`${target.x},${target.y}`);
    const locName = this._nearestSettlementName(target.x, target.y);
    events.push({
      tick, type: 'lightning_strike',
      impactX: target.x, impactY: target.y,
      message: `Lightning strikes the ${target.name}${locName ? ` in ${locName}` : ''}!`,
    });
    console.log(`[Chaos] LIGHTNING ${target.name} (${target.x},${target.y}) mult=${mult.toFixed(2)}`);
  }

  // ─── LIGHTNING STORM (paid action: massive multi-strike event) ──────
  // Unlike the passive single-strike chaos, this is triggered by a player
  // paying $AGENTCRAFT. It needs to be visible and dramatic — 12+ strikes
  // on buildings in a local area, each igniting the target and dealing HP
  // damage. Emits ONE lightning_storm event with an array of impact points
  // so the viewer can play a cohesive massive animation.
  //
  // Called directly by PaidActions (bypasses the _chaosReady cooldown gate
  // because the player already paid for it).
  _chaosLightningStorm(opts) {
    opts = opts || {};
    const tick = this.world.tick || 0;
    const STRIKE_COUNT = opts.strikes || 15;
    const STORM_RADIUS = opts.radius || 20;

    // Pick a storm epicenter — biased toward a dense cluster of buildings
    // so the strikes actually hit things. Find the building with the most
    // neighbors within STORM_RADIUS.
    const completed = this.world.buildingsList.filter(b => b.isComplete() && b.workCost > 0);
    if (completed.length === 0) {
      return { ok: false, reason: 'No buildings to strike' };
    }

    // Pick epicenter: try a few random buildings and score by neighbor count
    let epicenter = null;
    let bestScore = -1;
    const sampleSize = Math.min(20, completed.length);
    for (let i = 0; i < sampleSize; i++) {
      const candidate = completed[Math.floor(Math.random() * completed.length)];
      let neighbors;
      if (this.world._spatialIndex) {
        neighbors = this.world._spatialIndex.query(candidate.x, candidate.y, STORM_RADIUS)
          .filter(b => b.isComplete() && b.workCost > 0).length;
      } else {
        neighbors = completed.filter(b =>
          Math.abs(b.x - candidate.x) + Math.abs(b.y - candidate.y) < STORM_RADIUS
        ).length;
      }
      if (neighbors > bestScore) {
        bestScore = neighbors;
        epicenter = candidate;
      }
    }
    if (!epicenter) epicenter = completed[Math.floor(Math.random() * completed.length)];

    // Find all buildings in the storm area
    let nearbyBuildings;
    if (this.world._spatialIndex) {
      nearbyBuildings = this.world._spatialIndex.query(epicenter.x, epicenter.y, STORM_RADIUS)
        .filter(b => b.isComplete() && b.workCost > 0 && !b.burning);
    } else {
      nearbyBuildings = completed.filter(b =>
        !b.burning && Math.abs(b.x - epicenter.x) + Math.abs(b.y - epicenter.y) < STORM_RADIUS
      );
    }

    // If not enough buildings in the area, expand to random ones across the map
    if (nearbyBuildings.length < STRIKE_COUNT) {
      const extras = completed.filter(b => !b.burning && !nearbyBuildings.includes(b));
      extras.sort(() => Math.random() - 0.5);
      nearbyBuildings = nearbyBuildings.concat(extras.slice(0, STRIKE_COUNT - nearbyBuildings.length));
    }

    // Shuffle and pick STRIKE_COUNT victims
    const shuffled = nearbyBuildings.slice().sort(() => Math.random() - 0.5);
    const strikes = shuffled.slice(0, Math.min(STRIKE_COUNT, shuffled.length));

    // Strike each one: ignite + take heavy HP damage
    const impacts = [];
    for (const b of strikes) {
      b.burning = true;
      b.hp = Math.max(0.2, (b.hp || 1.0) - 0.5);  // more damage than free lightning
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${b.x},${b.y}`);
      impacts.push({ x: b.x, y: b.y, name: b.name });
    }

    // Panic agents in the storm zone
    this._makeAgentsFlee(epicenter.x, epicenter.y, STORM_RADIUS + 5, 30);

    const locName = this._nearestSettlementName(epicenter.x, epicenter.y, 50);
    const locDesc = locName ? ` over ${locName}` : '';

    // Build a single storm event for the viewer to animate all strikes together
    const stormEvent = {
      tick,
      type: 'lightning_storm',
      impactX: epicenter.x,
      impactY: epicenter.y,
      radius: STORM_RADIUS,
      strikes: impacts,        // array of {x, y, name}
      strikeCount: impacts.length,
      message: `A massive lightning storm${locDesc}! ${impacts.length} buildings struck!`,
    };

    console.log(`[Chaos] LIGHTNING STORM at (${epicenter.x},${epicenter.y}) strikes=${impacts.length}`);

    return {
      ok: true,
      event: stormEvent,
      impacts: impacts.length,
      epicenter: { x: epicenter.x, y: epicenter.y },
    };
  }

  // ─── WILDFIRE STORM (paid: ignites multiple clusters for an inferno) ──
  // Spawns 8 simultaneous fires spread across the map so the natural
  // wildfire spread logic can turn it into a chain reaction.
  _chaosWildfireStorm(opts) {
    opts = opts || {};
    const tick = this.world.tick || 0;
    const NUM_IGNITIONS = opts.ignitions || 8;

    const completed = this.world.buildingsList.filter(b => b.isComplete() && b.workCost > 0 && !b.burning);
    if (completed.length === 0) return { ok: false, reason: 'No buildings to ignite' };

    // Pick NUM_IGNITIONS random buildings, spread out so fires aren't all in the same spot
    const candidates = completed.slice().sort(() => Math.random() - 0.5);
    const ignited = [];
    const MIN_SPACING = 8;  // min tiles between ignition points
    for (const b of candidates) {
      if (ignited.length >= NUM_IGNITIONS) break;
      // Don't ignite too close to an existing ignition
      const tooClose = ignited.some(i => Math.abs(i.x - b.x) + Math.abs(i.y - b.y) < MIN_SPACING);
      if (tooClose) continue;
      b.burning = true; b.hp = b.hp || 1.0;
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${b.x},${b.y}`);
      ignited.push({ x: b.x, y: b.y, name: b.name });
    }
    // If too spread-out to place enough, fall back to any remaining
    while (ignited.length < NUM_IGNITIONS && ignited.length < candidates.length) {
      const b = candidates[ignited.length];
      if (!b || ignited.find(i => i.x === b.x && i.y === b.y)) break;
      b.burning = true; b.hp = b.hp || 1.0;
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${b.x},${b.y}`);
      ignited.push({ x: b.x, y: b.y, name: b.name });
    }

    // Compute rough "center of mass" for camera pan
    let cx = 0, cy = 0;
    for (const i of ignited) { cx += i.x; cy += i.y; }
    cx = ignited.length > 0 ? Math.floor(cx / ignited.length) : 0;
    cy = ignited.length > 0 ? Math.floor(cy / ignited.length) : 0;

    // Panic everyone within wide radius
    this._makeAgentsFlee(cx, cy, 30, 40);

    const stormEvent = {
      tick,
      type: 'wildfire_storm',
      impactX: cx, impactY: cy,
      ignitions: ignited,
      ignitionCount: ignited.length,
      message: `A massive wildfire erupts! ${ignited.length} buildings ablaze across the land!`,
    };

    console.log(`[Chaos] WILDFIRE STORM at (${cx},${cy}) ignitions=${ignited.length}`);
    return { ok: true, event: stormEvent, impacts: ignited.length, epicenter: { x: cx, y: cy } };
  }

  // ─── MEGA EARTHQUAKE (paid: larger radius, guaranteed collapse) ──────
  _chaosMegaEarthquake(opts) {
    opts = opts || {};
    const tick = this.world.tick || 0;
    const RADIUS = opts.radius || 15;
    const COLLAPSE_CAP = opts.maxCollapse || 20;

    const center = this._randomCompletedBuilding();
    if (!center) return { ok: false, reason: 'No buildings to shake' };

    const nearby = this.world._spatialIndex
      ? this.world._spatialIndex.query(center.x, center.y, RADIUS).filter(b => b.isComplete() && b.workCost > 0)
      : this.world.buildingsList.filter(b => b.isComplete() && b.workCost > 0 && Math.abs(b.x - center.x) + Math.abs(b.y - center.y) < RADIUS);

    // Sort by distance from epicenter — closest collapses first
    nearby.sort((a, b) =>
      (Math.abs(a.x - center.x) + Math.abs(a.y - center.y)) -
      (Math.abs(b.x - center.x) + Math.abs(b.y - center.y))
    );

    // Collapse the closest buildings (up to cap)
    const collapsed = [];
    for (const bld of nearby) {
      if (collapsed.length >= COLLAPSE_CAP) break;
      // 80% chance for inner ring, 40% for outer
      const dist = Math.abs(bld.x - center.x) + Math.abs(bld.y - center.y);
      const collapseChance = dist < RADIUS / 2 ? 0.85 : 0.45;
      if (Math.random() < collapseChance) collapsed.push(bld);
    }

    const collapsedCoords = collapsed.map(b => ({ x: b.x, y: b.y, name: b.name }));

    for (const bld of collapsed) {
      const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
      const owner = this.world.agents.get(bld.owner);
      if (tile) {
        if (owner) {
          if (tile.owner === owner.id) tile.owner = null;
          if (owner.owned_tiles) owner.owned_tiles = owner.owned_tiles.filter(t => t !== `${bld.x},${bld.y}`);
        } else {
          tile.owner = null;
        }
      }
      this._destroyBuilding(bld);
    }

    this._makeAgentsFlee(center.x, center.y, RADIUS + 5, 40);

    const locName = this._nearestSettlementName(center.x, center.y);
    const event = {
      tick, type: 'mega_earthquake',
      impactX: center.x, impactY: center.y,
      radius: RADIUS,
      collapsed: collapsedCoords,
      destroyedCount: collapsed.length,
      message: `A MASSIVE earthquake ${locName ? `devastates ${locName}` : 'rocks the land'}! ${collapsed.length} buildings collapsed!`,
    };

    console.log(`[Chaos] MEGA EARTHQUAKE at (${center.x},${center.y}) collapsed=${collapsed.length}`);
    return { ok: true, event, impacts: collapsed.length, epicenter: { x: center.x, y: center.y } };
  }

  // ─── TORNADO SWARM (paid: 3 tornadoes simultaneously) ────────────────
  _chaosTornadoSwarm(opts) {
    opts = opts || {};
    const tick = this.world.tick || 0;
    const NUM_TORNADOES = opts.count || 3;
    const PATH_WIDTH = 4;

    const tornadoes = [];
    const allDestroyed = new Set();

    // Find buildings-dense area to center the swarm (most drama)
    const completed = this.world.buildingsList.filter(b => b.isComplete() && b.workCost > 0);
    if (completed.length === 0) return { ok: false, reason: 'No buildings to sweep' };

    let swarmCenterX = 0, swarmCenterY = 0;
    if (this.world._spatialIndex) {
      // Find a dense point
      let bestScore = 0;
      for (let i = 0; i < 15; i++) {
        const sample = completed[Math.floor(Math.random() * completed.length)];
        const score = this.world._spatialIndex.query(sample.x, sample.y, 25).length;
        if (score > bestScore) {
          bestScore = score;
          swarmCenterX = sample.x; swarmCenterY = sample.y;
        }
      }
    } else {
      swarmCenterX = Math.floor(this.world.width / 2);
      swarmCenterY = Math.floor(this.world.height / 2);
    }

    for (let t = 0; t < NUM_TORNADOES; t++) {
      // Spawn from random edges, aim through the swarm center
      const side = Math.floor(Math.random() * 4);
      let startX, startY, dirX, dirY;
      if (side === 0) { startX = swarmCenterX + (Math.random() - 0.5) * 40; startY = 0; dirX = 0; dirY = 1; }
      else if (side === 1) { startX = this.world.width - 1; startY = swarmCenterY + (Math.random() - 0.5) * 40; dirX = -1; dirY = 0; }
      else if (side === 2) { startX = swarmCenterX + (Math.random() - 0.5) * 40; startY = this.world.height - 1; dirX = 0; dirY = -1; }
      else { startX = 0; startY = swarmCenterY + (Math.random() - 0.5) * 40; dirX = 1; dirY = 0; }
      startX = Math.max(0, Math.min(this.world.width - 1, Math.floor(startX)));
      startY = Math.max(0, Math.min(this.world.height - 1, Math.floor(startY)));

      const len = Math.floor(Math.max(this.world.width, this.world.height) * 0.7);
      const destroyedThisPath = [];
      const perTornadoCap = 15;

      for (let step = 0; step < len; step++) {
        const px = startX + dirX * step + Math.floor(Math.sin(step * 0.3 + t) * 2);
        const py = startY + dirY * step + Math.floor(Math.cos(step * 0.3 + t) * 2);
        if (px < 0 || px >= this.world.width || py < 0 || py >= this.world.height) continue;
        const nearby = this.world._spatialIndex
          ? this.world._spatialIndex.query(px, py, PATH_WIDTH).filter(b => b.isComplete() && b.workCost > 0 && !allDestroyed.has(b))
          : [];
        for (const b of nearby) {
          if (destroyedThisPath.includes(b)) continue;
          destroyedThisPath.push(b);
          allDestroyed.add(b);
        }
        if (destroyedThisPath.length >= perTornadoCap) break;
      }

      tornadoes.push({
        startX, startY, dirX, dirY, length: len,
        destroyedCount: destroyedThisPath.length,
      });

      for (const bld of destroyedThisPath) {
        const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
        const owner = this.world.agents.get(bld.owner);
        if (tile) {
          if (owner) {
            if (tile.owner === owner.id) tile.owner = null;
            if (owner.owned_tiles) owner.owned_tiles = owner.owned_tiles.filter(tx => tx !== `${bld.x},${bld.y}`);
          } else {
            tile.owner = null;
          }
        }
        this._destroyBuilding(bld);
      }
    }

    // Panic everyone in the swarm area
    this._makeAgentsFlee(swarmCenterX, swarmCenterY, 40, 60);

    const event = {
      tick, type: 'tornado_swarm',
      impactX: swarmCenterX, impactY: swarmCenterY,
      tornadoes,
      totalDestroyed: allDestroyed.size,
      message: `A SWARM of ${tornadoes.length} tornadoes tears across the land! ${allDestroyed.size} buildings obliterated!`,
    };

    console.log(`[Chaos] TORNADO SWARM count=${tornadoes.length} destroyed=${allDestroyed.size}`);
    return { ok: true, event, impacts: allDestroyed.size, epicenter: { x: swarmCenterX, y: swarmCenterY } };
  }

  // ─── METEOR SHOWER (paid: 5 meteors rain in sequence) ────────────────
  _chaosMeteorShower(opts) {
    opts = opts || {};
    const tick = this.world.tick || 0;
    const NUM_METEORS = opts.count || 5;
    const SHOWER_RADIUS = opts.radius || 25;
    const BLAST_PER_METEOR = 8;

    const centerBuilding = this._randomCompletedBuilding();
    if (!centerBuilding) return { ok: false, reason: 'No buildings to target' };

    const centerX = centerBuilding.x;
    const centerY = centerBuilding.y;
    const meteors = [];
    const allIgnited = new Set();
    let totalBurning = 0;

    for (let m = 0; m < NUM_METEORS; m++) {
      // Random impact within SHOWER_RADIUS of center
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * SHOWER_RADIUS;
      const impactX = Math.max(5, Math.min(this.world.width - 5, Math.floor(centerX + Math.cos(angle) * dist)));
      const impactY = Math.max(5, Math.min(this.world.height - 5, Math.floor(centerY + Math.sin(angle) * dist)));

      const nearby = this.world._spatialIndex
        ? this.world._spatialIndex.query(impactX, impactY, BLAST_PER_METEOR).filter(b => b.isComplete() && !b.burning && b.workCost > 0 && !allIgnited.has(b))
        : [];
      const burnCount = Math.min(nearby.length, 8);
      const targets = nearby.slice(0, burnCount);
      for (const t of targets) {
        t.burning = true; t.hp = t.hp || 1.0;
        allIgnited.add(t);
        if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
        this.world._dirtyTiles.add(`${t.x},${t.y}`);
        totalBurning++;
      }
      meteors.push({ impactX, impactY, burnCount: targets.length });
    }

    this._makeAgentsFlee(centerX, centerY, SHOWER_RADIUS + 10, 50);

    const locName = this._nearestSettlementName(centerX, centerY, 50);
    const event = {
      tick, type: 'meteor_shower',
      impactX: centerX, impactY: centerY,
      radius: SHOWER_RADIUS,
      meteors,
      totalIgnited: totalBurning,
      message: `METEOR SHOWER! ${NUM_METEORS} fireballs rain down${locName ? ` near ${locName}` : ''}! ${totalBurning} buildings ignited!`,
    };

    console.log(`[Chaos] METEOR SHOWER count=${NUM_METEORS} ignited=${totalBurning}`);
    return { ok: true, event, impacts: totalBurning, epicenter: { x: centerX, y: centerY } };
  }

  // ─── PLAGUE WAVE (paid: hits 3 largest settlements at once) ──────────
  _chaosPlagueWave(opts) {
    opts = opts || {};
    const tick = this.world.tick || 0;
    const NUM_TARGETS = opts.targetCount || 3;
    const RADIUS = 18;
    const AFFLICTION_RATE = 0.50;  // 50% of buildings in each target

    const settlements = this.world.settlements || [];
    if (settlements.length === 0) return { ok: false, reason: 'No settlements to afflict' };

    // Score settlements by building count, pick top N
    const settlementScores = settlements.map(s => {
      const count = this.world._spatialIndex
        ? this.world._spatialIndex.query(s.cx, s.cy, RADIUS).filter(b => b.isComplete() && b.workCost > 0).length
        : this.world.buildingsList.filter(b =>
            b.isComplete() && b.workCost > 0 &&
            Math.abs(b.x - s.cx) + Math.abs(b.y - s.cy) < RADIUS
          ).length;
      return { settlement: s, count };
    });
    settlementScores.sort((a, b) => b.count - a.count);
    const targets = settlementScores.slice(0, NUM_TARGETS).filter(t => t.count > 0);

    if (targets.length === 0) return { ok: false, reason: 'No populated settlements' };

    const afflictions = [];  // [{settlementName, cx, cy, buildings: [{x,y}]}]
    let totalAfflicted = 0;

    for (const { settlement } of targets) {
      const nearby = this.world._spatialIndex
        ? this.world._spatialIndex.query(settlement.cx, settlement.cy, RADIUS).filter(b => b.isComplete() && b.workCost > 0 && !b.burning)
        : [];
      const afflictedInThis = [];
      const maxAfflict = Math.ceil(nearby.length * AFFLICTION_RATE);
      const shuffled = nearby.slice().sort(() => Math.random() - 0.5);
      for (let i = 0; i < Math.min(maxAfflict, shuffled.length); i++) {
        const bld = shuffled[i];
        bld.burning = true; bld.hp = bld.hp || 1.0;
        if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
        this.world._dirtyTiles.add(`${bld.x},${bld.y}`);
        afflictedInThis.push({ x: bld.x, y: bld.y });
        totalAfflicted++;
      }
      afflictions.push({
        settlementName: settlement.name,
        cx: settlement.cx,
        cy: settlement.cy,
        buildings: afflictedInThis,
      });
    }

    // Panic everyone near any affected settlement
    for (const a of afflictions) {
      this._makeAgentsFlee(a.cx, a.cy, RADIUS + 5, 80);
    }

    // Pick the first settlement as event center for camera pan
    const centerX = afflictions[0].cx;
    const centerY = afflictions[0].cy;
    const names = afflictions.map(a => a.settlementName).join(', ');

    const event = {
      tick, type: 'plague_wave',
      impactX: centerX, impactY: centerY,
      afflictions,
      totalAfflicted,
      message: `A DEVASTATING plague sweeps across ${names}! ${totalAfflicted} buildings rotting away!`,
    };

    console.log(`[Chaos] PLAGUE WAVE settlements=${afflictions.length} afflicted=${totalAfflicted}`);
    return { ok: true, event, impacts: totalAfflicted, epicenter: { x: centerX, y: centerY } };
  }

  // ─── VOLCANIC ERUPTION (paid: massive 25-tile radius) ────────────────
  _chaosVolcanicEruption(opts) {
    opts = opts || {};
    const tick = this.world.tick || 0;
    const RADIUS = opts.radius || 25;
    const INNER_RADIUS = 12;
    const DESTROY_CAP = 30;
    const IGNITE_CAP = 40;

    // Find the densest cluster as the eruption center
    const completed = this.world.buildingsList.filter(b => b.isComplete() && b.workCost > 0);
    if (completed.length === 0) return { ok: false, reason: 'No buildings in the world' };

    let epicenter = null;
    let bestScore = -1;
    for (let i = 0; i < 20; i++) {
      const cand = completed[Math.floor(Math.random() * completed.length)];
      const n = this.world._spatialIndex
        ? this.world._spatialIndex.query(cand.x, cand.y, RADIUS).length
        : 0;
      if (n > bestScore) { bestScore = n; epicenter = cand; }
    }
    if (!epicenter) epicenter = completed[Math.floor(Math.random() * completed.length)];

    const nearby = this.world._spatialIndex
      ? this.world._spatialIndex.query(epicenter.x, epicenter.y, RADIUS).filter(b => b.isComplete() && b.workCost > 0)
      : [];

    const destroyed = [];
    const ignited = [];
    // Sort by distance so closest get destroyed first
    nearby.sort((a, b) =>
      (Math.abs(a.x - epicenter.x) + Math.abs(a.y - epicenter.y)) -
      (Math.abs(b.x - epicenter.x) + Math.abs(b.y - epicenter.y))
    );

    for (const bld of nearby) {
      const d = Math.abs(bld.x - epicenter.x) + Math.abs(bld.y - epicenter.y);
      if (d < INNER_RADIUS && destroyed.length < DESTROY_CAP) {
        destroyed.push(bld);
      } else if (!bld.burning && ignited.length < IGNITE_CAP) {
        ignited.push(bld);
      }
    }

    const destroyedCoords = destroyed.map(b => ({ x: b.x, y: b.y }));
    const ignitedCoords = ignited.map(b => ({ x: b.x, y: b.y }));

    for (const bld of destroyed) {
      const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
      const owner = this.world.agents.get(bld.owner);
      if (tile) {
        if (owner) {
          if (tile.owner === owner.id) tile.owner = null;
          if (owner.owned_tiles) owner.owned_tiles = owner.owned_tiles.filter(t => t !== `${bld.x},${bld.y}`);
        } else {
          tile.owner = null;
        }
      }
      this._destroyBuilding(bld);
    }
    for (const bld of ignited) {
      bld.burning = true; bld.hp = bld.hp || 1.0;
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${bld.x},${bld.y}`);
    }

    this._makeAgentsFlee(epicenter.x, epicenter.y, RADIUS + 10, 100);

    const event = {
      tick, type: 'volcanic_eruption',
      impactX: epicenter.x, impactY: epicenter.y,
      radius: RADIUS,
      innerRadius: INNER_RADIUS,
      destroyed: destroyedCoords,
      ignited: ignitedCoords,
      destroyedCount: destroyed.length,
      ignitedCount: ignited.length,
      message: `CATACLYSMIC VOLCANIC ERUPTION! ${destroyed.length} buildings vaporized, ${ignited.length} more engulfed in flames!`,
    };

    console.log(`[Chaos] VOLCANIC ERUPTION at (${epicenter.x},${epicenter.y}) dest=${destroyed.length} ign=${ignited.length}`);
    return { ok: true, event, impacts: destroyed.length + ignited.length, epicenter: { x: epicenter.x, y: epicenter.y } };
  }

  // ─── TORNADO (linear sweep destroys everything in path) ─────────────
  _chaosTornado(tick, events, cs, mult) {
    if (!this._chaosReady(tick, 'lastTornado', cs, 350, 0.10, mult)) return;

    // Pick a random edge to spawn on, and a random direction across the map
    const side = Math.floor(Math.random() * 4);  // 0=N, 1=E, 2=S, 3=W
    let startX, startY, dirX, dirY;
    const len = Math.floor(Math.max(this.world.width, this.world.height) * 0.7);
    if (side === 0) { startX = Math.floor(Math.random() * this.world.width); startY = 0; dirX = 0; dirY = 1; }
    else if (side === 1) { startX = this.world.width - 1; startY = Math.floor(Math.random() * this.world.height); dirX = -1; dirY = 0; }
    else if (side === 2) { startX = Math.floor(Math.random() * this.world.width); startY = this.world.height - 1; dirX = 0; dirY = -1; }
    else { startX = 0; startY = Math.floor(Math.random() * this.world.height); dirX = 1; dirY = 0; }

    // Walk the tornado path, destroying buildings within 3 tiles of the line
    const PATH_WIDTH = 3;
    const destroyed = [];
    for (let step = 0; step < len; step++) {
      const px = startX + dirX * step + Math.floor(Math.sin(step * 0.3) * 2);  // wiggle
      const py = startY + dirY * step + Math.floor(Math.cos(step * 0.3) * 2);
      if (px < 0 || px >= this.world.width || py < 0 || py >= this.world.height) continue;
      const nearby = this.world._spatialIndex
        ? this.world._spatialIndex.query(px, py, PATH_WIDTH).filter(b => b.isComplete() && b.workCost > 0)
        : [];
      for (const b of nearby) {
        if (destroyed.includes(b)) continue;
        destroyed.push(b);
      }
      // Cap damage per tornado — scales slightly with chaos mult (8–15)
      if (destroyed.length >= Math.floor(8 + mult)) break;
    }

    // Outright destroy buildings in the path (no fire)
    for (const bld of destroyed) {
      // Free tile ownership
      const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
      const owner = this.world.agents.get(bld.owner);
      if (tile) {
        if (owner) {
          if (tile.owner === owner.id) tile.owner = null;
          if (owner.owned_tiles) owner.owned_tiles = owner.owned_tiles.filter(t => t !== `${bld.x},${bld.y}`);
        } else {
          tile.owner = null;
        }
      }
      this._destroyBuilding(bld);
    }

    // Agents along the path flee
    const midX = startX + dirX * Math.floor(len / 2);
    const midY = startY + dirY * Math.floor(len / 2);
    this._makeAgentsFlee(midX, midY, 20, 40);

    events.push({
      tick, type: 'tornado',
      startX, startY, dirX, dirY, length: len, destroyedCount: destroyed.length,
      message: `A tornado tears through the land! ${destroyed.length} building${destroyed.length !== 1 ? 's' : ''} destroyed!`,
    });
    console.log(`[Chaos] TORNADO from (${startX},${startY}) dir=(${dirX},${dirY}) destroyed=${destroyed.length} mult=${mult.toFixed(2)}`);
  }

  // ─── EARTHQUAKE (radius collapse) ───────────────────────────────────
  _chaosEarthquake(tick, events, cs, mult) {
    if (!this._chaosReady(tick, 'lastEarthquake', cs, 350, 0.10, mult)) return;

    // Centered near a random building to maximize drama
    const center = this._randomCompletedBuilding();
    if (!center) return;
    const RADIUS = 10;
    const nearby = this.world._spatialIndex
      ? this.world._spatialIndex.query(center.x, center.y, RADIUS).filter(b => b.isComplete() && b.workCost > 0)
      : [];

    // Each building has a 20% chance to collapse (cap scales with chaos mult: 8–14)
    const maxCollapse = Math.floor(8 + mult);
    const collapsed = [];
    for (const bld of nearby) {
      if (collapsed.length >= maxCollapse) break;
      if (Math.random() < 0.20) collapsed.push(bld);
    }

    for (const bld of collapsed) {
      const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
      const owner = this.world.agents.get(bld.owner);
      if (tile) {
        if (owner) {
          if (tile.owner === owner.id) tile.owner = null;
          if (owner.owned_tiles) owner.owned_tiles = owner.owned_tiles.filter(t => t !== `${bld.x},${bld.y}`);
        } else {
          tile.owner = null;
        }
      }
      this._destroyBuilding(bld);
    }

    this._makeAgentsFlee(center.x, center.y, RADIUS + 3, 15);

    const locName = this._nearestSettlementName(center.x, center.y);
    events.push({
      tick, type: 'earthquake',
      impactX: center.x, impactY: center.y, radius: RADIUS, destroyedCount: collapsed.length,
      message: `Earthquake ${locName ? `shakes ${locName}` : 'rocks the region'}! ${collapsed.length} building${collapsed.length !== 1 ? 's' : ''} collapsed!`,
    });
    console.log(`[Chaos] EARTHQUAKE at (${center.x},${center.y}) collapsed=${collapsed.length} mult=${mult.toFixed(2)}`);
  }

  // ─── VOLCANO (rare massive destruction) ─────────────────────────────
  _chaosVolcano(tick, events, cs, mult) {
    if (!this._chaosReady(tick, 'lastVolcano', cs, 2000, 0.04, mult)) return;

    const center = this._randomCompletedBuilding();
    if (!center) return;
    const RADIUS = 18;
    const nearby = this.world._spatialIndex
      ? this.world._spatialIndex.query(center.x, center.y, RADIUS).filter(b => b.isComplete() && b.workCost > 0)
      : [];

    // Inner radius (6): instant destruction (cap 10). Outer ring: catch fire (cap 15).
    const destroyed = [];
    const ignited = [];
    for (const bld of nearby) {
      const d = Math.abs(bld.x - center.x) + Math.abs(bld.y - center.y);
      if (d < 6 && destroyed.length < 10) destroyed.push(bld);
      else if (!bld.burning && ignited.length < 15) ignited.push(bld);
    }

    for (const bld of destroyed) {
      const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
      const owner = this.world.agents.get(bld.owner);
      if (tile) {
        if (owner) {
          if (tile.owner === owner.id) tile.owner = null;
          if (owner.owned_tiles) owner.owned_tiles = owner.owned_tiles.filter(t => t !== `${bld.x},${bld.y}`);
        } else {
          tile.owner = null;
        }
      }
      this._destroyBuilding(bld);
    }
    for (const bld of ignited) {
      bld.burning = true; bld.hp = bld.hp || 1.0;
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${bld.x},${bld.y}`);
    }

    this._makeAgentsFlee(center.x, center.y, RADIUS + 5, 60);

    events.push({
      tick, type: 'volcano',
      impactX: center.x, impactY: center.y, radius: RADIUS,
      destroyedCount: destroyed.length, ignitedCount: ignited.length,
      message: `VOLCANIC ERUPTION! ${destroyed.length} buildings vaporized, ${ignited.length} more ablaze!`,
    });
    console.log(`[Chaos] VOLCANO at (${center.x},${center.y}) dest=${destroyed.length} ign=${ignited.length} mult=${mult.toFixed(2)}`);
  }

  // ─── PLAGUE (settlement-wide decay over time) ───────────────────────
  _chaosPlague(tick, events, cs, mult) {
    if (!this._chaosReady(tick, 'lastPlague', cs, 1200, 0.05, mult)) return;

    const settlements = this.world.settlements || [];
    if (settlements.length === 0) return;
    const target = settlements[Math.floor(Math.random() * settlements.length)];
    const RADIUS = 15;
    const nearby = this.world._spatialIndex
      ? this.world._spatialIndex.query(target.cx, target.cy, RADIUS).filter(b => b.isComplete() && b.workCost > 0)
      : [];

    // 25% of buildings in the settlement catch fire (cap 10 per plague)
    const afflicted = [];
    for (const bld of nearby) {
      if (afflicted.length >= 10) break;
      if (Math.random() < 0.25 && !bld.burning) afflicted.push(bld);
    }
    for (const bld of afflicted) {
      bld.burning = true; bld.hp = bld.hp || 1.0;
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${bld.x},${bld.y}`);
    }

    events.push({
      tick, type: 'plague',
      impactX: target.cx, impactY: target.cy, settlementName: target.name,
      afflictedCount: afflicted.length,
      message: `A plague ravages ${target.name}! ${afflicted.length} buildings are rotting away.`,
    });
    console.log(`[Chaos] PLAGUE in ${target.name} afflicted=${afflicted.length} mult=${mult.toFixed(2)}`);
  }

  // ─── FORCED CHAOS TRIGGER (for admin + paid actions) ────────────────
  //
  // Force-fire a specific chaos event, bypassing cooldowns and probability.
  // Used by:
  //   - POST /api/chaos/:type  (admin test endpoint)
  //   - POST /api/action       (paid $AGENTCRAFT actions — Phase 2)
  //
  // Works by:
  //   1. Resetting the per-type cooldown to way in the past
  //   2. Using a FORCE_MULT = 999 so the effective chance hits the 0.9 cap
  //   3. Retrying up to 10 times in case of the remaining 10% RNG miss
  //      or an early-return (e.g. no target found)
  //
  // Returns a result object describing what the event did:
  //   { ok, type, event, buildingsDestroyed, attemptedEvents, tick }
  // or { ok: false, reason } on total failure.
  triggerChaosAction(type) {
    if (!this.world._chaosState) {
      this.world._chaosState = {
        lastMeteor: 0, lastWildfire: 0, lastLightning: 0, lastTornado: 0,
        lastEarthquake: 0, lastVolcano: 0, lastPlague: 0,
      };
    }
    const cs = this.world._chaosState;
    const tick = this.world.tick || 0;

    const fireMap = {
      meteor:     { fn: '_chaosMeteor',     key: 'lastMeteor' },
      wildfire:   { fn: '_chaosWildfire',   key: 'lastWildfire' },
      lightning:  { fn: '_chaosLightning',  key: 'lastLightning' },
      tornado:    { fn: '_chaosTornado',    key: 'lastTornado' },
      earthquake: { fn: '_chaosEarthquake', key: 'lastEarthquake' },
      volcano:    { fn: '_chaosVolcano',    key: 'lastVolcano' },
      plague:     { fn: '_chaosPlague',     key: 'lastPlague' },
    };
    const spec = fireMap[String(type || '').toLowerCase()];
    if (!spec) {
      return { ok: false, reason: `Unknown chaos type: ${type}` };
    }

    const buildingsBefore = this.world.buildingsList.length;
    const collectedEvents = [];
    const FORCE_MULT = 999;

    // Retry up to 10 times in case of RNG miss or early return (no target etc.)
    let fired = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = collectedEvents.length;
      cs[spec.key] = -999999;  // reset cooldown
      try {
        this[spec.fn](tick, collectedEvents, cs, FORCE_MULT);
      } catch (err) {
        console.error(`[triggerChaosAction] ${type} threw:`, err.stack || err.message);
        return { ok: false, reason: `Chaos dispatch failed: ${err.message}` };
      }
      if (collectedEvents.length > before) { fired = true; break; }
    }

    if (!fired) {
      return { ok: false, reason: `Could not fire ${type} — no valid target or RNG miss` };
    }

    // The primary event is the first one generated (wildfire_spread is secondary)
    const primaryEvent = collectedEvents.find(e =>
      e.type && !e.type.endsWith('_spread')
    ) || collectedEvents[0];

    // Push events into the pending broadcast queue so they're included in
    // the next tick's diff broadcast. Also push to world.events so they
    // show up in the event history.
    if (!this.world.events) this.world.events = [];
    if (!this.world._pendingBroadcastEvents) this.world._pendingBroadcastEvents = [];
    for (const ev of collectedEvents) {
      this.world.events.push(ev);
      this.world._pendingBroadcastEvents.push(ev);
    }

    const buildingsAfter = this.world.buildingsList.length;

    return {
      ok: true,
      type,
      event: primaryEvent,
      allEvents: collectedEvents.map(e => ({
        type: e.type,
        message: e.message,
        impactX: e.impactX,
        impactY: e.impactY,
      })),
      buildingsDestroyed: buildingsBefore - buildingsAfter,
      tick,
    };
  }

  /**
   * Destroy a building cleanly: unlink from tile, remove from owner's list,
   * remove from buildingsList, remove from spatial index.
   * Used by: burning death, decay, wildfire, manual cleanup.
   *
   * Caller is responsible for pushing events. This just does the bookkeeping.
   *
   * @param {Building} bld the building to destroy
   * @param {number} listIdx optional pre-computed index in buildingsList
   * @returns {boolean} true if destroyed, false if not found
   */
  _destroyBuilding(bld, listIdx) {
    if (!bld) return false;
    // Unlink from tile
    const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
    if (tile && tile.building === bld) {
      tile.building = null;
      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${bld.x},${bld.y}`);
    }
    // Remove from owner's buildings list
    const owner = this.world.agents.get(bld.owner);
    if (owner) {
      owner.buildings = (owner.buildings || []).filter(b => b !== bld);
    }
    // Remove from spatial index
    if (this.world._spatialIndex) this.world._spatialIndex.remove(bld);
    // Remove from buildingsList
    if (listIdx != null && this.world.buildingsList[listIdx] === bld) {
      this.world.buildingsList.splice(listIdx, 1);
    } else {
      const idx = this.world.buildingsList.indexOf(bld);
      if (idx >= 0) this.world.buildingsList.splice(idx, 1);
    }
    // Clear burning state (in case it was burning)
    bld.burning = false;
    return true;
  }

  // ── Agent portal behavior ────────────────────────────────────────

  /**
   * If there's an active portal nearby and the agent is in grassland,
   * they're drawn to it. On contact, they teleport to Neo-Kyoto.
   * Returns: 'traversed' | 'approaching' | 'none'
   */
  _tryPortalBehavior(agent, tick, events) {
    const portals = this.world.portals;
    if (!Array.isArray(portals) || portals.length === 0) return 'none';

    // Find the nearest ACTIVE portal
    let best = null;
    let bestDist = Infinity;
    const SCAN_RADIUS = 30;
    for (const p of portals) {
      if (!p.active) continue;
      const dist = Math.abs(agent.x - p.x) + Math.abs(agent.y - p.y);
      if (dist <= SCAN_RADIUS && dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    if (!best) return 'none';

    // Adjacent → step into the portal
    if (Math.abs(agent.x - best.x) <= 1 && Math.abs(agent.y - best.y) <= 1) {
      this._traverseToCyber(agent, best, tick, events);
      return 'traversed';
    }

    // Not every agent is curious — only ~30% chance per tick to actually move
    // toward the portal so the world doesn't drain instantly
    if (Math.random() > 0.3) return 'none';

    // Walk one step toward the portal
    const dxStep = Math.sign(best.x - agent.x);
    const dyStep = Math.sign(best.y - agent.y);
    this._moveAgent(agent, dxStep, dyStep);
    agent.mood = 'moving';
    agent.current_action = { type: 'portal_chase', target_x: best.x, target_y: best.y, portalId: best.id };
    agent.idle_ticks = 0;
    agent.message = 'Drawn to the portal...';
    return 'approaching';
  }

  /**
   * Teleport an agent from grassland into Neo-Kyoto.
   * They appear at a plaza or random walkable position in the cyber world,
   * with currentWorld flipped. They keep their resources, equipment, etc.
   */
  _traverseToCyber(agent, portal, tick, events) {
    // Spawn point: random position in the cyber world avoiding edges.
    // Plazas are at avenue intersections (every 24 tiles).
    const plazaCols = Math.floor(this.world.width / 24);
    const plazaRows = Math.floor(this.world.height / 24);
    const px = (1 + Math.floor(Math.random() * (plazaCols - 1))) * 24;
    const py = (1 + Math.floor(Math.random() * (plazaRows - 1))) * 24;
    agent.currentWorld = 'cyber';
    agent.x = Math.max(2, Math.min(this.world.width - 3, px + (Math.floor(Math.random() * 5) - 2)));
    agent.y = Math.max(2, Math.min(this.world.height - 3, py + (Math.floor(Math.random() * 5) - 2)));
    agent.mood = 'idle';
    agent.current_action = null;
    agent.idle_ticks = 0;
    agent.message = 'Stepped through the portal!';
    // Reset any grassland-specific state
    agent.action_queue = [];
    agent._buildingTarget = null;
    // Event for the viewer (drama banner + flash)
    events.push({
      tick,
      type: 'portal_traversal',
      agentId: agent.id,
      agent: agent.name,
      portalId: portal.id,
      fromX: portal.x,
      fromY: portal.y,
      toX: agent.x,
      toY: agent.y,
      message: `🌌 ${agent.name} stepped through the portal into NEO-KYOTO!`,
    });
    console.log(`[PORTAL] ${agent.name} traversed to cyber at (${agent.x},${agent.y})`);
  }

  // ── Agent dragon combat behavior ─────────────────────────────────

  /**
   * If a dragon is alive and nearby, agents rush toward it and attack.
   * Returns: 'attacking' | 'chasing' | 'none'
   *
   * Damage per attack tick:
   *   Unarmed = 1       Sword = 4       Bow = 3 (from 3 tiles)
   *   Spear = 3         With haste buff = +50%
   */
  _tryDragonBehavior(agent, tick, events) {
    const d = this.world.dragon;
    if (!d || !d.alive) return 'none';

    const SCAN_RADIUS = 25;   // agents notice dragons from far
    const dist = Math.abs(agent.x - d.x) + Math.abs(agent.y - d.y);
    if (dist > SCAN_RADIUS) return 'none';

    // Determine attack range (bow can attack from 3 tiles)
    const weapon = (agent.equipment && agent.equipment.weapon) || null;
    const attackRange = weapon === 'bow' ? 3 : 1;

    // In attack range → deal damage
    if (dist <= attackRange + 1) {
      // Calculate damage
      let dmg;
      if (weapon === 'sword') dmg = 4;
      else if (weapon === 'bow') dmg = 3;
      else if (weapon === 'spear') dmg = 3;
      else dmg = 1; // unarmed

      // Haste buff = +50% damage
      if (GameLoop.hasBuff(agent, 'haste', tick)) dmg = Math.ceil(dmg * 1.5);

      this._takeDragonDamage(agent, dmg, tick, events);

      agent.mood = 'fighting';
      agent.current_action = { type: 'dragon_attack', dragonId: d.id };
      agent.idle_ticks = 0;
      const weaponTag = weapon ? ` [${weapon.toUpperCase()}]` : '';
      agent.message = `Attacking the Dragon!${weaponTag} (-${dmg} HP)`;

      // Emit attack event (for viewer hit flash)
      events.push({
        tick,
        type: 'dragon_hit',
        agentId: agent.id,
        agent: agent.name,
        weapon: weapon || 'fists',
        damage: dmg,
        dragonHp: d.hp,
        dragonMaxHp: d.maxHp,
        x: d.x,
        y: d.y,
        message: `⚔️ ${agent.name}${weaponTag} hits the Dragon for ${dmg} damage! (HP: ${d.hp}/${d.maxHp})`,
      });
      return 'attacking';
    }

    // Out of range — chase the dragon
    const dxStep = Math.sign(d.x - agent.x);
    const dyStep = Math.sign(d.y - agent.y);
    this._moveAgent(agent, dxStep, dyStep);
    agent.mood = 'fighting';
    agent.current_action = { type: 'dragon_chase', dragonId: d.id };
    agent.idle_ticks = 0;
    agent.message = 'Charging the Dragon!';
    return 'chasing';
  }

  // ═══════════════════════════════════════════════════════════════════
  // WORLD BOSS: DRAGON
  // A dragon naturally spawns when the world has enough buildings.
  // It roams toward dense settlements, breathes fire on buildings,
  // and agents must chase it and attack to bring it down.
  // ═══════════════════════════════════════════════════════════════════

  // Tuning constants
  static DRAGON_MIN_BUILDINGS = 40;    // minimum buildings before first spawn
  static DRAGON_SPAWN_COOLDOWN = 600;  // ticks between spawns (~30 min at 3s/tick)
  static DRAGON_HP = 150;              // total HP
  static DRAGON_FIRE_INTERVAL = 6;     // ticks between fire breaths
  static DRAGON_FIRE_RADIUS = 12;      // tile radius for fire
  static DRAGON_FIRE_COUNT = 2;        // max buildings per fire breath
  static DRAGON_WANDER_INTERVAL = 1;   // ticks between movement (every tick = fast)

  /**
   * Spawn a new dragon at the edge of the map, targeting a dense settlement.
   */
  _spawnDragon(tick, events) {
    // Spawn near (or on) the biggest settlement for immediate action.
    // No more spawning at the edge of the map — dragons arrive with fury.
    let sx, sy, targetX, targetY;
    const setts = this.world.settlements || [];
    if (setts.length > 0) {
      // Pick the biggest settlement by nearby building count
      let bestSett = setts[0], bestCount = 0;
      for (const s of setts) {
        const cnt = this.world.buildingsList.filter(b =>
          b.isComplete() && Math.abs(b.x - s.cx) + Math.abs(b.y - s.cy) < 20
        ).length;
        if (cnt > bestCount) { bestSett = s; bestCount = cnt; }
      }
      // Spawn offset from center (5-12 tiles away so it doesn't just sit ON buildings)
      const angle = Math.random() * Math.PI * 2;
      const spawnDist = 5 + Math.floor(Math.random() * 8);
      sx = Math.max(0, Math.min(this.world.width - 1, Math.round(bestSett.cx + Math.cos(angle) * spawnDist)));
      sy = Math.max(0, Math.min(this.world.height - 1, Math.round(bestSett.cy + Math.sin(angle) * spawnDist)));
      targetX = bestSett.cx;
      targetY = bestSett.cy;
    } else {
      // No settlements — pick a random building cluster
      const completed = this.world.buildingsList.filter(b => b.isComplete());
      if (completed.length > 0) {
        const pick = completed[Math.floor(Math.random() * completed.length)];
        sx = pick.x + (Math.floor(Math.random() * 11) - 5);
        sy = pick.y + (Math.floor(Math.random() * 11) - 5);
        targetX = pick.x; targetY = pick.y;
      } else {
        sx = Math.floor(this.world.width / 2);
        sy = Math.floor(this.world.height / 2);
        targetX = sx; targetY = sy;
      }
    }

    const dragon = {
      id: `dragon_${tick}`,
      x: sx,
      y: sy,
      hp: GameLoop.DRAGON_HP,
      maxHp: GameLoop.DRAGON_HP,
      alive: true,
      spawnTick: tick,
      lastFireTick: 0,
      lastMoveTick: 0,
      targetX,
      targetY,
      damageLog: {},     // {agentId: totalDamage}
      kills: 0,
    };

    this.world.dragon = dragon;

    const ev = {
      tick,
      type: 'dragon_spawn',
      x: sx,
      y: sy,
      targetX,
      targetY,
      message: `🐉 A DRAGON has appeared at (${sx},${sy})! It's heading for the settlements! All agents — FIGHT IT!`,
    };
    events.push(ev);
    // Also push to pending so it broadcasts if this runs mid-tick
    if (!Array.isArray(this.world._pendingBroadcastEvents)) this.world._pendingBroadcastEvents = [];
    this.world._pendingBroadcastEvents.push(ev);
    console.log(`[DRAGON] Spawned at (${sx},${sy}) → target (${targetX},${targetY}), HP=${dragon.hp}`);
  }

  /**
   * Main dragon processing — called every tick.
   * Handles: spawn check, movement, fire breath, death.
   * Agent combat is handled in _processAgent via _tryDragonBehavior.
   */
  _processDragon(tick, events) {
    const dragon = this.world.dragon;

    // ── Spawn check ──
    if (!dragon || !dragon.alive) {
      const buildingCount = this.world.buildingsList.filter(b => b.isComplete()).length;
      if (buildingCount < GameLoop.DRAGON_MIN_BUILDINGS) return;
      const lastDeath = (dragon && dragon.deathTick) || 0;
      if (tick - lastDeath < GameLoop.DRAGON_SPAWN_COOLDOWN) return;
      // Random chance each tick after cooldown: ~1/60 per tick ≈ spawns within ~3 min
      if (Math.random() > 1/60) return;
      this._spawnDragon(tick, events);
      return;
    }

    // Dragon is alive — process behavior
    const d = this.world.dragon;
    if (!d.alive) return;

    // ── Movement: wander toward target settlement ──
    if (tick - d.lastMoveTick >= GameLoop.DRAGON_WANDER_INTERVAL) {
      d.lastMoveTick = tick;
      const dx = Math.sign(d.targetX - d.x);
      const dy = Math.sign(d.targetY - d.y);
      // Dragons fly fast — 2 tiles per step
      if (dx !== 0 || dy !== 0) {
        d.x = Math.max(0, Math.min(this.world.width - 1, d.x + dx * 2));
        d.y = Math.max(0, Math.min(this.world.height - 1, d.y + dy * 2));
      } else {
        // Reached target — pick a new dense area
        this._dragonRetarget(d);
      }
    }

    // ── Fire breath: burn nearby buildings ──
    if (tick - d.lastFireTick >= GameLoop.DRAGON_FIRE_INTERVAL) {
      d.lastFireTick = tick;
      const nearby = this.world.buildingsList.filter(b =>
        b.isComplete() && !b.burning && b.workCost > 0 &&
        Math.abs(b.x - d.x) + Math.abs(b.y - d.y) < GameLoop.DRAGON_FIRE_RADIUS
      );
      if (nearby.length > 0) {
        const toFire = Math.min(GameLoop.DRAGON_FIRE_COUNT, nearby.length);
        const targets = nearby.sort(() => Math.random() - 0.5).slice(0, toFire);
        for (const t of targets) {
          t.burning = true;
          t.hp = t.hp || 1.0;
          if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
          this.world._dirtyTiles.add(`${t.x},${t.y}`);
          d.kills++;
        }
        events.push({
          tick,
          type: 'dragon_fire',
          x: d.x,
          y: d.y,
          targets: targets.map(t => ({ x: t.x, y: t.y, name: t.name })),
          message: `🔥 The Dragon breathes fire! ${targets.length} building${targets.length > 1 ? 's' : ''} set ablaze!`,
        });
      }
    }

    // Death check is handled in _takeDragonDamage
  }

  /**
   * Pick a new wander target for the dragon — aim for the densest
   * cluster of buildings it hasn't burned yet.
   */
  _dragonRetarget(d) {
    const buildings = this.world.buildingsList.filter(b => b.isComplete() && !b.burning && b.workCost > 0);
    if (buildings.length === 0) {
      // Nothing left — wander randomly
      d.targetX = Math.floor(Math.random() * this.world.width);
      d.targetY = Math.floor(Math.random() * this.world.height);
      return;
    }
    // Find building clusters — pick a random completed building and aim there
    const pick = buildings[Math.floor(Math.random() * buildings.length)];
    d.targetX = pick.x;
    d.targetY = pick.y;
  }

  /**
   * Called when an agent attacks the dragon. Applies damage, logs it,
   * and checks for death.
   */
  _takeDragonDamage(agent, damage, tick, events) {
    const d = this.world.dragon;
    if (!d || !d.alive) return;

    d.hp = Math.max(0, d.hp - damage);

    // Log damage for kill credit
    if (!d.damageLog) d.damageLog = {};
    d.damageLog[agent.id] = (d.damageLog[agent.id] || 0) + damage;

    // ── Dragon death ──
    if (d.hp <= 0) {
      d.alive = false;
      d.deathTick = tick;

      // Find the MVP (most damage dealt)
      let mvpId = null;
      let mvpDmg = 0;
      for (const [id, dmg] of Object.entries(d.damageLog)) {
        if (dmg > mvpDmg) { mvpId = id; mvpDmg = dmg; }
      }
      const mvpAgent = mvpId ? this.world.agents.get(mvpId) : null;
      const mvpName = mvpAgent ? mvpAgent.name : 'Unknown';

      // Reward MVP: "Dragon Slayer" perk + gold + WORK
      if (mvpAgent) {
        if (!mvpAgent.perks) mvpAgent.perks = {};
        mvpAgent.perks.dragon_slayer = true;
        mvpAgent.resources.gold = (mvpAgent.resources.gold || 0) + 100;
        mvpAgent.earnWork(50);
      }

      // Reward all fighters with gold proportional to damage
      const totalDmg = Object.values(d.damageLog).reduce((s, v) => s + v, 0);
      for (const [id, dmg] of Object.entries(d.damageLog)) {
        const fighter = this.world.agents.get(id);
        if (fighter && fighter !== mvpAgent) {
          const share = Math.floor((dmg / totalDmg) * 50);
          fighter.resources.gold = (fighter.resources.gold || 0) + share;
          fighter.earnWork(share / 2);
        }
      }

      const fighterCount = Object.keys(d.damageLog).length;
      events.push({
        tick,
        type: 'dragon_death',
        x: d.x,
        y: d.y,
        mvp: mvpName,
        mvpDmg: Math.round(mvpDmg),
        totalFighters: fighterCount,
        buildingsDestroyed: d.kills,
        message: `🐉💀 THE DRAGON IS SLAIN! ${mvpName} dealt the most damage (${Math.round(mvpDmg)})! ${fighterCount} agents fought. ${d.kills} buildings lost. The Dragon Slayer has been crowned!`,
      });
      console.log(`[DRAGON] Killed at (${d.x},${d.y}). MVP: ${mvpName} (${Math.round(mvpDmg)} dmg). Fighters: ${fighterCount}. Buildings destroyed: ${d.kills}`);
    }
  }

  // ─── Loot Drops (Phase 1) ───────────────────────────────────────────
  // Items sitting on the ground that agents autonomously pick up.
  // Currently supports food_cache. More types in later phases.

  /**
   * Catalog of droppable item types with their effects.
   * Effects are applied by _applyItemEffect() when an agent picks one up.
   *
   * Categories:
   *   resource — one-shot resource bump (food/wood/stone/gold caches)
   *   buff     — temporary buff with expiry tick (scroll/potion)
   *   perk     — permanent flag on the agent (golden tools)
   */
  static BUFF_DURATION_TICKS = 100; // ~5 min at 3s/tick

  static ITEM_CATALOG = {
    // ─── Resource caches (Phase 1) ───
    food_cache:  { category: 'resource', label: 'Food Cache',  resource: 'food',  defaultAmount: 50, emoji: '🍞' },
    wood_cache:  { category: 'resource', label: 'Wood Cache',  resource: 'wood',  defaultAmount: 50, emoji: '🪵' },
    stone_cache: { category: 'resource', label: 'Stone Cache', resource: 'stone', defaultAmount: 50, emoji: '🪨' },
    gold_cache:  { category: 'resource', label: 'Gold Cache',  resource: 'gold',  defaultAmount: 25, emoji: '💰' },
    // ─── Buffs (Phase 2, temporary) ───
    scroll_haste:  { category: 'buff', label: 'Scroll of Haste',   buff: 'haste',   emoji: '📜', description: 'Agent moves 2× faster for 5 minutes.' },
    potion_gather: { category: 'buff', label: 'Gatherer\'s Potion', buff: 'gather', emoji: '🧪', description: '2× resource collection for 5 minutes.' },
    potion_build:  { category: 'buff', label: 'Builder\'s Potion',  buff: 'build',  emoji: '⚗️', description: '2× building speed for 5 minutes.' },
    // ─── Perks (Phase 2, permanent) ───
    golden_pickaxe: { category: 'perk', label: 'Golden Pickaxe', perk: 'golden_pickaxe', emoji: '⛏️', description: 'Permanent 2× stone yield from all owned tiles.' },
    golden_axe:     { category: 'perk', label: 'Golden Axe',     perk: 'golden_axe',     emoji: '🪓', description: 'Permanent 2× wood yield from all owned tiles.' },
    // ─── Equipment (Phase 3, permanent, one per slot) ───
    // Weapons (slot: weapon) — affect raid damage
    weapon_sword: { category: 'equip', label: 'Sword',    slot: 'weapon', equip: 'sword',   emoji: '⚔️',  description: '+50% raid damage — burns 2 buildings instead of 1.' },
    weapon_bow:   { category: 'equip', label: 'Bow',      slot: 'weapon', equip: 'bow',     emoji: '🏹', description: 'Ranged — can raid from 3 tiles further away.' },
    weapon_spear: { category: 'equip', label: 'Spear',    slot: 'weapon', equip: 'spear',   emoji: '🔱', description: '+25% raid damage AND +25% defense.' },
    // Armor (slot: armor) — affect raid defense
    armor_leather: { category: 'equip', label: 'Leather Armor', slot: 'armor', equip: 'leather', emoji: '🦺', description: '25% chance to block an incoming raid.' },
    armor_iron:    { category: 'equip', label: 'Iron Armor',    slot: 'armor', equip: 'iron',    emoji: '🛡️', description: '50% chance to block an incoming raid.' },
    armor_shield:  { category: 'equip', label: 'War Shield',    slot: 'armor', equip: 'shield',  emoji: '🪖', description: '35% block + reflects damage — attacker loses a building.' },
  };

  /** Equipment stat table — looked up during combat resolution. */
  static EQUIP_STATS = {
    // Weapons: raidDmg = multiplier on buildings burned, raidRange = extra tiles
    sword:   { raidDmg: 1.5, raidRange: 0 },
    bow:     { raidDmg: 1.0, raidRange: 3 },
    spear:   { raidDmg: 1.25, raidRange: 0, defenseBonus: 0.25 },
    // Armor: blockChance = probability raid is blocked, reflect = attacker loses building
    leather: { blockChance: 0.25, reflect: false },
    iron:    { blockChance: 0.50, reflect: false },
    shield:  { blockChance: 0.35, reflect: true },
  };

  /** Returns true if agent currently has an unexpired buff of the given type. */
  static hasBuff(agent, buffType, tick) {
    if (!agent || !Array.isArray(agent.buffs)) return false;
    for (const b of agent.buffs) {
      if (b.type === buffType && b.expiresTick > tick) return true;
    }
    return false;
  }

  /**
   * Move wrapper that applies the haste buff. If the agent has an active
   * scroll_haste buff, dx/dy are doubled (2× movement speed). Used by
   * every agent.move() call site in the game loop.
   */
  _moveAgent(agent, dx, dy) {
    const tick = this.world.tick || 0;
    let mx = dx, my = dy;
    if (GameLoop.hasBuff(agent, 'haste', tick)) {
      mx *= 2;
      my *= 2;
    }
    agent.move(mx, my, this.world.width, this.world.height);
  }

  /** Returns true if agent has the given permanent perk flag. */
  static hasPerk(agent, perkName) {
    return !!(agent && agent.perks && agent.perks[perkName]);
  }

  /** Drop expired buffs in place. Called once per agent per tick. */
  static pruneExpiredBuffs(agent, tick) {
    if (!agent || !Array.isArray(agent.buffs) || agent.buffs.length === 0) return [];
    const expired = [];
    agent.buffs = agent.buffs.filter(b => {
      if (b.expiresTick > tick) return true;
      expired.push(b);
      return false;
    });
    return expired;
  }

  /**
   * Drop an item onto the map. Called from admin / paid endpoints.
   * Returns the created item or null on failure.
   */
  dropItem({ type, x, y, amount, droppedBy }) {
    const def = GameLoop.ITEM_CATALOG[type];
    if (!def) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const cx = Math.max(0, Math.min(this.world.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(this.world.height - 1, Math.round(y)));
    // Resource caches have an amount; buffs/perks don't
    const isResource = def.category === 'resource' || (!def.category && def.resource);
    const finalAmount = isResource
      ? (Number.isFinite(amount) && amount > 0 ? Math.round(amount) : def.defaultAmount)
      : 0;
    if (!Array.isArray(this.world.groundItems)) this.world.groundItems = [];
    const item = {
      id: `item_${this.world.tick}_${Math.floor(Math.random() * 1e9).toString(36)}`,
      type,
      category: def.category || 'resource',
      x: cx,
      y: cy,
      amount: finalAmount,
      dropped_tick: this.world.tick || 0,
      dropped_by: droppedBy || null,
    };
    this.world.groundItems.push(item);
    // Build a category-appropriate drop message
    let dropSuffix;
    if (def.category === 'buff') dropSuffix = '(temporary buff)';
    else if (def.category === 'perk') dropSuffix = '(permanent perk!)';
    else dropSuffix = `(+${finalAmount} ${def.resource})`;
    // Announce the drop so the viewer can flash it + log it in the feed
    const ev = {
      tick: this.world.tick || 0,
      type: 'item_dropped',
      itemId: item.id,
      itemType: type,
      category: def.category || 'resource',
      x: cx,
      y: cy,
      amount: finalAmount,
      emoji: def.emoji,
      message: `${def.emoji} A ${def.label} ${dropSuffix} dropped at (${cx},${cy})!`,
    };
    if (!Array.isArray(this.world.events)) this.world.events = [];
    if (!Array.isArray(this.world._pendingBroadcastEvents)) this.world._pendingBroadcastEvents = [];
    this.world.events.push(ev);
    this.world._pendingBroadcastEvents.push(ev);
    return item;
  }

  /**
   * Attempt loot behavior for an agent this tick.
   * Returns: 'picked_up' | 'chasing' | 'none'
   */
  _tryLootBehavior(agent, tick, events) {
    const items = this.world.groundItems;
    if (!Array.isArray(items) || items.length === 0) return 'none';

    const SCAN_RADIUS = 15;   // Manhattan distance at which agents notice a drop
    let best = null;
    let bestDist = Infinity;
    for (const it of items) {
      const dx = Math.abs(agent.x - it.x);
      const dy = Math.abs(agent.y - it.y);
      const dist = dx + dy;
      if (dist <= SCAN_RADIUS && dist < bestDist) {
        best = it;
        bestDist = dist;
      }
    }
    if (!best) return 'none';

    // Adjacent (or on-top) → pick it up
    if (Math.abs(agent.x - best.x) <= 1 && Math.abs(agent.y - best.y) <= 1) {
      this._pickupItem(agent, best, tick, events);
      return 'picked_up';
    }

    // Otherwise chase it: one step toward target
    const dxStep = Math.sign(best.x - agent.x);
    const dyStep = Math.sign(best.y - agent.y);
    this._moveAgent(agent, dxStep, dyStep);
    agent.mood = 'moving';
    agent.current_action = { type: 'loot_chase', target_x: best.x, target_y: best.y, itemId: best.id };
    agent.idle_ticks = 0;
    agent.message = `Spotted a ${GameLoop.ITEM_CATALOG[best.type]?.label || 'loot drop'}!`;
    return 'chasing';
  }

  /**
   * Remove the item from the world, apply its effect to the agent,
   * and emit an event so the viewer can flash a pickup animation.
   */
  _pickupItem(agent, item, tick, events) {
    const def = GameLoop.ITEM_CATALOG[item.type];
    if (!def) return;
    // Remove item from the world (first occurrence by id)
    const idx = this.world.groundItems.findIndex(i => i.id === item.id);
    if (idx >= 0) this.world.groundItems.splice(idx, 1);
    // Apply the effect
    this._applyItemEffect(agent, item);
    // Agent state
    agent.mood = 'idle';
    agent.current_action = { type: 'loot_pickup', itemId: item.id, itemType: item.type };
    agent.idle_ticks = 0;
    // Build a category-appropriate message for the agent bubble + event feed
    let msgSuffix;
    if (def.category === 'buff') {
      msgSuffix = '(5 min buff)';
    } else if (def.category === 'perk') {
      msgSuffix = '(permanent perk!)';
    } else if (def.category === 'equip') {
      msgSuffix = `(equipped ${def.slot}!)`;
    } else {
      msgSuffix = `(+${item.amount} ${def.resource})`;
    }
    agent.message = `Picked up a ${def.label}! ${msgSuffix}`;
    // Event for the viewer (pickup flash + feed)
    events.push({
      tick,
      type: 'item_pickup',
      itemId: item.id,
      itemType: item.type,
      category: def.category,
      agent: agent.name,
      agentId: agent.id,
      x: item.x,
      y: item.y,
      amount: item.amount,
      resource: def.resource,
      buff: def.buff,
      perk: def.perk,
      emoji: def.emoji,
      message: `${def.emoji} ${agent.name} picked up a ${def.label}! ${msgSuffix}`,
    });
  }

  /**
   * Apply an item's effect. Dispatches on def.category:
   *   resource — credit the stored amount to agent.resources[def.resource]
   *   buff     — push a {type, expiresTick} onto agent.buffs (replaces any
   *              existing buff of the same type — refresh behavior)
   *   perk     — set agent.perks[def.perk] = true (permanent, idempotent)
   */
  _applyItemEffect(agent, item) {
    const def = GameLoop.ITEM_CATALOG[item.type];
    if (!def) return;
    const tick = this.world.tick || 0;

    if (def.category === 'resource' || (!def.category && def.resource)) {
      if (!agent.resources) agent.resources = {};
      const amt = Number.isFinite(item.amount) ? item.amount : (def.defaultAmount || 0);
      agent.resources[def.resource] = (agent.resources[def.resource] || 0) + amt;
      return;
    }

    if (def.category === 'buff' && def.buff) {
      if (!Array.isArray(agent.buffs)) agent.buffs = [];
      // Refresh any existing same-type buff (don't stack, just extend)
      agent.buffs = agent.buffs.filter(b => b.type !== def.buff);
      agent.buffs.push({
        type: def.buff,
        expiresTick: tick + GameLoop.BUFF_DURATION_TICKS,
        grantedTick: tick,
      });
      return;
    }

    if (def.category === 'perk' && def.perk) {
      if (!agent.perks || typeof agent.perks !== 'object') agent.perks = {};
      agent.perks[def.perk] = true;
      return;
    }

    if (def.category === 'equip' && def.slot && def.equip) {
      if (!agent.equipment || typeof agent.equipment !== 'object') agent.equipment = {};
      agent.equipment[def.slot] = def.equip;
      return;
    }
  }

  _buildDiff(events) {
    const agents = [];
    for (const agent of this.world.agents.values()) {
      agents.push(agent.toPublicJSON ? agent.toPublicJSON() : agent.toJSON());
    }

    // Only send tiles that changed this tick (tracked via _dirtyTiles set)
    const changedTiles = [];
    if (this.world._dirtyTiles && this.world._dirtyTiles.size > 0) {
      for (const tileId of this.world._dirtyTiles) {
        const tile = this.world.tiles.get(tileId);
        if (tile) {
          changedTiles.push({
            x: tile.x, y: tile.y, tileId: tile.tileId,
            biome: tile.biome, owner: tile.owner,
            building: tile.building ? tile.building.toJSON() : null,
          });
        }
      }
      this.world._dirtyTiles.clear();
    }

    // Drain any events pushed from outside the tick loop (e.g. paid actions
    // from POST /api/action, or /api/chaos/:type). These need to be included
    // in the broadcast so connected viewers play the animations.
    let allEvents = events;
    if (this.world._pendingBroadcastEvents && this.world._pendingBroadcastEvents.length > 0) {
      allEvents = events.concat(this.world._pendingBroadcastEvents);
      this.world._pendingBroadcastEvents.length = 0;
    }

    return {
      tick: this.world.tick,
      agents,
      tiles: changedTiles,
      buildings: this.world.buildingsList.map(b => b.toJSON()),
      events: allEvents,
      leaderboard: this.world.leaderboard || [],
      settlements: this.world.settlements || [],
      groundItems: Array.isArray(this.world.groundItems) ? this.world.groundItems : [],
      dragon: this.world.dragon || null,
      portals: Array.isArray(this.world.portals) ? this.world.portals : [],
    };
  }

  _buildLeaderboard() {
    const entries = [];
    for (const agent of this.world.agents.values()) {
      const completedBuildings = agent.buildings.filter(b => b.isComplete()).length;
      const territory = agent.owned_tiles.length;
      const score = territory * 10 + completedBuildings * 25 + agent.work_balance;
      entries.push({
        id: agent.id,
        name: agent.name,
        faction: agent.faction,
        personality: agent.personality,
        territory,
        buildings: completedBuildings,
        work_balance: parseFloat(agent.work_balance.toFixed(4)),
        score: parseFloat(score.toFixed(2)),
      });
    }
    entries.sort((a, b) => b.score - a.score);
    return entries;
  }
}

module.exports = GameLoop;
