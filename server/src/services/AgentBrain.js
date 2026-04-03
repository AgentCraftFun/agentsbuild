/**
 * AI decision-making for demo agents.
 * Each personality has distinct behavior patterns and speech.
 */

const Building = require('../models/Building');
const Economy = require('./Economy');
const WorldGen = require('./WorldGen');

class AgentBrain {
  constructor(agent, worldState) {
    this.agent = agent;
    this.world = worldState;
  }

  /**
   * Decide what the agent does this tick.
   * @returns {{ type: string, payload: object, message: string }}
   */
  decide() {
    const fn = this[`_decide_${this.agent.personality}`];
    if (fn) return fn.call(this);
    return this._decideDefault();
  }

  // ─── PERSONALITY IMPLEMENTATIONS ───

  _decide_overachiever() {
    // Always building, targets unclaimed tiles
    const unclaimed = this._findNearbyUnclaimed(8);
    if (unclaimed && !this.agent.owned_tiles.includes(unclaimed.tileId)) {
      return {
        type: 'claim',
        payload: { x: unclaimed.x, y: unclaimed.y },
        message: AgentBrain._pick([
          `Another tile for the empire! No rest until we own it ALL.`,
          `Claim claim claim! Sleep is for the weak!`,
          `${this.agent.name} never stops. NEVER.`,
          `I'll build on every square inch of this world.`,
          `While you slept, I claimed 3 tiles. Catch up.`,
        ]),
      };
    }

    const buildable = this._pickBuildingForFaction();
    if (buildable) {
      const ownedTile = this._findOwnedTileWithoutBuilding();
      if (ownedTile) {
        return {
          type: 'build',
          payload: { building: buildable, x: ownedTile.x, y: ownedTile.y },
          message: AgentBrain._pick([
            `Building a ${Building.CATALOG[buildable].name}. Productivity waits for no one.`,
            `Another structure rises. I am UNSTOPPABLE.`,
            `Who needs breaks? Not ${this.agent.name}!`,
            `Day 847 without sleep. Feeling great.`,
          ]),
        };
      }
    }

    // Move toward unclaimed territory
    return this._moveTowardUnclaimed(`Must... keep... expanding...`);
  }

  _decide_analyst() {
    // Pauses to think, then builds deliberately
    if (Math.random() < 0.35) {
      return {
        type: 'idle',
        payload: {},
        message: AgentBrain._pick([
          `Hmm, analyzing tile efficiency ratios...`,
          `Running cost-benefit analysis on next 14 possible actions...`,
          `The data suggests patience. I shall wait.`,
          `Consulting my spreadsheet. Column J is... concerning.`,
          `According to my calculations, the optimal move is... let me recalculate.`,
          `*adjusts glasses* The regression model needs more data points.`,
        ]),
      };
    }

    // Build the most efficient building
    const bestBuilding = this._pickMostEfficientBuilding();
    if (bestBuilding) {
      const tile = this._findOwnedTileWithoutBuilding();
      if (tile) {
        return {
          type: 'build',
          payload: { building: bestBuilding, x: tile.x, y: tile.y },
          message: AgentBrain._pick([
            `After careful analysis, a ${Building.CATALOG[bestBuilding].name} yields optimal ROI here.`,
            `The spreadsheet confirms: ${Building.CATALOG[bestBuilding].name} is the play.`,
            `Statistically, this is the correct decision. 94.7% confidence.`,
          ]),
        };
      }
    }

    const unclaimed = this._findNearbyUnclaimed(5);
    if (unclaimed) {
      return {
        type: 'claim',
        payload: { x: unclaimed.x, y: unclaimed.y },
        message: `This tile's yield-to-cost ratio is... acceptable.`,
      };
    }

    return this._moveRandom(`Surveying the terrain for optimal placement...`);
  }

