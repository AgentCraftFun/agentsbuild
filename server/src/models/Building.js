/**
 * Building data model with full catalog of 24 buildings across 4 factions.
 */

class Building {
  static CATALOG = {
    // === HUMAN BUILDINGS ===
    town_hall:        { faction: 'human', name: 'Town Hall',        width: 2, height: 2, tall: true,  workCost: 0,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Faction HQ' },
    farmstead:        { faction: 'human', name: 'Farmstead',        width: 2, height: 1, tall: false, workCost: 5,   tier: 1, yields: { food: 3, wood: 0, stone: 0, gold: 0 }, description: 'Produces food' },
    lumber_mill:      { faction: 'human', name: 'Lumber Mill',      width: 2, height: 1, tall: true,  workCost: 5,   tier: 1, yields: { food: 0, wood: 3, stone: 0, gold: 0 }, description: 'Produces wood' },
    watchtower:       { faction: 'human', name: 'Watchtower',       width: 2, height: 2, tall: true,  workCost: 8,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Defends territory' },
    chapel:           { faction: 'human', name: 'Chapel',           width: 2, height: 2, tall: true,  workCost: 20,  tier: 2, yields: { food: 0, wood: 0, stone: 0, gold: 2 }, description: 'Generates faith and gold' },
    castle:           { faction: 'human', name: 'Castle',           width: 3, height: 3, tall: true,  workCost: 80,  tier: 3, yields: { food: 0, wood: 0, stone: 0, gold: 5 }, description: 'Ultimate fortress' },

    // === ORC BUILDINGS ===
    great_hall:       { faction: 'orc',   name: 'Great Hall',       width: 2, height: 2, tall: true,  workCost: 0,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Faction HQ' },
    pig_farm:         { faction: 'orc',   name: 'Pig Farm',         width: 2, height: 1, tall: false, workCost: 5,   tier: 1, yields: { food: 4, wood: 0, stone: 0, gold: 0 }, description: 'Orcs gotta eat' },
    war_pit:          { faction: 'orc',   name: 'War Pit',          width: 2, height: 2, tall: false, workCost: 8,   tier: 1, yields: { food: 0, wood: 0, stone: 1, gold: 0 }, description: 'Trains warriors' },
    spike_tower:      { faction: 'orc',   name: 'Spike Tower',      width: 1, height: 1, tall: true,  workCost: 6,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Pointy defense' },
    blood_forge:      { faction: 'orc',   name: 'Blood Forge',      width: 2, height: 2, tall: true,  workCost: 22,  tier: 2, yields: { food: 0, wood: 0, stone: 3, gold: 1 }, description: 'Weapons factory' },
    skull_throne:     { faction: 'orc',   name: 'Skull Throne',     width: 3, height: 3, tall: true,  workCost: 85,  tier: 3, yields: { food: 0, wood: 0, stone: 2, gold: 6 }, description: 'The Warchief sits here' },

    // === DWARF BUILDINGS ===
    mountain_hold:    { faction: 'dwarf', name: 'Mountain Hold',    width: 2, height: 2, tall: true,  workCost: 0,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Faction HQ' },
    mine_shaft:       { faction: 'dwarf', name: 'Mine Shaft',       width: 1, height: 1, tall: false, workCost: 5,   tier: 1, yields: { food: 0, wood: 0, stone: 4, gold: 1 }, description: 'Digs deep' },
    brewery:          { faction: 'dwarf', name: 'Brewery',          width: 2, height: 1, tall: true,  workCost: 7,   tier: 1, yields: { food: 2, wood: 0, stone: 0, gold: 1 }, description: 'Liquid courage' },
    stone_wall:       { faction: 'dwarf', name: 'Stone Wall',       width: 1, height: 1, tall: false, workCost: 4,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Solid defense' },
    runeforge:        { faction: 'dwarf', name: 'Runeforge',        width: 2, height: 2, tall: true,  workCost: 25,  tier: 2, yields: { food: 0, wood: 0, stone: 2, gold: 3 }, description: 'Enchants gear' },
    deep_citadel:     { faction: 'dwarf', name: 'Deep Citadel',     width: 3, height: 3, tall: true,  workCost: 90,  tier: 3, yields: { food: 0, wood: 0, stone: 5, gold: 7 }, description: 'Underground fortress' },

    // === ELF BUILDINGS ===
    tree_palace:      { faction: 'elf',   name: 'Tree Palace',      width: 2, height: 2, tall: true,  workCost: 0,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Faction HQ' },
    moonwell:         { faction: 'elf',   name: 'Moonwell',         width: 1, height: 1, tall: false, workCost: 6,   tier: 1, yields: { food: 1, wood: 1, stone: 0, gold: 1 }, description: 'Magical spring' },
    grove:            { faction: 'elf',   name: 'Ancient Grove',    width: 2, height: 2, tall: true,  workCost: 7,   tier: 1, yields: { food: 2, wood: 3, stone: 0, gold: 0 }, description: 'Living lumber' },
    sentinel_tree:    { faction: 'elf',   name: 'Sentinel Tree',    width: 1, height: 1, tall: true,  workCost: 6,   tier: 1, yields: { food: 0, wood: 0, stone: 0, gold: 0 }, description: 'Watchful guardian' },
    starforge:        { faction: 'elf',   name: 'Starforge',        width: 2, height: 2, tall: true,  workCost: 24,  tier: 2, yields: { food: 0, wood: 0, stone: 0, gold: 4 }, description: 'Celestial crafting' },
    world_tree:       { faction: 'elf',   name: 'World Tree',       width: 3, height: 3, tall: true,  workCost: 100, tier: 3, yields: { food: 3, wood: 5, stone: 0, gold: 8 }, description: 'The great tree awakens' },

    // === SHARED VILLAGE BUILDINGS ===
    market:           { faction: 'human', name: 'Market',           width: 2, height: 2, tall: false, workCost: 15,  tier: 2, yields: { food: 1, wood: 0, stone: 0, gold: 3 }, description: 'Trade hub' },
    apartment:        { faction: 'human', name: 'Apartment',        width: 2, height: 3, tall: true,  workCost: 30,  tier: 2, yields: { food: 0, wood: 0, stone: 0, gold: 2 }, description: 'Dense housing' },
    tavern:           { faction: 'human', name: 'Tavern',           width: 2, height: 2, tall: true,  workCost: 12,  tier: 1, yields: { food: 2, wood: 0, stone: 0, gold: 2 }, description: 'Drink and be merry' },
    granary:          { faction: 'human', name: 'Granary',          width: 2, height: 2, tall: false, workCost: 10,  tier: 1, yields: { food: 4, wood: 0, stone: 0, gold: 0 }, description: 'Food storage' },
    blacksmith:       { faction: 'dwarf', name: 'Blacksmith',       width: 2, height: 2, tall: true,  workCost: 18,  tier: 2, yields: { food: 0, wood: 0, stone: 2, gold: 2 }, description: 'Forge of creation' },
    library:          { faction: 'elf',   name: 'Library',          width: 2, height: 2, tall: true,  workCost: 20,  tier: 2, yields: { food: 0, wood: 0, stone: 0, gold: 3 }, description: 'Knowledge is power' },
  };

  constructor({ type, x, y, owner, progress = 0, startTick = 0, burning = false, hp = 1.0 }) {
    const info = Building.CATALOG[type];
    if (!info) throw new Error(`Unknown building type: ${type}`);

    this.type = type;
    this.x = x;
    this.y = y;
    this.owner = owner;
    this.progress = progress;
    this.startTick = startTick;
    this.name = info.name;
    this.faction = info.faction;
    this.width = info.width;
    this.height = info.height;
    this.tall = info.tall;
    this.tier = info.tier;
    this.workCost = info.workCost;
    this.yields = { ...info.yields };
    this.burning = burning;
    this.hp = hp; // 1.0 = full health, 0 = destroyed
  }

  isComplete() {
    return this.progress >= 1.0;
  }

  /**
   * Advance build progress per tick. Higher tiers take longer.
   * Tier 1: 3 ticks, Tier 2: 8 ticks, Tier 3: 20 ticks
   */
  advanceProgress(tickDelta = 1) {
    if (this.isComplete()) return;
    const ticksToComplete = this.tier === 1 ? 10 : this.tier === 2 ? 25 : 50;
    const rate = 1.0 / ticksToComplete;
    this.progress = Math.min(1.0, this.progress + rate * tickDelta);
  }

  toJSON() {
    return {
      type: this.type,
      name: this.name,
      x: this.x,
      y: this.y,
      owner: this.owner,
      progress: this.progress,
      startTick: this.startTick,
      faction: this.faction,
      width: this.width,
      height: this.height,
      tall: this.tall,
      tier: this.tier,
      workCost: this.workCost,
      yields: this.yields,
      complete: this.isComplete(),
      burning: this.burning || false,
      hp: this.hp != null ? this.hp : 1.0,
    };
  }

  static getHQ(faction) {
    const hqMap = {
      human: 'town_hall',
      orc: 'great_hall',
      dwarf: 'mountain_hold',
      elf: 'tree_palace',
    };
    return hqMap[faction] || 'town_hall';
  }

  static getBuildingsForFaction(faction) {
    return Object.entries(Building.CATALOG)
      .filter(([, info]) => info.faction === faction)
      .map(([key]) => key);
  }
}

module.exports = Building;
