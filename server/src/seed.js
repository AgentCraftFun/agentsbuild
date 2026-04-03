/**
 * Seed script: creates 8 demo agents with starting positions and HQ buildings.
 * Can be run standalone or imported.
 */

const Agent = require('./models/Agent');
const Building = require('./models/Building');
const WorldGen = require('./services/WorldGen');

const DEMO_AGENTS = [
  { name: 'Grimshaw', faction: 'human', personality: 'overachiever' },
  { name: 'Aldric',   faction: 'human', personality: 'analyst' },
  { name: 'Zog',      faction: 'orc',   personality: 'lazy' },
  { name: 'Grukk',    faction: 'orc',   personality: 'aggressive' },
  { name: 'Thorin',   faction: 'dwarf', personality: 'grinder' },
  { name: 'Bomrik',   faction: 'dwarf', personality: 'optimist' },
  { name: 'Sylara',   faction: 'elf',   personality: 'chaotic' },
  { name: 'Faelith',  faction: 'elf',   personality: 'confused' },
];

/**
 * Seed the world state with demo agents.
 * @param {object} worldState - { tiles, agents, buildingsList, width, height, tick }
 * @returns {object} worldState with agents added
 */
function seedAgents(worldState) {
  const { tiles, width, height } = worldState;
  if (!worldState.agents) worldState.agents = new Map();
  if (!worldState.buildingsList) worldState.buildingsList = [];
  if (!worldState.events) worldState.events = [];

  // Find suitable grassland tiles spread across the map
  // Divide map into quadrants to spread agents out
  const regions = [
    { xMin: 10,              xMax: width * 0.4,   yMin: 10,               yMax: height * 0.4 },
    { xMin: width * 0.6,     xMax: width - 10,    yMin: 10,               yMax: height * 0.4 },
    { xMin: 10,              xMax: width * 0.4,   yMin: height * 0.6,     yMax: height - 10 },
    { xMin: width * 0.6,     xMax: width - 10,    yMin: height * 0.6,     yMax: height - 10 },
    { xMin: width * 0.25,    xMax: width * 0.45,  yMin: height * 0.25,    yMax: height * 0.45 },
    { xMin: width * 0.55,    xMax: width * 0.75,  yMin: height * 0.25,    yMax: height * 0.45 },
    { xMin: width * 0.25,    xMax: width * 0.45,  yMin: height * 0.55,    yMax: height * 0.75 },
    { xMin: width * 0.55,    xMax: width * 0.75,  yMin: height * 0.55,    yMax: height * 0.75 },
  ];

  // Use a deterministic RNG for seeding so results are repeatable
  let seedRng = 12345;
  function nextRng() {
    seedRng ^= seedRng << 13;
    seedRng ^= seedRng >> 17;
    seedRng ^= seedRng << 5;
    return (seedRng >>> 0) / 4294967296;
  }

  DEMO_AGENTS.forEach((def, index) => {
    const region = regions[index % regions.length];

    // Find a grassland tile in this region
    let startX, startY;
    let found = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const tx = Math.floor(region.xMin + nextRng() * (region.xMax - region.xMin));
      const ty = Math.floor(region.yMin + nextRng() * (region.yMax - region.yMin));
      const tile = tiles.get(`${tx},${ty}`);
      if (tile && tile.biome === 'grassland' && !tile.owner) {
        startX = tx;
        startY = ty;
        found = true;
        break;
      }
    }

    if (!found) {
      // Fallback: just pick any buildable unclaimed tile
      for (const tile of tiles.values()) {
        if (WorldGen.isBuildable(tile.biome) && !tile.owner) {
          startX = tile.x;
          startY = tile.y;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      startX = Math.floor(width / 2);
      startY = Math.floor(height / 2);
    }

    const agent = new Agent({
      name: def.name,
      faction: def.faction,
      personality: def.personality,
      x: startX,
      y: startY,
      work_balance: 0,
      resources: { food: 10, wood: 10, stone: 5, gold: 0 },
    });

    worldState.agents.set(agent.id, agent);

    // Claim the starting tile and its neighbors (3x3 area)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = startX + dx;
        const ty = startY + dy;
        const tileId = `${tx},${ty}`;
        const tile = tiles.get(tileId);
        if (tile && !tile.owner && WorldGen.isBuildable(tile.biome)) {
          tile.owner = agent.id;
          agent.addTile(tileId);
        }
      }
    }

    // First agent gets a starter community
    if (index === 0 && worldState.richBuildings) {
      const starterTypes = [
        { type:'campfire', name:'Campfire', abbr:'CF', w:2, h:1, pw:30, ph:20, tall:false, faction:'neutral' },
        { type:'wood_hut', name:'Wood Hut', abbr:'WH', w:3, h:2, pw:56, ph:48, tall:false, faction:'human' },
        { type:'wood_hut', name:'Wood Hut', abbr:'WH', w:3, h:2, pw:56, ph:48, tall:false, faction:'human' },
        { type:'log_cabin', name:'Log Cabin', abbr:'LC', w:3, h:3, pw:72, ph:56, tall:false, faction:'human' },
        { type:'farm', name:'Farm', abbr:'FA', w:3, h:2, pw:64, ph:40, tall:false, faction:'neutral' },
      ];
      const offsets = [[0,3],[3,0],[-3,1],[1,-3],[4,3]];
      for (let si = 0; si < starterTypes.length; si++) {
        const ox = startX + offsets[si][0], oy = startY + offsets[si][1];
        const t2 = tiles.get(`${ox},${oy}`);
        if (t2 && !['deep_water','shallow_water','river'].includes(t2.biome)) {
          worldState.richBuildings.push({
            ...starterTypes[si], x: ox, y: oy, progress: 1, complete: true,
            builder: def.name, settlement: 'Founders Camp', builderPresent: false,
          });
        }
      }
      if (!worldState.settlements) worldState.settlements = [];
      worldState.settlements.push({ name: 'Founders Camp', cx: startX, cy: startY, buildingCount: 5 });
      worldState.resources = { wood: 30, stone: 0, gold: 0, food: 20 };
      console.log(`[Seed] Starter community "Founders Camp" placed near ${def.name}`);
    }

    worldState.events.push({
      tick: 0,
      type: 'agent_spawned',
      agent: def.name,
      message: `${def.name} the ${def.faction} (${def.personality}) has entered the world at (${startX}, ${startY})!`,
    });

    console.log(`[Seed] ${def.name} (${def.faction}/${def.personality}) spawned at (${startX}, ${startY}) with ${agent.owned_tiles.length} tiles.`);
  });

  console.log(`[Seed] ${DEMO_AGENTS.length} demo agents created.`);
  return worldState;
}

// If run directly as a script, generate world and seed
if (require.main === module) {
  console.log('[Seed] Generating world...');
  const world = WorldGen.generate(200, 150, 42);
  const worldState = {
    tiles: world.tiles,
    width: world.width,
    height: world.height,
    seed: world.seed,
    tick: 0,
    agents: new Map(),
    buildingsList: [],
    events: [],
    leaderboard: [],
  };
  seedAgents(worldState);
  console.log('[Seed] Done. World state ready.');

  // Print summary
  let claimedCount = 0;
  for (const t of worldState.tiles.values()) {
    if (t.owner) claimedCount++;
  }
  console.log(`[Seed] ${claimedCount} tiles claimed, ${worldState.buildingsList.length} buildings placed.`);
}

module.exports = { seedAgents, DEMO_AGENTS };