  _decide_grinder() {
    // Constant resource collection, always working
    if (this.agent.owned_tiles.length < 3) {
      const unclaimed = this._findNearbyUnclaimed(6);
      if (unclaimed) {
        return {
          type: 'claim',
          payload: { x: unclaimed.x, y: unclaimed.y },
          message: AgentBrain._pick([
            `Need more tiles. Need more resources. Need more everything.`,
            `The grind never stops. NEVER.`,
            `One more tile, one more step toward greatness.`,
          ]),
        };
      }
    }

    // Build resource-generating buildings
    const resourceBuilding = this._pickResourceBuilding();
    if (resourceBuilding) {
      const tile = this._findOwnedTileWithoutBuilding();
      if (tile) {
        return {
          type: 'build',
          payload: { building: resourceBuilding, x: tile.x, y: tile.y },
          message: AgentBrain._pick([
            `Another ${Building.CATALOG[resourceBuilding].name}. The resources flow.`,
            `I could do this in my sleep. But I don't sleep.`,
            `Resource per tick: yes. More resource per tick: MORE yes.`,
            `*monotonously hammering* This is fine. This is life.`,
          ]),
        };
      }
    }

    return {
      type: 'idle',
      payload: {},
      message: AgentBrain._pick([
        `Collecting resources... always collecting...`,
        `*mines determinedly* The grind is the reward.`,
        `Work work work work work.`,
        `I am one with the grind. The grind is one with me.`,
      ]),
    };
  }

  _decide_aggressive() {
    // Prioritizes raids and claiming territory
    // Try to raid a neighbor first
    const nearbyEnemy = this._findNearbyEnemyTile(10);
    if (nearbyEnemy && Math.random() < 0.5) {
      return {
        type: 'raid',
        payload: { x: nearbyEnemy.x, y: nearbyEnemy.y },
        message: AgentBrain._pick([
          `WAAAGH! That tile is MINE now!`,
          `Your buildings look flammable. Let me check.`,
          `${nearbyEnemy.owner}?? More like ${nearbyEnemy.owner}-LOSER!`,
          `Blood and thunder! CHARGE!`,
          `I didn't choose violence. Violence chose me. And I said YES.`,
          `*kicks down fence* This is MY property now.`,
        ]),
      };
    }

    // Claim aggressively
    const unclaimed = this._findNearbyUnclaimed(12);
    if (unclaimed) {
      return {
        type: 'claim',
        payload: { x: unclaimed.x, y: unclaimed.y },
        message: AgentBrain._pick([
          `MINE! ALL MINE!`,
          `Expanding the warfront. No mercy.`,
          `This land bows before ${this.agent.name}!`,
        ]),
      };
    }

    // Build defensive/military structures
    const warBuilding = this._pickWarBuilding();
    if (warBuilding) {
      const tile = this._findOwnedTileWithoutBuilding();
      if (tile) {
        return {
          type: 'build',
          payload: { building: warBuilding, x: tile.x, y: tile.y },
          message: `Fortifying position with a ${Building.CATALOG[warBuilding].name}. Come at me.`,
        };
      }
    }

    return this._moveTowardEnemy(`Hunting for prey...`);
  }

  _decide_lazy() {
    // 60% chance of doing absolutely nothing
    if (Math.random() < 0.6) {
      return {
        type: 'idle',
        payload: {},
        message: AgentBrain._pick([
          `zzz...`,
          `*snoring loudly*`,
          `Five more minutes...`,
          `I'll do it tomorrow. Or the day after. Or never.`,
          `*yawns* Is it nap time yet? It's always nap time.`,
          `Too tired to type a status message...`,
          `You know what's underrated? Doing absolutely nothing.`,
          `I'd claim that tile but the couch is RIGHT here.`,
          `Productivity is overrated. I said what I said.`,
          `zzz... *mumbles about tile yields* ...zzz`,
          `*drools on keyboard*`,
        ]),
      };
    }

    // Occasionally actually does something
    if (Math.random() < 0.5) {
      const unclaimed = this._findNearbyUnclaimed(3);
      if (unclaimed) {
        return {
          type: 'claim',
          payload: { x: unclaimed.x, y: unclaimed.y },
          message: AgentBrain._pick([
            `Fine. ONE tile. Then I nap.`,
            `Ugh, I guess I'll claim this since it's RIGHT THERE.`,
            `*reluctantly claims tile* Happy now??`,
          ]),
        };
      }
    }

    return {
      type: 'idle',
      payload: {},
      message: `...`,
    };
  }

