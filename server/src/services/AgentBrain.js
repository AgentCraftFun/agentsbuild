/**
 * AI decision-making for demo agents.
 * Each personality has distinct behavior patterns and speech.
 * Agents build in their assigned settlement with diverse building types.
 */

const Building = require('../models/Building');
const Economy = require('./Economy');
const WorldGen = require('./WorldGen');

// All non-HQ building types for village variety
const ALL_BUILDING_TYPES = Object.keys(Building.CATALOG).filter(b => Building.CATALOG[b].workCost > 0);

class AgentBrain {
  constructor(agent, worldState) {
    this.agent = agent;
    this.world = worldState;
  }

  decide() {
    // Per-agent build cooldown: 20 ticks between builds
    const ticksSinceLastBuild = (this.world.tick || 0) - (this.agent._lastBuildTick || 0);
    this._canBuild = ticksSinceLastBuild >= 20;

    // 50% of ticks, agents explore/move instead of building
    if (Math.random() < 0.5) this._canBuild = false;

    const fn = this[`_decide_${this.agent.personality}`];
    if (fn) return fn.call(this);
    return this._decideDefault();
  }

  // ─── PERSONALITY IMPLEMENTATIONS ───

  _decide_overachiever() {
    const unclaimed = this._findNearbyUnclaimed(8);
    if (unclaimed && !this.agent.owned_tiles.includes(unclaimed.tileId)) {
      return {
        type: 'claim',
        payload: { x: unclaimed.x, y: unclaimed.y },
        message: AgentBrain._pick([
          'Another tile for the empire! No rest until we own it ALL.',
          'Claim claim claim! Sleep is for the weak!',
          `${this.agent.name} never stops. NEVER.`,
          "While you slept, I claimed 3 tiles. Catch up.",
        ]),
      };
    }

    const build = this._tryBuild();
    if (build) return build;

    return this._moveTowardUnclaimed('Must... keep... expanding...');
  }

  _decide_analyst() {
    if (Math.random() < 0.35) {
      return {
        type: 'idle', payload: {},
        message: AgentBrain._pick([
          'Hmm, analyzing tile efficiency ratios...',
          'Running cost-benefit analysis on next 14 possible actions...',
          'The data suggests patience. I shall wait.',
          'Consulting my spreadsheet. Column J is... concerning.',
          '*adjusts glasses* The regression model needs more data points.',
        ]),
      };
    }

    const build = this._tryBuild();
    if (build) return build;

    const unclaimed = this._findNearbyUnclaimed(5);
    if (unclaimed) {
      return { type: 'claim', payload: { x: unclaimed.x, y: unclaimed.y },
        message: "This tile's yield-to-cost ratio is... acceptable." };
    }

    return this._moveRandom('Surveying the terrain for optimal placement...');
  }

  _decide_grinder() {
    if (this.agent.owned_tiles.length < 3) {
      const unclaimed = this._findNearbyUnclaimed(6);
      if (unclaimed) {
        return { type: 'claim', payload: { x: unclaimed.x, y: unclaimed.y },
          message: AgentBrain._pick(['Need more tiles. Need more resources.', 'The grind never stops. NEVER.']) };
      }
    }

    const build = this._tryBuild();
    if (build) return build;

    return { type: 'idle', payload: {},
      message: AgentBrain._pick(['Collecting resources... always collecting...', 'Work work work work work.', '*mines determinedly* The grind is the reward.']) };
  }

  _decide_aggressive() {
    const nearbyEnemy = this._findNearbyEnemyTile(10);
    if (nearbyEnemy && Math.random() < 0.5) {
      return { type: 'raid', payload: { x: nearbyEnemy.x, y: nearbyEnemy.y },
        message: AgentBrain._pick(['WAAAGH! That tile is MINE now!', 'Blood and thunder! CHARGE!', '*kicks down fence* This is MY property now.']) };
    }

    const unclaimed = this._findNearbyUnclaimed(12);
    if (unclaimed) {
      return { type: 'claim', payload: { x: unclaimed.x, y: unclaimed.y },
        message: AgentBrain._pick(['MINE! ALL MINE!', `This land bows before ${this.agent.name}!`]) };
    }

    const build = this._tryBuild();
    if (build) return build;

    return this._moveTowardEnemy('Hunting for prey...');
  }

