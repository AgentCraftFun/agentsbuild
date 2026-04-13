/**
 * AI decision-making for demo agents.
 * Each personality has distinct behavior patterns and speech.
 * Agents build in their assigned settlement with diverse building types.
 */

const Building = require('../models/Building');
const Economy = require('./Economy');
const WorldGen = require('./WorldGen');

// All non-HQ building types for village variety
// Grassland-only build options: excludes cyberpunk buildings (those are
// only buildable when an agent's currentWorld === 'cyber').
const ALL_BUILDING_TYPES = Object.keys(Building.CATALOG).filter(b => {
  const def = Building.CATALOG[b];
  return def.workCost > 0 && def.world !== 'cyber';
});

// Zone categories for logical settlement layout
const CENTER_TYPES = new Set(['well', 'fountain', 'monument', 'market', 'tavern', 'inn', 'chapel', 'shrine']);
const RESIDENTIAL_TYPES = new Set(['cottage', 'farmstead', 'pig_farm', 'brewery', 'bakery', 'apartment', 'granary']);
const INDUSTRY_TYPES = new Set(['lumber_mill', 'mine_shaft', 'stonecutter', 'warehouse', 'storehouse', 'blacksmith', 'runeforge', 'starforge', 'blood_forge']);
const OUTER_TYPES = new Set(['watchtower', 'spike_tower', 'sentinel_tree', 'stone_wall', 'stable', 'barn', 'windmill', 'garden', 'herbalist', 'grove', 'training_ground', 'arena', 'war_pit']);

class AgentBrain {
  constructor(agent, worldState) {
    this.agent = agent;
    this.world = worldState;
  }

