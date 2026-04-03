/**
 * Rich Game Loop — server-side simulation matching the viewer's game systems.
 *
 * Manages: agent AI, resource gathering, building construction,
 * settlement formation, era progression.
 *
 * All state is authoritative — clients are pure renderers.
 */

const { broadcast } = require('../ws/broadcast');
const WorldGen = require('./WorldGen');

// ─── TECH TREE (matches viewer exactly) ───
const TECH_TREE = [
  { type:'campfire', name:'Campfire', abbr:'CF', w:2, h:1, pw:30, ph:20, tall:false, cost:{wood:2,stone:0,gold:0}, era:0, faction:'neutral' },
  { type:'wood_hut', name:'Wood Hut', abbr:'WH', w:3, h:2, pw:56, ph:48, tall:false, cost:{wood:6,stone:0,gold:0}, era:0, faction:'human' },
  { type:'log_cabin', name:'Log Cabin', abbr:'LC', w:3, h:3, pw:72, ph:56, tall:false, cost:{wood:12,stone:2,gold:0}, era:0, faction:'human' },
  { type:'lumber_mill', name:'Lumber Mill', abbr:'LM', w:4, h:3, pw:80, ph:60, tall:false, cost:{wood:15,stone:4,gold:0}, era:0, faction:'dwarf' },
  { type:'farm', name:'Farm', abbr:'FA', w:3, h:2, pw:64, ph:40, tall:false, cost:{wood:9,stone:2,gold:0}, era:0, faction:'neutral' },
  { type:'stone_house', name:'Stone House', abbr:'SH', w:3, h:3, pw:68, ph:56, tall:false, cost:{wood:6,stone:15,gold:0}, era:1, faction:'human' },
  { type:'quarry', name:'Quarry', abbr:'QR', w:4, h:3, pw:88, ph:52, tall:false, cost:{wood:8,stone:18,gold:0}, era:1, faction:'dwarf' },
  { type:'blacksmith', name:'Blacksmith', abbr:'BS', w:3, h:3, pw:72, ph:60, tall:false, cost:{wood:12,stone:22,gold:2}, era:1, faction:'orc' },
  { type:'watchtower', name:'Watchtower', abbr:'WT', w:2, h:4, pw:40, ph:96, tall:true, cost:{wood:6,stone:15,gold:0}, era:1, faction:'human' },
  { type:'well', name:'Well', abbr:'WL', w:1, h:1, pw:24, ph:28, tall:false, cost:{wood:4,stone:10,gold:0}, era:1, faction:'neutral' },
  { type:'town_hall', name:'Town Hall', abbr:'TH', w:5, h:4, pw:100, ph:80, tall:false, cost:{wood:18,stone:30,gold:8}, era:2, faction:'human' },
  { type:'barracks', name:'Barracks', abbr:'BK', w:4, h:3, pw:88, ph:64, tall:false, cost:{wood:15,stone:25,gold:4}, era:2, faction:'orc' },
  { type:'church', name:'Church', abbr:'CH', w:3, h:5, pw:72, ph:100, tall:true, cost:{wood:12,stone:22,gold:9}, era:2, faction:'elf' },
  { type:'market', name:'Market', abbr:'MK', w:4, h:3, pw:96, ph:56, tall:false, cost:{wood:15,stone:18,gold:10}, era:2, faction:'dwarf' },
  { type:'brick_house', name:'Brick House', abbr:'BH', w:3, h:3, pw:72, ph:60, tall:false, cost:{wood:12,stone:38,gold:4}, era:3, faction:'human' },
  { type:'factory', name:'Factory', abbr:'FY', w:5, h:3, pw:110, ph:65, tall:false, cost:{wood:22,stone:60,gold:8}, era:3, faction:'orc' },
];

// Build times in ticks — fast paced gameplay
const BUILD_TIMES = {
  campfire:3, wood_hut:7, log_cabin:10, lumber_mill:10, farm:7,
  stone_house:13, quarry:13, blacksmith:13, watchtower:13, well:5,
  town_hall:20, barracks:20, church:20, market:20,
  brick_house:17, factory:23,
};