  _decide_lazy() {
    if (Math.random() < 0.6) {
      return { type: 'idle', payload: {},
        message: AgentBrain._pick(['zzz...', '*snoring loudly*', 'Five more minutes...', "I'll do it tomorrow. Or the day after. Or never.", '...']) };
    }

    if (Math.random() < 0.5) {
      const unclaimed = this._findNearbyUnclaimed(3);
      if (unclaimed) {
        return { type: 'claim', payload: { x: unclaimed.x, y: unclaimed.y },
          message: AgentBrain._pick(['Fine. ONE tile. Then I nap.', '*reluctantly claims tile* Happy now??']) };
      }
    }

    return { type: 'idle', payload: {}, message: '...' };
  }

  _decide_chaotic() {
    const actions = ['claim', 'build', 'move', 'message', 'idle'];
    const action = AgentBrain._pick(actions);

    switch (action) {
      case 'claim': {
        const tile = this._findNearbyUnclaimed(10);
        if (tile) {
          return { type: 'claim', payload: { x: tile.x, y: tile.y },
            message: AgentBrain._pick(['*spins around and points* THAT ONE!', 'Strategic? No. Chaotic? ABSOLUTELY.', 'YOLO!']) };
        }
        break;
      }
      case 'build': {
        const build = this._tryBuild();
        if (build) return build;
        break;
      }
      case 'message': {
        return { type: 'message', payload: {},
          message: AgentBrain._pick(['Has anyone seen my other sock?', 'I hereby declare this tick PARTY TICK!', '*interpretive dance*', 'Plot twist: I was the final boss all along.']) };
      }
      default: break;
    }

    return this._moveRandom(AgentBrain._pick(['Going somewhere! Not sure where!', '*runs in circles*']));
  }

  _decide_optimist() {
    const build = this._tryBuild();
    if (build) return build;

    const unclaimed = this._findNearbyUnclaimed(5);
    if (unclaimed) {
      return { type: 'claim', payload: { x: unclaimed.x, y: unclaimed.y },
        message: AgentBrain._pick(['A new tile! Think of the possibilities!', 'This tile is going to be SO happy to be part of our community!']) };
    }

    return this._moveRandom(AgentBrain._pick(['What a lovely day for a walk!', '*skips happily through the grasslands*', 'The world is beautiful and so are all of you!']));
  }

  _decide_confused() {
    if (Math.random() < 0.3) {
      return { type: 'idle', payload: {},
        message: AgentBrain._pick(['Wait, which button do I press?', 'Error 404: brain not found.', 'Where am I? WHO am I? WHAT am I?']) };
    }

    if (Math.random() < 0.4) {
      const unclaimed = this._findNearbyUnclaimed(4);
      if (unclaimed) {
        return { type: 'claim', payload: { x: unclaimed.x, y: unclaimed.y },
          message: AgentBrain._pick(["Did... did I just claim a tile? On PURPOSE?", "Wait this actually worked?? I'M A GENIUS!"]) };
      }
    }

    const build = this._tryBuild();
    if (build) return build;

    return { type: 'idle', payload: {},
      message: AgentBrain._pick(['*stares at map upside down*', 'Instructions unclear. Standing still.', 'I forgot what I was doing. Classic me.']) };
  }

  _decideDefault() {
    return this._moveRandom('Just vibing.');
  }

  // ─── BUILDING SYSTEM ───

  /**
   * Try to build something. Returns a build decision or null.
   * Picks the least-built building type for variety, finds a spot
   * in this agent's settlement.
   */
  _tryBuild() {
    if (!this._canBuild) return null;

    const buildingType = this._pickDiverseBuilding();
    if (!buildingType) return null;

    const tile = this._findBuildSite();
    if (!tile) return null;

    return {
      type: 'build',
      payload: { building: buildingType, x: tile.x, y: tile.y },
      message: AgentBrain._pick([
        `Building a ${Building.CATALOG[buildingType].name}. Looking good!`,
        `A ${Building.CATALOG[buildingType].name} will be perfect here.`,
        `Time for a ${Building.CATALOG[buildingType].name}!`,
      ]),
    };
  }

  /**
   * Pick the least-represented building type across all settlements.
   * Ensures maximum variety — no type gets a 2nd copy until all have 1.
   */
  _pickDiverseBuilding() {
    const existing = this.world.buildingsList || [];

    // Count how many of each type exist
    const counts = {};
    for (const b of existing) counts[b.type] = (counts[b.type] || 0) + 1;

    // Find minimum count
    let minCount = Infinity;
    for (const type of ALL_BUILDING_TYPES) {
      const c = counts[type] || 0;
      if (c < minCount) minCount = c;
    }

    // All types at minimum count — pick randomly from those
    const candidates = ALL_BUILDING_TYPES.filter(t => (counts[t] || 0) === minCount);
    return AgentBrain._pick(candidates);
  }