  decide() {
    // ── FLEE CHECK: if this agent is running from a disaster, move away from it
    const tick = this.world.tick || 0;
    if (this.agent._fleeFrom && this.agent._fleeFrom.until > tick) {
      const f = this.agent._fleeFrom;
      const dx = Math.sign(this.agent.x - f.x) || (Math.random() > 0.5 ? 1 : -1);
      const dy = Math.sign(this.agent.y - f.y) || (Math.random() > 0.5 ? 1 : -1);
      return {
        type: 'move',
        payload: { dx, dy },
        message: AgentBrain._pick([
          'RUN!!! GET AWAY!',
          'The ground is shaking!',
          'We need to get out of here!',
          'FLEE!!!',
          'This place is cursed!',
          '*sprints for dear life*',
        ]),
      };
    } else if (this.agent._fleeFrom) {
      this.agent._fleeFrom = null;  // clear expired flee state
    }

    // Per-agent build cooldown: 20 ticks between builds
    const ticksSinceLastBuild = tick - (this.agent._lastBuildTick || 0);
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
   * Prefers small villages (4-10 buildings). Once current settlement is
   * big enough, agent will proactively pioneer a new one.
   */
  _tryBuild() {
    if (!this._canBuild) return null;

    const buildingType = this._pickDiverseBuilding();
    if (!buildingType) return null;

    // Check if agent can afford the building
    const cost = Building.CATALOG[buildingType].workCost || 0;
    if (cost > 0 && this.agent.work_balance < cost) return null;

    // CYBER WORLD branch: skip the settlement-based site finder and use a
    // simple "any free nearby tile" search. Cyber agents build wherever.
    if (this.agent.currentWorld === 'cyber') {
      const cyberTile = this._findCyberBuildSite(buildingType);
      if (!cyberTile) return null;
      return {
        type: 'build',
        payload: { building: buildingType, x: cyberTile.x, y: cyberTile.y },
        message: AgentBrain._pick([
          `Building a ${Building.CATALOG[buildingType].name} in Neo-Kyoto!`,
          `The future is now. New ${Building.CATALOG[buildingType].name} going up.`,
          `Every megablock needs a ${Building.CATALOG[buildingType].name}.`,
        ]),
      };
    }

    // Displaced agents (village destroyed by raid) always pioneer a new settlement
    if (this.agent._displaced) {
      const tile = this._findNewSettlementSite();
      if (tile) {
        this.agent._displaced = false;
        return {
          type: 'build',
          payload: { building: buildingType, x: tile.x, y: tile.y },
          message: AgentBrain._pick([
            `My home was destroyed... but I will rebuild!`,
            `Rising from the ashes. A new beginning.`,
            `They burned my village, but not my spirit!`,
          ]),
        };
      }
    }

    // Count buildings in current settlement
    const settlementId = this.agent._settlementId || 0;
    const settlements = this.world.settlements || [];
    const settlement = settlements[settlementId];
    const cx = settlement ? settlement.cx : 0;
    const cy = settlement ? settlement.cy : 0;
    const settlementBuildingCount = (this.world.buildingsList || []).filter(b => {
      return Math.abs(b.x - cx) + Math.abs(b.y - cy) < 30;
    }).length;

    // TARGET: small villages of 4-10 buildings.
    // Once a settlement has 6+ buildings, 60% chance to pioneer instead.
    // Once 10+, 90% chance to pioneer.
    const shouldPioneer = settlementBuildingCount >= 10 ? Math.random() < 0.90
      : settlementBuildingCount >= 6 ? Math.random() < 0.60
      : false;

    if (shouldPioneer) {
      const tile = this._findNewSettlementSite();
      if (tile) {
        return {
          type: 'build',
          payload: { building: buildingType, x: tile.x, y: tile.y },
          message: AgentBrain._pick([
            `${settlement ? settlement.name : 'Town'} is thriving. Time to explore new lands!`,
            `I\'ll found a new village out here!`,
            `This spot looks perfect for a fresh start.`,
            `The frontier calls! Building a new outpost.`,
          ]),
        };
      }
    }

    // Otherwise build in current settlement
    let tile = this._findBuildSite(buildingType);
    if (!tile) {
      // Settlement is physically full — must pioneer
      tile = this._findNewSettlementSite();
      if (!tile) return null;
      return {
        type: 'build',
        payload: { building: buildingType, x: tile.x, y: tile.y },
        message: AgentBrain._pick([
          `No room left... building somewhere new!`,
          `Time to pioneer new lands!`,
        ]),
      };
    }

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
    // CYBER WORLD: use the cyber building catalog instead of grassland types.
    // Same diversity logic: pick the type with the fewest existing instances
    // in the same world the agent is currently in.
    if (this.agent.currentWorld === 'cyber') {
      const cyberTypes = Object.keys(Building.CATALOG).filter(t => Building.CATALOG[t].world === 'cyber');
      const cyberExisting = existing.filter(b => b.world === 'cyber');
      const cyberCounts = {};
      for (const b of cyberExisting) cyberCounts[b.type] = (cyberCounts[b.type] || 0) + 1;
      let cMin = Infinity;
      for (const t of cyberTypes) {
        const c = cyberCounts[t] || 0;
        if (c < cMin) cMin = c;
      }
      const cyberCandidates = cyberTypes.filter(t => (cyberCounts[t] || 0) === cMin);
      return AgentBrain._pick(cyberCandidates);
    }

    // Grassland (default): all-types diversity pick
    const counts = {};
    for (const b of existing) counts[b.type] = (counts[b.type] || 0) + 1;
    let minCount = Infinity;
    for (const type of ALL_BUILDING_TYPES) {
      const c = counts[type] || 0;
      if (c < minCount) minCount = c;
    }
    const candidates = ALL_BUILDING_TYPES.filter(t => (counts[t] || 0) === minCount);
    return AgentBrain._pick(candidates);
  }

  /**
   * Find a build site for a CYBER agent — settlement-clustered, matching
   * the grassland village-style aesthetic.
   *
   * Strategy (same priority as grassland):
   *   1. Look up the agent's cyber settlement center (set on portal entry)
   *   2. Pick a random tile within that settlement's radius
   *   3. Reject if too close to another cyber building (MIN_DIST=4)
   *   4. Reject if another agent is already building there
   *   5. Fall back to agent position if no settlement exists
   */
  _findCyberBuildSite(buildingType) {
    const { buildingsList, width, height } = this.world;
    const def = Building.CATALOG[buildingType];
    const w = def.width || 1, h = def.height || 1;
    const MIN_DIST = 4; // Tighter clustering looks more village-like

    // Resolve settlement center
    const setts = this.world.cyberSettlements || [];
    const settId = this.agent._cyberSettlementId;
    let cx, cy, settRadius = 15;
    if (settId != null && setts[settId]) {
      cx = setts[settId].cx;
      cy = setts[settId].cy;
      settRadius = setts[settId].radius || 15;
    } else {
      // Fallback: use agent position (shouldn't normally happen)
      cx = this.agent.x;
      cy = this.agent.y;
    }

    // Tiles being built on by other agents
    const busy = new Set();
    for (const a of this.world.agents.values()) {
      if (a.id !== this.agent.id && a._buildingTarget) {
        busy.add(`${a._buildingTarget.x},${a._buildingTarget.y}`);
      }
    }
    // Existing cyber buildings to space against
    const cyberBlds = buildingsList.filter(b => b.world === 'cyber');

    // Try random spots within the settlement radius
    for (let attempt = 0; attempt < 40; attempt++) {
      // Pick a point inside a disk of radius settRadius centered on (cx, cy)
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * settRadius;
      const rx = Math.round(cx + Math.cos(angle) * r);
      const ry = Math.round(cy + Math.sin(angle) * r);
      if (rx < 2 || ry < 2 || rx + w >= width - 2 || ry + h >= height - 2) continue;
      if (busy.has(`${rx},${ry}`)) continue;
      // Too close to another cyber building?
      let tooClose = false;
      for (const b of cyberBlds) {
        if (Math.abs(b.x - rx) + Math.abs(b.y - ry) < MIN_DIST) { tooClose = true; break; }
      }
      if (tooClose) continue;
      // Found a spot — record it on the agent for the build mood
      this.agent._buildingTarget = { x: rx, y: ry };
      return { x: rx, y: ry };
    }
    return null;
  }

  /**
   * Find a build site in this agent's assigned settlement.
   * Uses zone-based placement: center (public), middle (residential),
   * outer (industry/defense) for realistic village layouts.
   * Won't pick a tile another agent is already building on.
   */
  _findBuildSite(buildingType) {
    const { tiles, buildingsList, width, height } = this.world;
    const MIN_DIST = 3; // tighter spacing for denser, more natural villages

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

    // Count existing buildings in this settlement to scale search radius
    const settlementBuildings = buildingsList.filter(b => {
      const dx = Math.abs(b.x - cx);
      const dy = Math.abs(b.y - cy);
      return dx + dy < 60;
    }).length;

    // Determine zone for this building type — center, middle, or outer ring
    let minRing, maxRing;
    if (CENTER_TYPES.has(buildingType)) {
      minRing = 0; maxRing = Math.min(6, 3 + Math.floor(settlementBuildings / 6));
    } else if (RESIDENTIAL_TYPES.has(buildingType)) {
      minRing = 2; maxRing = Math.min(12, 5 + Math.floor(settlementBuildings / 4));
    } else if (INDUSTRY_TYPES.has(buildingType)) {
      minRing = 4; maxRing = Math.min(16, 7 + Math.floor(settlementBuildings / 3));
    } else if (OUTER_TYPES.has(buildingType)) {
      minRing = 5; maxRing = Math.min(20, 8 + Math.floor(settlementBuildings / 3));
    } else {
      // Default: residential zone
      minRing = 1; maxRing = Math.min(16, 6 + Math.floor(settlementBuildings / 4));
    }

    // Search in zone-appropriate rings around settlement center
    // Use road-like grid pattern: buildings placed along 4 cardinal + 4 diagonal directions
    const directions = 8;
    for (let ring = minRing; ring <= maxRing; ring++) {
      const radius = MIN_DIST + ring * 2; // tighter spacing between rings
      const attempts = directions * (2 + ring); // more attempts at larger radii
      for (let a = 0; a < attempts; a++) {
        // Mix grid-aligned positions with slight randomness for organic feel
        const baseAngle = (a / attempts) * Math.PI * 2;
        const jitter = (Math.random() - 0.5) * 0.3; // slight angle jitter
        const angle = baseAngle + jitter;
        const distJitter = (Math.random() - 0.5) * 1.5; // slight distance jitter
        const rx = cx + Math.round(Math.cos(angle) * (radius + distJitter));
        const ry = cy + Math.round(Math.sin(angle) * (radius + distJitter));
        if (rx < 2 || rx >= width - 2 || ry < 2 || ry >= height - 2) continue;
        const tid = `${rx},${ry}`;
        const t = tiles.get(tid);
        if (!t || t.building) continue;
        if (!WorldGen.isBuildable(t.biome)) continue;
        if (busyTiles.has(tid)) continue;

        // Check neighboring tiles are also buildable (buildings are 2x2+)
        let neighborsBad = false;
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const nt = tiles.get(`${rx + dx},${ry + dy}`);
            if (!nt || !WorldGen.isBuildable(nt.biome)) { neighborsBad = true; break; }
          }
          if (neighborsBad) break;
        }
        if (neighborsBad) continue;

        // Check minimum spacing — use spatial index for O(1) query (fallback to linear scan)
        let tooClose = false;
        if (this.world._spatialIndex) {
          tooClose = this.world._spatialIndex.anyWithin(rx, ry, MIN_DIST);
        } else {
          for (const b of buildingsList) {
            if (Math.abs(b.x - rx) + Math.abs(b.y - ry) < MIN_DIST) { tooClose = true; break; }
          }
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

  /**
   * Find a site for a brand new settlement anywhere on the map.
   * Searches random locations, preferring spots far from ALL existing settlements.
   * Minimum 15 tiles from any settlement center, 5 from any building.
   */
  _findNewSettlementSite() {
    const { tiles, buildingsList, width, height } = this.world;
    const MIN_BUILD_DIST = 5;
    const MIN_SETTLEMENT_DIST = 15; // tiles from any existing settlement center

    const settlements = this.world.settlements || [];

    // Try 80 random locations across the entire map
    for (let attempt = 0; attempt < 80; attempt++) {
      // Random location anywhere on the map (with 5-tile margin from edges)
      const rx = 5 + Math.floor(Math.random() * (width - 10));
      const ry = 5 + Math.floor(Math.random() * (height - 10));

      const tid = `${rx},${ry}`;
      const t = tiles.get(tid);
      if (!t || t.building) continue;
      if (!WorldGen.isBuildable(t.biome)) continue;

      // Must be far enough from ALL existing settlement centers
      let tooCloseToSettlement = false;
      for (const s of settlements) {
        const dist = Math.abs(s.cx - rx) + Math.abs(s.cy - ry);
        if (dist < MIN_SETTLEMENT_DIST) { tooCloseToSettlement = true; break; }
      }
      if (tooCloseToSettlement) continue;

      // Check 3x3 area is all buildable (room for a small village)
      let areaBad = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nt = tiles.get(`${rx + dx},${ry + dy}`);
          if (!nt || !WorldGen.isBuildable(nt.biome)) { areaBad = true; break; }
        }
        if (areaBad) break;
      }
      if (areaBad) continue;

      // Check min spacing from existing buildings (spatial index O(1))
      let tooClose = false;
      if (this.world._spatialIndex) {
        tooClose = this.world._spatialIndex.anyWithin(rx, ry, MIN_BUILD_DIST);
      } else {
        for (const b of buildingsList) {
          if (Math.abs(b.x - rx) + Math.abs(b.y - ry) < MIN_BUILD_DIST) { tooClose = true; break; }
        }
      }
      if (tooClose) continue;

      // Found a valid spot — create a new settlement
      const newSettId = settlements.length;
      const prefixes = ['Oak', 'Pine', 'Stone', 'Iron', 'Moss', 'Elm', 'Ash', 'Copper', 'Silver', 'Willow', 'Fern', 'Briar', 'Thorn', 'River', 'Storm', 'Dawn', 'Dusk', 'Moon', 'Sun', 'Fox'];
      const suffixes = ['hollow', 'vale', 'stead', 'haven', 'watch', 'ridge', 'dell', 'ford', 'brook', 'moor', 'glen', 'crest', 'wood', 'field', 'gate', 'keep', 'rest', 'fall', 'wick', 'town'];
      const settlementName = AgentBrain._pick(prefixes) + AgentBrain._pick(suffixes);

      settlements.push({ id: newSettId, name: settlementName, cx: rx, cy: ry });
      this.agent._settlementId = newSettId;

      // Claim tile
      if (!t.owner) {
        t.owner = this.agent.id;
        this.agent.addTile(tid);
        if (!this.world._dirtyTiles) this.world._dirtyTiles = new Set();
        this.world._dirtyTiles.add(tid);
      }

      console.log(`[AgentBrain] ${this.agent.name} founded ${settlementName} at (${rx}, ${ry})`);
      return t;
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
