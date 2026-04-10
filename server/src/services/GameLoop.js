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

      // 5c. CHAOS — world disasters that scale with building count.
      // Every event self-scales: more buildings = more chaos. Keeps the
      // world dynamically balanced without hard caps.
      this._processChaos(tick, events);

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
    });

    tile.building = building;
    agent.buildings.push(building);
    this.world.buildingsList.push(building);
    if (this.world._spatialIndex) this.world._spatialIndex.add(building);
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
          raider.move(dx, dy, this.world.width, this.world.height);
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
          raider._raidTarget = { x: homeSett.cx, y: homeSett.cy }; // client uses this for smooth walk
          const dx = Math.sign(homeSett.cx - raider.x), dy = Math.sign(homeSett.cy - raider.y);
          raider.move(dx, dy, this.world.width, this.world.height);
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
