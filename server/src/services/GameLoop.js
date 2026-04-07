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
          building.advanceProgress(1);
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

    // STAY AT BUILDING: if agent is building, keep them there until it's done
    if (agent.mood === 'building' && agent._buildingTarget) {
      const bld = this.world.buildingsList.find(b => b.x === agent._buildingTarget.x && b.y === agent._buildingTarget.y);
      if (bld && !bld.isComplete()) {
        // Stay building — don't pick a new action
        return;
      }
      // Building done or gone — clear target
      agent._buildingTarget = null;
      agent.mood = 'idle';
    }

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
    agent.move(clampedDx, clampedDy, this.world.width, this.world.height);
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

    // 2. MINIMUM SPACING: 120px = 5 tiles (TS=24, 120/24=5) from any existing building center
    const MIN_DIST = 5;
    if (!resume) {
      let tooClose = false;
      for (const b of this.world.buildingsList) {
        const dx = Math.abs(b.x - x);
        const dy = Math.abs(b.y - y);
        if (dx + dy < MIN_DIST && !(b.x === x && b.y === y)) {
          tooClose = true;
          break;
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
    });

    tile.building = building;
    agent.buildings.push(building);
    this.world.buildingsList.push(building);
    if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
    this.world._dirtyTiles.add(tileId);

    agent.mood = 'building';
    agent.current_action = { type: 'build', building: buildingType, tileId };
    agent.idle_ticks = 0;
    agent._lastBuildTick = tick; // cooldown tracking for AgentBrain
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

      agent.mood = 'raiding';
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

    // Scale down to per-tick amounts
    agent.resources.food += yields.food * 0.1;
    agent.resources.wood += yields.wood * 0.1;
    agent.resources.stone += yields.stone * 0.1;
    agent.resources.gold += yields.gold * 0.1;

    // Also get base tile yields
    for (const tileId of agent.owned_tiles) {
      const tile = this.world.tiles.get(tileId);
      if (tile) {
        const tileYields = WorldGen.getTileYield(tile.biome);
        agent.resources.food += tileYields.food * 0.05;
        agent.resources.wood += tileYields.wood * 0.05;
        agent.resources.stone += tileYields.stone * 0.05;
        agent.resources.gold += tileYields.gold * 0.05;
      }
    }
  }

  // ─── INTER-SETTLEMENT WARFARE ───

  _processWarfare(tick, events) {
    const settlements = this.world.settlements || [];
    if (settlements.length < 2) return;

    // Initialize war state (persists across ticks but NOT across server restarts)
    if (!this.world._warState) {
      this.world._warState = {
        lastRaidTick: 0,
        activeRaids: [],
        raidCooldown: 300, // ~3 game days between raids
      };
      // On init (server restart), unstick any agents with stale raid moods
      for (const agent of this.world.agents.values()) {
        if (agent.mood === 'raiding' || agent.mood === 'celebrating' || agent.mood === 'returning') {
          console.log(`[War] Init: resetting ${agent.name} from stale mood '${agent.mood}'`);
          agent.mood = 'idle';
          agent.message = '';
        }
      }
    }
    const war = this.world._warState;

    // 1. Process burning buildings — fire spreads damage over time
    for (let i = this.world.buildingsList.length - 1; i >= 0; i--) {
      const bld = this.world.buildingsList[i];
      if (!bld.burning) continue;

      // Burn damage: lose 8% hp per tick (building destroyed in ~12 ticks / ~12 seconds)
      bld.hp = Math.max(0, (bld.hp || 1) - 0.08);

      if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
      this.world._dirtyTiles.add(`${bld.x},${bld.y}`);

      // Building destroyed
      if (bld.hp <= 0) {
        bld.burning = false;
        const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
        if (tile) {
          tile.building = null;
          this.world._dirtyTiles.add(`${bld.x},${bld.y}`);
        }

        // Remove from owner's buildings list
        const owner = this.world.agents.get(bld.owner);
        if (owner) {
          owner.buildings = owner.buildings.filter(b => b !== bld);
        }

        // Remove from global buildings list
        this.world.buildingsList.splice(i, 1);

        events.push({
          tick, type: 'building_destroyed',
          message: `💀 ${bld.name} at (${bld.x}, ${bld.y}) burned to the ground!`,
        });
      }
    }

    // 2. Process active raids — agents march to enemy settlement and set fires
    for (let ri = war.activeRaids.length - 1; ri >= 0; ri--) {
      const raid = war.activeRaids[ri];
      const elapsed = tick - raid.startTick;

      // Phase 1: Marching — move raider toward nearest enemy building
      if (!raid.attacked) {
        const raider = this.world.agents.get(raid.raiderId);
        if (!raider) { war.activeRaids.splice(ri, 1); continue; }

        // Find the nearest enemy building to march toward
        const defenderAgentIds = new Set();
        for (const a of this.world.agents.values()) {
          if (a._settlementId === raid.defenderSettlement || a._settlementId == raid.defenderSettlement) {
            defenderAgentIds.add(a.id);
          }
        }
        const defSett = settlements[raid.defenderSettlement];
        let targetX = defSett ? defSett.cx : raider.x;
        let targetY = defSett ? defSett.cy : raider.y;

        // Find closest enemy building to march toward
        let closestDist = Infinity;
        for (const b of this.world.buildingsList) {
          if (!b.isComplete() || b.burning || b.workCost === 0) continue;
          const isEnemy = defenderAgentIds.has(b.owner) ||
            (defSett && Math.abs(b.x - defSett.cx) + Math.abs(b.y - defSett.cy) < 80);
          if (!isEnemy) continue;
          const d = Math.abs(b.x - raider.x) + Math.abs(b.y - raider.y);
          if (d < closestDist) { closestDist = d; targetX = b.x; targetY = b.y; }
        }

        const distToTarget = Math.abs(raider.x - targetX) + Math.abs(raider.y - targetY);
        if (distToTarget > 3) {
          // Still marching
          const dx = Math.sign(targetX - raider.x);
          const dy = Math.sign(targetY - raider.y);
          raider.move(dx, dy, this.world.width, this.world.height);
          raider.move(dx, dy, this.world.width, this.world.height);
          raider.mood = 'raiding';
          raider.message = defSett ? `Marching on ${defSett.name}!` : 'Marching to war!';
          if (elapsed > 120) {
            console.log(`[War] Raid aborted — ${raider.name} took too long`);
            raider.mood = 'idle'; raider.message = '';
            war.activeRaids.splice(ri, 1);
          }
          continue;
        }
        // Arrived — fall through to attack phase
      }

      // Phase 2: Attack — set 1-3 buildings on fire
      if (!raid.attacked) {
        raid.attacked = true;
        raid.attackTick = tick;
        const raiderForLog = this.world.agents.get(raid.raiderId);
        console.log(`[War] ATTACK PHASE: ${raiderForLog ? raiderForLog.name : '?'} at (${raiderForLog?.x},${raiderForLog?.y}) attacking settlement ${raid.defenderSettlement}`);

        // Find buildings belonging to agents in the defender settlement
        const defenderAgentIds = new Set();
        for (const a of this.world.agents.values()) {
          if (a._settlementId === raid.defenderSettlement || a._settlementId == raid.defenderSettlement) {
            defenderAgentIds.add(a.id);
          }
        }
        // Also include buildings near defender settlement center as fallback
        const defSett = settlements[raid.defenderSettlement];
        const defBuildings = this.world.buildingsList.filter(b => {
          if (!b.isComplete() || b.burning || b.workCost === 0) return false;
          const ownedByDefender = defenderAgentIds.has(b.owner);
          const nearCenter = defSett && (Math.abs(b.x - defSett.cx) + Math.abs(b.y - defSett.cy) < 80);
          return ownedByDefender || nearCenter;
        });

        const raider = this.world.agents.get(raid.raiderId);
        const atkSett = settlements[raid.attackerSettlement];

        if (defBuildings.length === 0) {
          // No valid targets — abort raid
          console.log(`[War] Raid failed — no buildings to burn in settlement ${raid.defenderSettlement}`);
          if (raider) { raider.mood = 'idle'; raider.message = 'Nothing to burn...'; }
          war.activeRaids.splice(ri, 1);
          continue;
        }

        // Set 1-3 random buildings on fire
        const toFire = Math.min(1 + Math.floor(Math.random() * 3), defBuildings.length);
        const shuffled = defBuildings.sort(() => Math.random() - 0.5);
        for (let fi = 0; fi < toFire; fi++) {
          const target = shuffled[fi];
          target.burning = true;
          target.hp = target.hp || 1.0;
          if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
          this.world._dirtyTiles.add(`${target.x},${target.y}`);
          events.push({
            tick, type: 'building_burning',
            message: `🔥 ${target.name} at (${target.x}, ${target.y}) is on fire!`,
          });
        }

        if (atkSett && defSett) {
          events.push({
            tick, type: 'raid_success',
            message: `⚔️ ${atkSett.name} raided ${defSett.name}! ${toFire} building${toFire > 1 ? 's' : ''} set ablaze!`,
          });
        }

        // Position raider at the first burning building to celebrate
        if (raider) {
          const firstTarget = shuffled[0];
          raider.x = firstTarget.x + 1;
          raider.y = firstTarget.y + 1;
          raider.mood = 'celebrating';
          raider.message = 'BURN IT ALL! 🔥';
        }
      }

      // Phase 3: Celebration — raider dances near the fire for 20 ticks after attack
      const ticksSinceAttack = tick - (raid.attackTick || raid.startTick);
      if (ticksSinceAttack < 20) {
        const raider = this.world.agents.get(raid.raiderId);
        if (raider) {
          raider.mood = 'celebrating';
          raider.move(ticksSinceAttack % 2 === 0 ? 1 : -1, 0, this.world.width, this.world.height);
        }
        continue;
      }

      // Phase 4: Return home — move raider back, cleanup when home or after 50 ticks
      const raider = this.world.agents.get(raid.raiderId);
      const atkSett = settlements[raid.attackerSettlement];
      if (!raider || !atkSett || ticksSinceAttack > 70) {
        // Done or invalid — cleanup
        if (raider) { raider.mood = 'idle'; raider.message = ''; }
        war.activeRaids.splice(ri, 1);
      } else {
        raider.mood = 'returning';
        raider.message = 'Returning victorious!';
        const dx = Math.sign(atkSett.cx - raider.x);
        const dy = Math.sign(atkSett.cy - raider.y);
        raider.move(dx, dy, this.world.width, this.world.height);
        raider.move(dx, dy, this.world.width, this.world.height); // double speed home too
        // If close to home, done
        if (Math.abs(raider.x - atkSett.cx) + Math.abs(raider.y - atkSett.cy) < 5) {
          raider.mood = 'idle'; raider.message = '';
          war.activeRaids.splice(ri, 1);
        }
      }
    }

    // 3. Trigger new raids periodically
    const totalBuildings = this.world.buildingsList.filter(b => b.isComplete()).length;

    // Log war state every 100 ticks for diagnostics
    if (tick % 100 === 0) {
      console.log(`[War] tick=${tick} buildings=${totalBuildings} lastRaid=${war.lastRaidTick} cooldown=${war.raidCooldown} activeRaids=${war.activeRaids.length} settlements=${settlements.length}`);
    }

    if (totalBuildings < 10) return;
    if (tick - war.lastRaidTick < war.raidCooldown) return;

    // 10% chance per tick after cooldown = raid triggers within ~10 ticks
    if (Math.random() > 0.10) return;

    war.lastRaidTick = tick;

    // Only raid between the 3 original settlements (not mini-settlements)
    const mainSettlements = Math.min(3, settlements.length);
    const attackerIdx = Math.floor(Math.random() * mainSettlements);
    let defenderIdx;
    do { defenderIdx = Math.floor(Math.random() * mainSettlements); }
    while (defenderIdx === attackerIdx && mainSettlements > 1);

    // Pick a raider: any agent from the attacker settlement (or assigned to it originally)
    const attackerAgents = [...this.world.agents.values()].filter(a =>
      (a._settlementId === attackerIdx) || (a._settlementId == attackerIdx)
    );
    if (attackerAgents.length === 0) {
      console.log(`[War] No agents in settlement ${attackerIdx}, skipping raid`);
      return;
    }
    // Prefer aggressive agents, fall back to random
    const raider = attackerAgents.find(a => a.personality === 'aggressive') ||
                   attackerAgents[Math.floor(Math.random() * attackerAgents.length)];

    const atkSett = settlements[attackerIdx];
    const defSett = settlements[defenderIdx];

    war.activeRaids.push({
      attackerSettlement: attackerIdx,
      defenderSettlement: defenderIdx,
      raiderId: raider.id,
      startTick: tick,
      attacked: false,
    });

    raider.mood = 'raiding';
    raider.message = `Marching on ${defSett.name}!`;

    console.log(`[War] RAID TRIGGERED! tick=${tick} ${raider.name} from ${atkSett.name} → ${defSett.name}`);

    events.push({
      tick, type: 'raid_started',
      agent: raider.name,
      message: `⚔️ ${raider.name} from ${atkSett.name} is marching on ${defSett.name}!`,
    });
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

    return {
      tick: this.world.tick,
      agents,
      tiles: changedTiles,
      buildings: this.world.buildingsList.map(b => b.toJSON()),
      events,
      leaderboard: this.world.leaderboard || [],
      settlements: this.world.settlements || [],
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