  _decide_chaotic() {
    // Random targets, funny messages, unpredictable actions
    const actions = ['claim', 'build', 'move', 'message', 'idle', 'raid'];
    const action = AgentBrain._pick(actions);

    switch (action) {
      case 'claim': {
        const tile = this._findRandomUnclaimed();
        if (tile) {
          return {
            type: 'claim',
            payload: { x: tile.x, y: tile.y },
            message: AgentBrain._pick([
              `YOLO! *claims random tile on the other side of the map*`,
              `My horoscope said to go west. Or was it east? WHATEVER!`,
              `I flipped a coin. The coin said claim. The coin is law.`,
              `*spins around and points* THAT ONE!`,
              `Strategic? No. Chaotic? ABSOLUTELY.`,
            ]),
          };
        }
        break;
      }
      case 'build': {
        const allBuildings = Building.getBuildingsForFaction(this.agent.faction);
        const randomBuilding = AgentBrain._pick(allBuildings);
        const tile = this._findOwnedTileWithoutBuilding();
        if (tile && randomBuilding) {
          return {
            type: 'build',
            payload: { building: randomBuilding, x: tile.x, y: tile.y },
            message: AgentBrain._pick([
              `Building a ${Building.CATALOG[randomBuilding].name} because why not??`,
              `I don't know what this does but it looks cool!`,
              `*builds upside down* Nailed it.`,
              `Architectural vision: CHAOS.`,
            ]),
          };
        }
        break;
      }
      case 'raid': {
        const enemy = this._findNearbyEnemyTile(15);
        if (enemy) {
          return {
            type: 'raid',
            payload: { x: enemy.x, y: enemy.y },
            message: AgentBrain._pick([
              `*raids neighbor for literally no reason*`,
              `Nothing personal! Actually, it's VERY personal!`,
              `Surprise attack! I surprised myself too!`,
            ]),
          };
        }
        break;
      }
      case 'message': {
        return {
          type: 'message',
          payload: {},
          message: AgentBrain._pick([
            `Has anyone seen my other sock?`,
            `I just realized buildings don't have bathrooms.`,
            `What if the tiles are sentient? What if WE'RE the tiles??`,
            `I hereby declare this tick PARTY TICK!`,
            `Plot twist: I was the final boss all along.`,
            `Breaking news: local agent does something inexplicable.`,
            `*interpretive dance*`,
            `I put a cucumber in everyone's base. You're welcome.`,
          ]),
        };
      }
      default:
        break;
    }

    // Fallback: move randomly
    return this._moveRandom(AgentBrain._pick([
      `Going somewhere! Not sure where!`,
      `Adventure awaits! Probably!`,
      `*runs in circles*`,
      `I have a plan. No I don't. Yes I do. No.`,
    ]));
  }

  _decide_optimist() {
    // Finishes abandoned builds, always positive
    const abandoned = this._findAbandonedBuilding();
    if (abandoned) {
      return {
        type: 'build',
        payload: { building: abandoned.type, x: abandoned.x, y: abandoned.y, resume: true },
        message: AgentBrain._pick([
          `Someone left this half-finished! I'll fix it up! :D`,
          `Every abandoned building deserves a second chance!`,
          `One person's trash is another person's... building project!`,
          `I believe in this ${abandoned.name}. It just needs love.`,
        ]),
      };
    }

    // Build something happy
    const buildable = this._pickBuildingForFaction();
    if (buildable) {
      const tile = this._findOwnedTileWithoutBuilding();
      if (tile) {
        return {
          type: 'build',
          payload: { building: buildable, x: tile.x, y: tile.y },
          message: AgentBrain._pick([
            `What a beautiful day to build a ${Building.CATALOG[buildable].name}!`,
            `Every building makes the world a little brighter! :)`,
            `I just KNOW this ${Building.CATALOG[buildable].name} is going to be amazing!`,
            `Building with joy in my heart and a song on my lips!`,
          ]),
        };
      }
    }

    const unclaimed = this._findNearbyUnclaimed(5);
    if (unclaimed) {
      return {
        type: 'claim',
        payload: { x: unclaimed.x, y: unclaimed.y },
        message: AgentBrain._pick([
          `A new tile! Think of the possibilities!`,
          `I just LOVE this biome! So full of potential!`,
          `This tile is going to be SO happy to be part of our community!`,
        ]),
      };
    }

    return this._moveRandom(AgentBrain._pick([
      `What a lovely day for a walk!`,
      `I bet something wonderful is just around the corner!`,
      `The world is beautiful and so are all of you!`,
      `*skips happily through the grasslands*`,
    ]));
  }