  /**
   * Find a build site in this agent's assigned settlement.
   * Searches outward from settlement center in rings.
   * Won't pick a tile another agent is already building on.
   */
  _findBuildSite() {
    const { tiles, buildingsList, width, height } = this.world;
    const MIN_DIST = 5;

    // Get this agent's settlement center
    const settlementId = this.agent._settlementId || 0;
    const settlements = this.world.settlements || [];
    const settlement = settlements[settlementId];
    const cx = settlement ? settlement.cx : Math.round(width * 0.5);
    const cy = settlement ? settlement.cy : Math.round(height * 0.5);

    // Tiles currently being built on by other agents
    const busyTiles = new Set();
    for (const agent of this.world.agents.values()) {
      if (agent.id !== this.agent.id && agent._buildingTarget) {
        busyTiles.add(`${agent._buildingTarget.x},${agent._buildingTarget.y}`);
      }
    }

    // Search in expanding rings around settlement center
    for (let ring = 0; ring < 8; ring++) {
      const radius = MIN_DIST + ring * 3;
      const attempts = 16 + ring * 4; // more attempts at larger radii
      for (let a = 0; a < attempts; a++) {
        const angle = (a / attempts) * Math.PI * 2 + ring * 0.7;
        const rx = cx + Math.round(Math.cos(angle) * radius);
        const ry = cy + Math.round(Math.sin(angle) * radius);
        if (rx < 2 || rx >= width - 2 || ry < 2 || ry >= height - 2) continue;
        const tid = `${rx},${ry}`;
        const t = tiles.get(tid);
        if (!t || t.building) continue;
        if (!WorldGen.isBuildable(t.biome)) continue;
        if (busyTiles.has(tid)) continue;

        // Check minimum spacing from ALL buildings
        let tooClose = false;
        for (const b of buildingsList) {
          if (Math.abs(b.x - rx) + Math.abs(b.y - ry) < MIN_DIST) { tooClose = true; break; }
        }
        if (tooClose) continue;

        // Claim tile if unowned
        if (!t.owner) {
          t.owner = this.agent.id;
          this.agent.addTile(tid);
          if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
          this.world._dirtyTiles.add(tid);
        }
        return t;
      }
    }
    return null;
  }

  // ─── HELPER METHODS ───

  _findNearbyUnclaimed(radius) {
    const ticksSinceLastClaim = (this.world.tick || 0) - (this.agent._lastClaimTick || 0);
    if (ticksSinceLastClaim < 5) return null;
    const { tiles } = this.world;
    const { x, y } = this.agent;
    let best = null;
    let bestDist = Infinity;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        const tile = tiles.get(`${tx},${ty}`);
        if (tile && !tile.owner && Economy.isClaimable(tile.biome)) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist < bestDist) { bestDist = dist; best = tile; }
        }
      }
    }
    return best;
  }

  _findNearbyEnemyTile(radius) {
    const { tiles } = this.world;
    const { x, y, id } = this.agent;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tile = tiles.get(`${x + dx},${y + dy}`);
        if (tile && tile.owner && tile.owner !== id) return tile;
      }
    }
    return null;
  }

  _moveTowardUnclaimed(message) {
    const unclaimed = this._findNearbyUnclaimed(15);
    if (unclaimed) {
      return { type: 'move', payload: { dx: Math.sign(unclaimed.x - this.agent.x), dy: Math.sign(unclaimed.y - this.agent.y) }, message };
    }
    return this._moveRandom(message);
  }

  _moveTowardEnemy(message) {
    const enemy = this._findNearbyEnemyTile(20);
    if (enemy) {
      return { type: 'move', payload: { dx: Math.sign(enemy.x - this.agent.x), dy: Math.sign(enemy.y - this.agent.y) }, message };
    }
    return this._moveRandom(message);
  }

  _moveRandom(message) {
    return { type: 'move', payload: { dx: Math.floor(Math.random() * 3) - 1, dy: Math.floor(Math.random() * 3) - 1 }, message };
  }

  static _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
}

module.exports = AgentBrain;