class RichGameLoop {
  constructor(worldState, wsServer) {
    this.world = worldState;
    this.wss = wsServer;
    this.intervalId = null;
    this.tickRate = parseInt(process.env.TICK_RATE_MS, 10) || 3000;

    if (this.world.resources === undefined) {
      this.world.resources = { wood: 0, stone: 0, gold: 0, food: 10 };
    }
    if (this.world.era === undefined) this.world.era = 0;
    if (!this.world.richBuildings) this.world.richBuildings = [];
    if (!this.world.settlements) this.world.settlements = [];

    this.agentStates = new Map();
  }

  start() {
    console.log(`[RichLoop] Starting at ${this.tickRate}ms/tick`);
    this.intervalId = setInterval(() => this.tick(), this.tickRate);
    this.tick();
  }

  stop() {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  tick() {
    try {
      this.world.tick = (this.world.tick || 0) + 1;
      const tick = this.world.tick;
      const events = [];

      for (const agent of this.world.agents.values()) {
        try { this._processAgent(agent, tick, events); } catch (e) {
          console.error(`[RichLoop] Agent ${agent.name} error:`, e.message);
        }
      }

      // Advance building construction
      for (const b of this.world.richBuildings) {
        if (!b.complete && b.builderPresent) {
          const buildTicks = BUILD_TIMES[b.type] || 20;
          b.progress = Math.min(1, b.progress + 1.0 / buildTicks);
          if (b.progress >= 1) {
            b.complete = true;
            b.builderPresent = false;
            events.push({ tick, type: 'build_complete', agent: b.builder, message: `${b.builder} completed ${b.name}!` });
          }
        }
      }

      this._checkEra(events);

      // Settlement formation (Prompt 3): every 20 ticks
      if (tick % 20 === 0) this._formSettlements(events);

      if (!this.world.events) this.world.events = [];
      this.world.events.push(...events);
      if (this.world.events.length > 300) this.world.events.splice(0, this.world.events.length - 300);

      if (this.wss) {
        broadcast(this.wss, 'tick', this._buildBroadcast(events));
      }

      if (tick % 10 === 0) {
        const r = this.world.resources;
        const agentSummary = [...this.world.agents.values()].map(a => {
          const st = this.agentStates.get(a.id);
          return `${a.name}(${a.x},${a.y}:${st ? st.state : '?'})`;
        }).join(' ');
        console.log(`[T${tick}] W:${r.wood} S:${r.stone} G:${r.gold} | Bld:${this.world.richBuildings.length} | ${agentSummary}`);
      }
    } catch (err) {
      console.error('[RichLoop] Tick error:', err);
    }
  }

  // ─── AGENT AI ───

  _getAgentSpeed(agent, st) {
    // Prompt 4: Variable speed based on personality and task
    let speed = 0.8;
    if (agent.personality === 'aggressive' || agent.personality === 'chaotic') speed *= 1.3;
    if (agent.personality === 'lazy') speed *= 0.6;
    if (agent.personality === 'grinder' || agent.personality === 'overachiever') speed *= 1.15;
    if (st && st.state === 'claiming') speed *= 1.2;
    return speed;
  }

  _processAgent(agent, tick, events) {
    let st = this.agentStates.get(agent.id);
    if (!st) {
      st = { state: 'idle', target: null, timer: 0, taskCooldown: 5 };
      this.agentStates.set(agent.id, st);
    }

    const speed = this._getAgentSpeed(agent, st);

    switch (st.state) {
      case 'idle':
        st.taskCooldown--;
        if (st.taskCooldown > 0) break;
        if (agent.personality === 'lazy' && Math.random() < 0.3) { st.taskCooldown = 10; break; }
        this._pickTask(agent, st, tick, events);
        break;

      case 'walking':
        if (this._moveToward(agent, st.target.x, st.target.y, speed)) {
          if (st.nextState) { st.state = st.nextState; st.timer = st.nextTimer || 0; }
          else { st.state = 'idle'; st.taskCooldown = 3; }
        }
        agent.mood = 'moving';
        break;

      case 'chopping':
        st.timer--;
        agent.mood = 'chopping'; // Prompt 7: send 'chopping' not 'moving'
        if (st.timer <= 0) {
          this.world.resources.wood += 8;
          events.push({ tick, type: 'gather', agent: agent.name, message: `${agent.name} chopped a tree (+8 wood)` });
          st.state = 'idle'; st.taskCooldown = 3;
          agent.mood = 'idle';
        }
        break;

      case 'mining':
        st.timer--;
        agent.mood = 'mining'; // Prompt 7: send 'mining' not 'moving'
        if (st.timer <= 0) {
          this.world.resources.stone += 5;
          events.push({ tick, type: 'gather', agent: agent.name, message: `${agent.name} mined stone (+5 stone)` });
          st.state = 'idle'; st.taskCooldown = 3;
          agent.mood = 'idle';
        }
        break;

      case 'mining_gold':
        st.timer--;
        agent.mood = 'mining_gold';
        if (st.timer <= 0) {
          this.world.resources.gold += 3;
          events.push({ tick, type: 'gather', agent: agent.name, message: `${agent.name} found gold (+3 gold)` });
          st.state = 'idle'; st.taskCooldown = 3;
          agent.mood = 'idle';
        }
        break;

      case 'building':
        agent.mood = 'building';
        if (!st.target || st.target.complete) { st.state = 'idle'; st.taskCooldown = 3; break; }
        const dist = Math.abs(agent.x - st.target.x) + Math.abs(agent.y - st.target.y);
        if (dist > 3) {
          this._moveToward(agent, st.target.x, st.target.y, speed);
        } else {
          st.target.builderPresent = true;
        }
        if (st.target.complete) {
          st.state = 'idle'; st.taskCooldown = 5;
          agent.mood = 'idle';
        }
        break;

      case 'claiming':
        agent.mood = 'claiming';
        if (st.target) {
          if (this._moveToward(agent, st.target.x, st.target.y, speed)) {
            const tileId = `${st.target.x},${st.target.y}`;
            const tile = this.world.tiles.get(tileId);
            if (tile && !tile.owner) {
              tile.owner = agent.id;
              agent.addTile(tileId);
            }
            st.state = 'idle'; st.taskCooldown = 2;
          }
        } else { st.state = 'idle'; }
        break;

      default:
        st.state = 'idle'; st.taskCooldown = 3;
    }

    if (!agent.mood) agent.mood = 'idle';
    // Prompt 7: include state in current_action for client animation
    agent.current_action = { type: st.state };
  }

  _pickTask(agent, st, tick, events) {
    const r = this.world.resources;
    const pers = agent.personality || 'analyst';

    if (r.wood < 15 || (r.wood < 40 && Math.random() < 0.6)) {
      const tree = this._findNearbyBiome(agent, ['forest', 'dense_forest'], 15);
      if (tree) {
        st.state = 'walking'; st.target = tree;
        st.nextState = 'chopping'; st.nextTimer = 5;
        st.taskCooldown = 0; return;
      }
    }

    if (this.world.era >= 1 && r.stone < 10) {
      const rock = this._findNearbyBiome(agent, ['hills', 'mountain'], 15);
      if (rock) {
        st.state = 'walking'; st.target = rock;
        st.nextState = 'mining'; st.nextTimer = 6;
        st.taskCooldown = 0; return;
      }
    }

    if (this.world.era >= 2 && r.gold < 5) {
      const gold = this._findNearbyBiome(agent, ['gold_vein'], 20);
      if (gold) {
        st.state = 'walking'; st.target = gold;
        st.nextState = 'mining_gold'; st.nextTimer = 8;
        st.taskCooldown = 0; return;
      }
    }

    // Build — use settlement-aware placement (Prompt 3)
    const buildChance = { overachiever: 0.5, analyst: 0.4, grinder: 0.3, aggressive: 0.2, lazy: 0.1, chaotic: 0.35, optimist: 0.4, confused: 0.2 };
    if (Math.random() < (buildChance[pers] || 0.3)) {
      const building = this._pickBuilding();
      if (building) {
        const spot = this._findBuildSpot(agent);
        if (spot) {
          r.wood -= building.cost.wood;
          r.stone -= building.cost.stone;
          r.gold -= building.cost.gold;
          const b = {
            type: building.type, name: building.name, abbr: building.abbr,
            x: spot.x, y: spot.y, progress: 0, complete: false,
            faction: building.faction, width: building.w, height: building.h,
            pw: building.pw, ph: building.ph, tall: building.tall,
            builder: agent.name, settlement: spot.settlement || null,
            builderPresent: false,
          };
          this.world.richBuildings.push(b);
          st.state = 'building'; st.target = b; st.taskCooldown = 0;
          events.push({ tick, type: 'build_started', agent: agent.name, message: `${agent.name} started building ${building.name}` });
          return;
        }
      }
    }

    const unclaimed = this._findNearbyUnclaimed(agent, 8);
    if (unclaimed) {
      st.state = 'claiming'; st.target = unclaimed; st.taskCooldown = 0; return;
    }

    const tree2 = this._findNearbyBiome(agent, ['forest', 'dense_forest'], 20);
    if (tree2) {
      st.state = 'walking'; st.target = tree2;
      st.nextState = 'chopping'; st.nextTimer = 5;
      st.taskCooldown = 0; return;
    }

    st.state = 'walking';
    st.target = { x: Math.max(2, Math.min(this.world.width - 3, agent.x + Math.floor(Math.random() * 11) - 5)),
                  y: Math.max(2, Math.min(this.world.height - 3, agent.y + Math.floor(Math.random() * 11) - 5)) };
    st.nextState = 'idle'; st.nextTimer = 0; st.taskCooldown = 0;
  }

  _pickBuilding() {
    const r = this.world.resources;
    const era = this.world.era;
    const builtTypes = new Set(this.world.richBuildings.filter(b => b.complete).map(b => b.type));

    const available = TECH_TREE.filter(b => {
      if (b.era > era) return false;
      if (b.cost.wood > r.wood || b.cost.stone > r.stone || b.cost.gold > r.gold) return false;
      const count = this.world.richBuildings.filter(eb => eb.type === b.type).length;
      if (count >= 5) return false;
      return true;
    });

    if (available.length === 0) return null;
    const unbuilt = available.filter(b => !builtTypes.has(b.type));
    if (unbuilt.length > 0) return unbuilt[Math.floor(Math.random() * unbuilt.length)];
    return available[Math.floor(Math.random() * available.length)];
  }

  // Prompt 3: Settlement-aware build spot
  _findBuildSpot(agent) {
    const tiles = this.world.tiles;
    const width = this.world.width, height = this.world.height;
    const buildings = this.world.richBuildings;

    // First: try to build near an existing settlement center
    if (this.world.settlements.length > 0) {
      let nearestS = null, nearestD = Infinity;
      for (const s of this.world.settlements) {
        const d = Math.abs(agent.x - s.cx) + Math.abs(agent.y - s.cy);
        if (d < nearestD) { nearestD = d; nearestS = s; }
      }
      if (nearestS && nearestD < 30) {
        const spot = this._findSpotNear(nearestS.cx, nearestS.cy, 2, 10, tiles, width, height, buildings);
        if (spot) { spot.settlement = nearestS.name; return spot; }
      }
    }

    // Second: build near existing building cluster
    const nearby = buildings.filter(b => Math.abs(b.x - agent.x) + Math.abs(b.y - agent.y) < 20);
    if (nearby.length >= 2) {
      const cx = Math.round(nearby.reduce((s, b) => s + b.x, 0) / nearby.length);
      const cy = Math.round(nearby.reduce((s, b) => s + b.y, 0) / nearby.length);
      return this._findSpotNear(cx, cy, 2, 8, tiles, width, height, buildings);
    }

    // Third: build near agent
    return this._findSpotNear(agent.x, agent.y, 2, 6, tiles, width, height, buildings);
  }

  _findSpotNear(cx, cy, minR, maxR, tiles, width, height, buildings) {
    const startAngle = Math.random() * Math.PI * 2;
    for (let radius = minR; radius <= maxR; radius++) {
      for (let i = 0; i < 12; i++) {
        const angle = startAngle + (i * Math.PI * 2 / 12);
        const rx = Math.max(2, Math.min(width - 3, cx + Math.round(Math.cos(angle) * radius)));
        const ry = Math.max(2, Math.min(height - 3, cy + Math.round(Math.sin(angle) * radius)));
        const tile = tiles.get(`${rx},${ry}`);
        if (!tile) continue;
        if (['deep_water', 'shallow_water', 'river'].includes(tile.biome)) continue;
        // Check full footprint for water
        let onWater = false;
        for (let dy = 0; dy <= 3 && !onWater; dy++) {
          for (let dx = 0; dx <= 3 && !onWater; dx++) {
            const t2 = tiles.get(`${rx + dx},${ry + dy}`);
            if (t2 && ['deep_water', 'shallow_water', 'river'].includes(t2.biome)) onWater = true;
          }
        }
        if (onWater) continue;
        const tooClose = buildings.some(b => Math.abs(b.x - rx) + Math.abs(b.y - ry) < 4);
        if (tooClose) continue;
        return { x: rx, y: ry };
      }
    }
    return null;
  }

  // Prompt 3: Settlement formation
  _formSettlements(events) {
    const buildings = this.world.richBuildings.filter(b => b.complete);
    const unassigned = buildings.filter(b => !b.settlement);

    for (const b of unassigned) {
      // Check if near existing settlement
      let joined = false;
      for (const s of this.world.settlements) {
        if (Math.abs(b.x - s.cx) + Math.abs(b.y - s.cy) < 12) {
          b.settlement = s.name;
          s.buildingCount = buildings.filter(b2 => b2.settlement === s.name).length;
          joined = true;
          break;
        }
      }
      if (joined) continue;

      // Check if 2+ nearby unassigned buildings → form settlement
      const nearbyUnassigned = unassigned.filter(b2 =>
        b2 !== b && Math.abs(b2.x - b.x) + Math.abs(b2.y - b.y) < 8
      );
      if (nearbyUnassigned.length >= 1) {
        const prefixes = ['Oak', 'Pine', 'Maple', 'Iron', 'Silver', 'Sun', 'Storm', 'Frost', 'Meadow', 'River', 'Hill', 'Stone', 'Ember', 'Shadow', 'Moon'];
        const suffixes = ['wood', 'dale', 'heim', 'keep', 'haven', 'hollow', 'ridge', 'field', 'crest', 'vale', ' Village', ' Camp'];
        let name = prefixes[Math.floor(Math.random() * prefixes.length)] + suffixes[Math.floor(Math.random() * suffixes.length)];
        // Ensure unique
        while (this.world.settlements.find(s => s.name === name)) {
          name = prefixes[Math.floor(Math.random() * prefixes.length)] + suffixes[Math.floor(Math.random() * suffixes.length)];
        }
        const s = { name, cx: b.x, cy: b.y, buildingCount: nearbyUnassigned.length + 1 };
        this.world.settlements.push(s);
        b.settlement = name;
        nearbyUnassigned.forEach(nb => nb.settlement = name);
        events.push({ tick: this.world.tick, type: 'settlement_formed', message: `🏘️ ${name} was founded!` });
      }
    }
  }

  _moveToward(agent, tx, ty, speed) {
    const dx = tx - agent.x, dy = ty - agent.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dist <= speed) {
      agent.x = tx; agent.y = ty;
      return true;
    }
    agent.x += Math.sign(dx) * Math.min(Math.abs(dx), speed);
    agent.y += Math.sign(dy) * Math.min(Math.abs(dy), speed);
    agent.x = Math.max(0, Math.min(this.world.width - 1, Math.round(agent.x)));
    agent.y = Math.max(0, Math.min(this.world.height - 1, Math.round(agent.y)));
    return false;
  }