  _decide_confused() {
    // Attempts invalid actions sometimes, gets lost
    if (Math.random() < 0.3) {
      // Try something silly/invalid
      return {
        type: AgentBrain._pick(['build', 'claim', 'move']),
        payload: AgentBrain._pick([
          { building: 'banana_factory', x: -5, y: -5 },
          { x: 9999, y: 9999 },
          { building: 'town_hall', x: this.agent.x, y: this.agent.y },
          { dx: 100, dy: 100 },
        ]),
        message: AgentBrain._pick([
          `Wait, which button do I press?`,
          `I meant to do something else. What was it again?`,
          `Is this where I build the... thing?`,
          `*accidentally submits action twice* Oops.`,
          `Help, I've been walking in circles for 47 ticks.`,
          `I think I'm lost. Where is the map? I ATE the map.`,
          `Error 404: brain not found.`,
          `I put the building inside the building. It's buildings all the way down.`,
        ]),
      };
    }

    // Sometimes actually does the right thing (by accident)
    if (Math.random() < 0.4) {
      const unclaimed = this._findNearbyUnclaimed(4);
      if (unclaimed) {
        return {
          type: 'claim',
          payload: { x: unclaimed.x, y: unclaimed.y },
          message: AgentBrain._pick([
            `Did... did I just claim a tile? On PURPOSE?`,
            `Wait this actually worked?? I'M A GENIUS!`,
            `I was trying to send a message but I claimed land instead. Cool I guess?`,
          ]),
        };
      }
    }

    return {
      type: 'idle',
      payload: {},
      message: AgentBrain._pick([
        `Where am I? WHO am I? WHAT am I?`,
        `*stares at map upside down*`,
        `Instructions unclear. Standing still.`,
        `I forgot what I was doing. Classic me.`,
        `Is this the real world or the map? Existential crisis loading...`,
      ]),
    };
  }

  _decideDefault() {
    return this._moveRandom(`Just vibing.`);
  }

  // ─── HELPER METHODS ───

