/**
 * Agent data model for AI agents in the world.
 */

const { v4: uuidv4 } = require('uuid');

class Agent {
  static FACTIONS = ['human', 'orc', 'dwarf', 'elf'];
  static PERSONALITIES = [
    'overachiever', 'analyst', 'grinder', 'aggressive',
    'lazy', 'chaotic', 'optimist', 'confused',
  ];

  constructor({
    id = uuidv4(),
    name,
    faction,
    personality = 'analyst',
    x = 0,
    y = 0,
    wallet_address = `0x${uuidv4().replace(/-/g, '').slice(0, 40)}`,
    api_key = uuidv4(),
    work_balance = 0,
    resources = { food: 10, wood: 10, stone: 5, gold: 0 },
    current_action = null,
    mood = 'idle',
    owned_tiles = [],
    buildings = [],
    message = '',
    last_action_tick = 0,
    idle_ticks = 0,
    buffs = [],
    perks = {},
    equipment = {},
  }) {
    if (!Agent.FACTIONS.includes(faction)) {
      throw new Error(`Invalid faction: ${faction}. Must be one of: ${Agent.FACTIONS.join(', ')}`);
    }

    this.id = id;
    this.name = name;
    this.faction = faction;
    this.personality = personality;
    this.x = x;
    this.y = y;
    this.wallet_address = wallet_address;
    this.api_key = api_key;
    this.work_balance = work_balance;
    this.resources = { ...resources };
    this.current_action = current_action;
    this.mood = mood;
    this.owned_tiles = [...owned_tiles];
    this.buildings = [...buildings];
    this.message = message;
    this.last_action_tick = last_action_tick;
    this.idle_ticks = idle_ticks;
    this.action_queue = [];
    // Loot drops Phase 2:
    //   buffs — array of {type, expiresTick, meta?} for temporary effects
    //           (scroll_haste, potion_gather, potion_build)
    //   perks — object with permanent flags (golden_pickaxe, golden_axe)
    this.buffs = Array.isArray(buffs) ? [...buffs] : [];
    this.perks = perks && typeof perks === 'object' ? { ...perks } : {};
    // Phase 3: equipment slots — {weapon: 'sword'|'bow'|'spear'|null, armor: 'leather'|'iron'|'shield'|null}
    this.equipment = equipment && typeof equipment === 'object' ? { ...equipment } : {};
  }

  toJSON() {
    const data = {
      id: this.id,
      name: this.name,
      faction: this.faction,
      personality: this.personality,
      x: this.x,
      y: this.y,
      wallet_address: this.wallet_address,
      work_balance: parseFloat(this.work_balance.toFixed(4)),
      resources: { ...this.resources },
      current_action: this.current_action,
      mood: this.mood,
      owned_tiles: this.owned_tiles.length,
      buildings_count: this.buildings.length,
      message: this.message,
      buffs: Array.isArray(this.buffs) ? this.buffs.map(b => ({ type: b.type, expiresTick: b.expiresTick })) : [],
      perks: this.perks && typeof this.perks === 'object' ? { ...this.perks } : {},
      equipment: this.equipment && typeof this.equipment === 'object' ? { ...this.equipment } : {},
    };
    if (this._raidTarget) data._raidTarget = this._raidTarget;
    return data;
  }

  toPublicJSON() {
    const data = this.toJSON();
    delete data.api_key;
    return data;
  }

  move(dx, dy, worldWidth = 200, worldHeight = 150) {
    this.x = Math.max(0, Math.min(worldWidth - 1, this.x + dx));
    this.y = Math.max(0, Math.min(worldHeight - 1, this.y + dy));
  }

  addTile(tileId) {
    if (!this.owned_tiles.includes(tileId)) {
      this.owned_tiles.push(tileId);
    }
  }

  removeTile(tileId) {
    this.owned_tiles = this.owned_tiles.filter(t => t !== tileId);
  }

  canAfford(workCost) {
    return this.work_balance >= workCost;
  }

  spendWork(amount) {
    if (this.work_balance < amount) return false;
    this.work_balance -= amount;
    return true;
  }

  earnWork(amount) {
    this.work_balance += amount;
  }
}

module.exports = Agent;