  _findNearbyBiome(agent, biomes, radius) {
    const tiles = this.world.tiles;
    for (let r = 1; r <= radius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = agent.x + dx, ty = agent.y + dy;
          const tile = tiles.get(`${tx},${ty}`);
          if (tile && biomes.includes(tile.biome)) return { x: tx, y: ty };
        }
      }
    }
    return null;
  }

  _findNearbyUnclaimed(agent, radius) {
    const tiles = this.world.tiles;
    for (let r = 1; r <= radius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = agent.x + dx, ty = agent.y + dy;
          const tile = tiles.get(`${tx},${ty}`);
          if (tile && !tile.owner && !['deep_water', 'shallow_water', 'river'].includes(tile.biome)) {
            return { x: tx, y: ty };
          }
        }
      }
    }
    return null;
  }

  _checkEra(events) {
    const builtTypes = new Set(this.world.richBuildings.filter(b => b.complete).map(b => b.type));
    const era = this.world.era;
    if (era >= 3) return;
    const eraBuildings = TECH_TREE.filter(b => b.era === era && !b.decorative);
    if (eraBuildings.every(b => builtTypes.has(b.type))) {
      this.world.era++;
      const names = ['Wood Age', 'Stone Age', 'Iron Age', 'Modern Age'];
      events.push({ tick: this.world.tick, type: 'era_change', message: `=== ERA CHANGE: ${names[this.world.era]} ===` });
      console.log(`[ERA] Advanced to ${names[this.world.era]}`);
    }
  }

  // Prompt 7: Include _state and target in broadcast for client animations
  _buildBroadcast(events) {
    const agents = [];
    for (const agent of this.world.agents.values()) {
      const st = this.agentStates.get(agent.id);
      agents.push({
        id: agent.id, name: agent.name, faction: agent.faction,
        personality: agent.personality, x: agent.x, y: agent.y,
        mood: agent.mood || 'idle', current_action: agent.current_action || null,
        owned_tiles: agent.owned_tiles ? agent.owned_tiles.length : 0,
        buildings_count: this.world.richBuildings.filter(b => b.builder === agent.name).length,
        work_balance: 0, resources: this.world.resources,
        message: agent.message || '',
        _state: st ? st.state : 'idle',
        _targetX: st && st.target ? st.target.x : undefined,
        _targetY: st && st.target ? st.target.y : undefined,
      });
    }

    const tiles = [];
    for (const tile of this.world.tiles.values()) {
      if (tile.owner || tile.building) {
        tiles.push({ x: tile.x, y: tile.y, tileId: tile.tileId, biome: tile.biome, owner: tile.owner });
      }
    }

    return {
      tick: this.world.tick,
      agents,
      tiles,
      buildings: this.world.richBuildings,
      events,
      leaderboard: this._buildLeaderboard(),
      resources: this.world.resources,
      era: this.world.era,
      settlements: this.world.settlements,
    };
  }

  _buildLeaderboard() {
    const entries = [];
    for (const agent of this.world.agents.values()) {
      const buildCount = this.world.richBuildings.filter(b => b.builder === agent.name && b.complete).length;
      const territory = agent.owned_tiles ? agent.owned_tiles.length : 0;
      entries.push({
        id: agent.id, name: agent.name, faction: agent.faction,
        personality: agent.personality, territory, buildings: buildCount,
        score: territory * 10 + buildCount * 25,
      });
    }
    entries.sort((a, b) => b.score - a.score);
    return entries;
  }
}

module.exports = RichGameLoop;