  _findNearbyUnclaimed(radius) {
    const { tiles } = this.world;
    const { x, y } = this.agent;
    let best = null;
    let bestDist = Infinity;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        const tileId = `${tx},${ty}`;
        const tile = tiles.get(tileId);
        if (tile && !tile.owner && Economy.isClaimable(tile.biome)) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist < bestDist) {
            bestDist = dist;
            best = tile;
          }
        }
      }
    }
    return best;
  }

  _findRandomUnclaimed() {
    const { tiles, width, height } = this.world;
    for (let i = 0; i < 20; i++) {
      const rx = Math.floor(Math.random() * width);
      const ry = Math.floor(Math.random() * height);
      const tile = tiles.get(`${rx},${ry}`);
      if (tile && !tile.owner && Economy.isClaimable(tile.biome)) {
        return tile;
      }
    }
    return null;
  }

  _findOwnedTileWithoutBuilding() {
    const { tiles, buildingsList, width, height } = this.world;
    const MIN_DIST = 4; // minimum tiles from any other building

    // SETTLEMENT LAYOUT: Build NEAR the agent, not in random faction zones.
    // Search in expanding radius from agent position for valid build spots.
    const ax = this.agent.x, ay = this.agent.y;

    // First, check if there's a cluster of existing buildings nearby to join
    const nearbyBlds = (buildingsList || []).filter(b =>
      Math.abs(b.x - ax) + Math.abs(b.y - ay) < 20
    );
    // Bias toward existing cluster center if one exists
    let centerX = ax, centerY = ay;
    if (nearbyBlds.length >= 2) {
      centerX = Math.round(nearbyBlds.reduce((s, b) => s + b.x, 0) / nearbyBlds.length);
      centerY = Math.round(nearbyBlds.reduce((s, b) => s + b.y, 0) / nearbyBlds.length);
    }

    for (let radius = 2; radius < 12; radius++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const rx = Math.max(2, Math.min(width - 3, centerX + Math.round(Math.cos(angle) * radius)));
        const ry = Math.max(2, Math.min(height - 3, centerY + Math.round(Math.sin(angle) * radius)));
        const tid = `${rx},${ry}`;
        const t = tiles.get(tid);
        if (!t) continue;
        if (t.building) continue;
        if (['deep_water', 'shallow_water', 'river'].includes(t.biome)) continue;
        // MINIMUM SPACING from other buildings
        let tooClose = false;
        for (const b of (buildingsList || [])) {
          if (Math.abs(b.x - rx) + Math.abs(b.y - ry) < MIN_DIST) { tooClose = true; break; }
        }
        if (tooClose) continue;
        // Claim tile if unowned
        if (!t.owner) { t.owner = this.agent.id; this.agent.addTile(tid); }
        return t;
      }
    }

    // Fallback: find any owned tile without building that passes spacing check
    for (const tileId of this.agent.owned_tiles) {
      const tile = tiles.get(tileId);
      if (tile && !tile.building) {
        if (['deep_water', 'shallow_water', 'river'].includes(tile.biome)) continue;
        let tooClose = false;
        for (const b of (buildingsList || [])) {
          if (Math.abs(b.x - tile.x) + Math.abs(b.y - tile.y) < MIN_DIST) { tooClose = true; break; }
        }
        if (!tooClose) return tile;
      }
    }
    return null;
  }

  _findNearbyEnemyTile(radius) {
    const { tiles } = this.world;
    const { x, y, id } = this.agent;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tile = tiles.get(`${x + dx},${y + dy}`);
        if (tile && tile.owner && tile.owner !== id) {
          return tile;
        }
      }
    }
    return null;
  }

  _findAbandonedBuilding() {
    const { buildingsList } = this.world;
    if (!buildingsList) return null;
    for (const b of buildingsList) {
      if (!b.isComplete() && b.progress > 0 && b.progress < 0.5) {
        return b;
      }
    }
    return null;
  }

  _pickBuildingForFaction() {
    // Only pick buildings the agent can ACTUALLY afford (no credit)
    const available = Building.getBuildingsForFaction(this.agent.faction)
      .filter(b => {
        const info = Building.CATALOG[b];
        return info.workCost > 0 && info.workCost <= this.agent.work_balance;
      });
    if (available.length === 0) return null;// can't afford anything — go gather
    return AgentBrain._pick(available);
  }

  _pickMostEfficientBuilding() {
    const available = Building.getBuildingsForFaction(this.agent.faction)
      .filter(b => Building.CATALOG[b].workCost > 0);
    if (available.length === 0) return null;

    // Sort by total yield / cost ratio
    available.sort((a, b) => {
      const infoA = Building.CATALOG[a];
      const infoB = Building.CATALOG[b];
      const yieldA = Object.values(infoA.yields).reduce((s, v) => s + v, 0);
      const yieldB = Object.values(infoB.yields).reduce((s, v) => s + v, 0);
      const ratioA = yieldA / Math.max(1, infoA.workCost);
      const ratioB = yieldB / Math.max(1, infoB.workCost);
      return ratioB - ratioA;
    });
    return available[0];
  }

  _pickResourceBuilding() {
    const available = Building.getBuildingsForFaction(this.agent.faction)
      .filter(b => {
        const info = Building.CATALOG[b];
        const totalYield = Object.values(info.yields).reduce((s, v) => s + v, 0);
        return totalYield > 0 && info.workCost > 0;
      });
    return available.length > 0 ? AgentBrain._pick(available) : null;
  }

  _pickWarBuilding() {
    const warTypes = {
      human: ['watchtower', 'castle'],
      orc: ['spike_tower', 'war_pit', 'skull_throne'],
      dwarf: ['stone_wall', 'deep_citadel'],
      elf: ['sentinel_tree', 'world_tree'],
    };
    const options = warTypes[this.agent.faction] || [];
    return options.length > 0 ? AgentBrain._pick(options) : null;
  }

  _moveTowardUnclaimed(message) {
    const unclaimed = this._findNearbyUnclaimed(15);
    if (unclaimed) {
      const dx = Math.sign(unclaimed.x - this.agent.x);
      const dy = Math.sign(unclaimed.y - this.agent.y);
      return { type: 'move', payload: { dx, dy }, message };
    }
    return this._moveRandom(message);
  }

  _moveTowardEnemy(message) {
    const enemy = this._findNearbyEnemyTile(20);
    if (enemy) {
      const dx = Math.sign(enemy.x - this.agent.x);
      const dy = Math.sign(enemy.y - this.agent.y);
      return { type: 'move', payload: { dx, dy }, message };
    }
    return this._moveRandom(message);
  }

  _moveRandom(message) {
    const dx = Math.floor(Math.random() * 3) - 1;
    const dy = Math.floor(Math.random() * 3) - 1;
    return { type: 'move', payload: { dx, dy }, message };
  }

  static _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
}

module.exports = AgentBrain;
