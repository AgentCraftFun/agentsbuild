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

    // 2. MINIMUM SPACING: 3 tiles from any existing building center (denser villages)
    const MIN_DIST = 3;
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
        bld.burning = false;
        const tile = this.world.tiles.get(`${bld.x},${bld.y}`);
        if (tile) { tile.building = null; this.world._dirtyTiles.add(`${bld.x},${bld.y}`); }
        const owner = this.world.agents.get(bld.owner);
        if (owner) {
          owner.buildings = (owner.buildings || []).filter(b => b !== bld);
          const remaining = this.world.buildingsList.filter(b2 =>
            b2 !== bld && b2.owner === owner.id && b2.isComplete()
          ).length;
          if (remaining <= 1) {
            owner._displaced = true;
            events.push({ tick, type: 'agent_displaced', agent: owner.name,
              message: `${owner.name}'s village was destroyed! They must find new land.` });
          }
        }
        this.world.buildingsList.splice(i, 1);
        events.push({ tick, type: 'building_destroyed', message: `${bld.name} at (${bld.x}, ${bld.y}) burned to the ground!` });
      }
    }

    // ── 2. Process active raids ──
    for (let ri = war.activeRaids.length - 1; ri >= 0; ri--) {
      const raid = war.activeRaids[ri];
      const raider = this.world.agents.get(raid.raiderId);
      if (!raider) { war.activeRaids.splice(ri, 1); continue; }
      const elapsed = tick - raid.startTick;

      // Safety timeout: 200 ticks max
      if (elapsed > 200) {
        raider.mood = 'idle'; raider.message = ''; raider._raidTarget = null;
        war.activeRaids.splice(ri, 1); continue;
      }

      // MARCHING: Move raider toward target at 3 tiles per tick
      if (!raid.arrived) {
        const tx = raid.targetX, ty = raid.targetY;
        const dist = Math.abs(raider.x - tx) + Math.abs(raider.y - ty);
        if (dist > 3) {
          const dx = Math.sign(tx - raider.x), dy = Math.sign(ty - raider.y);
          // Move 3 steps per tick for fast marching
          for (let step = 0; step < 3; step++) {
            raider.move(dx, dy, this.world.width, this.world.height);
          }
          raider.mood = 'raiding';
          raider.message = `Marching to attack! (${dist} tiles away)`;
          continue;
        }
        raid.arrived = true;
      }

      // ATTACK: Set nearby buildings on fire (once on arrival)
      if (!raid.attacked) {
        raid.attacked = true;
        raid.attackTick = tick;
        // Find nearby enemy buildings within 15 tiles
        const nearby = this.world.buildingsList.filter(b =>
          b.isComplete() && !b.burning && b.workCost > 0 &&
          b.owner !== raider.id &&
          Math.abs(b.x - raider.x) + Math.abs(b.y - raider.y) < 15
        );
        const toFire = Math.min(2 + Math.floor(Math.random() * 3), nearby.length);
        const targets = nearby.sort(() => Math.random() - 0.5).slice(0, toFire);
        for (const t of targets) {
          t.burning = true; t.hp = t.hp || 1.0;
          if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
          this.world._dirtyTiles.add(`${t.x},${t.y}`);
          events.push({ tick, type: 'building_burning', message: `${t.name} at (${t.x}, ${t.y}) is on fire!` });
        }
        if (targets.length > 0) {
          raider.x = targets[0].x + 1; raider.y = targets[0].y + 1;
          events.push({ tick, type: 'raid_success', message: `${raider.name} set ${targets.length} buildings ablaze!` });
        } else {
          events.push({ tick, type: 'raid_failed', message: `${raider.name} found nothing to burn.` });
        }
        raider.mood = 'celebrating'; raider.message = 'BURN IT ALL!';
        raider._raidTarget = null;
        console.log(`[War] ATTACK: ${raider.name} burned ${targets.length} buildings at (${raider.x},${raider.y})`);
      }

      // CELEBRATING: 12 ticks
      const sinceFire = tick - (raid.attackTick || tick);
      if (sinceFire < 12) {
        raider.mood = 'celebrating';
        raider.move(sinceFire % 2 === 0 ? 1 : -1, 0, this.world.width, this.world.height);
        continue;
      }

      // RETURNING HOME: Walk back to own settlement
      const homeSett = settlements[raid.attackerSettlement];
      if (homeSett) {
        const homeD = Math.abs(raider.x - homeSett.cx) + Math.abs(raider.y - homeSett.cy);
        if (homeD > 5) {
          raider.mood = 'returning'; raider.message = 'Returning victorious!';
          const dx = Math.sign(homeSett.cx - raider.x), dy = Math.sign(homeSett.cy - raider.y);
          for (let step = 0; step < 3; step++) {
            raider.move(dx, dy, this.world.width, this.world.height);
          }
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

    // Cooldown: shorter with more buildings (min 20 ticks)
    const cooldown = Math.max(20, 60 - Math.floor(totalBuildings / 8));
    if (tick - war.lastRaidTick < cooldown) return;

    // 25% trigger chance per tick after cooldown
    if (Math.random() > 0.25) return;

    // Max 3 simultaneous raids
    if (war.activeRaids.length >= 3) return;

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
