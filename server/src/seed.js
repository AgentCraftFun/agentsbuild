/**
 * Seed script: creates 8 demo agents across 8 spread-out settlements.
 * Each agent gets their own starting settlement to encourage map-wide spread.
 * Agents will organically found new villages as the game progresses.
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

// 8 settlement locations — spread across entire map, each agent gets their own
const SETTLEMENTS = [
  { cx: 0.20, cy: 0.20, name: 'Northvale' },     // top-left
  { cx: 0.80, cy: 0.18, name: 'Eastwatch' },      // top-right
  { cx: 0.50, cy: 0.30, name: 'Midfield' },       // top-center
  { cx: 0.15, cy: 0.55, name: 'Westhollow' },     // mid-left
  { cx: 0.85, cy: 0.55, name: 'Ironridge' },      // mid-right
  { cx: 0.35, cy: 0.75, name: 'Southmere' },      // bottom-left
  { cx: 0.65, cy: 0.80, name: 'Duskfen' },        // bottom-right
  { cx: 0.50, cy: 0.55, name: 'Hearthstone' },    // center
];

// Each agent gets their own settlement
const AGENT_SETTLEMENTS = [0, 1, 2, 3, 4, 5, 6, 7];

function seedAgents(worldState) {
  const { tiles, width, height } = worldState;
  if (!worldState.agents) worldState.agents = new Map();
  if (!worldState.buildingsList) worldState.buildingsList = [];
  if (!worldState.events) worldState.events = [];
  if (!worldState.settlements) worldState.settlements = [];

  // Deterministic RNG
  let seedRng = 12345;
  function nextRng() {
    seedRng ^= seedRng << 13;
    seedRng ^= seedRng >> 17;
    seedRng ^= seedRng << 5;
    return (seedRng >>> 0) / 4294967296;
  }

  // Find valid grassland tile near a target location
  function findGrassland(cx, cy, radius) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const angle = nextRng() * Math.PI * 2;
      const dist = nextRng() * radius;
      const tx = Math.round(cx + Math.cos(angle) * dist);
      const ty = Math.round(cy + Math.sin(angle) * dist);
      const tile = tiles.get(`${tx},${ty}`);
      if (tile && tile.biome === 'grassland' && !tile.owner) {
        return { x: tx, y: ty };
      }
    }
    return { x: cx, y: cy };
  }

  // Create settlement centers and place town halls
  const settlementCenters = SETTLEMENTS.map((s, si) => {
    const px = Math.floor(s.cx * width);
    const py = Math.floor(s.cy * height);
    const pos = findGrassland(px, py, 10);

    // Store settlement info for agents to reference
    const settlement = { id: si, name: s.name, cx: pos.x, cy: pos.y };
    worldState.settlements.push(settlement);

    // Place a town hall at the settlement center
    const hqType = 'town_hall';
    const hqTileId = `${pos.x},${pos.y}`;
    const hqTile = tiles.get(hqTileId);
    if (hqTile && !hqTile.building) {
      hqTile.owner = `settlement_${si}`;
      const hqBuilding = new Building({
        type: hqType, x: pos.x, y: pos.y,
        owner: `settlement_${si}`, progress: 1.0, startTick: 0,
      });
      hqTile.building = hqBuilding;
      worldState.buildingsList.push(hqBuilding);
    }

    console.log(`[Seed] Settlement "${s.name}" center at (${pos.x}, ${pos.y})`);
    return settlement;
  });

  // Spawn agents assigned to their settlements
  DEMO_AGENTS.forEach((def, index) => {
    const settlementIdx = AGENT_SETTLEMENTS[index];
    const settlement = settlementCenters[settlementIdx];

    // Spawn near settlement center
    const pos = findGrassland(settlement.cx, settlement.cy, 8);

    const agent = new Agent({
      name: def.name,
      faction: def.faction,
      personality: def.personality,
      x: pos.x,
      y: pos.y,
      work_balance: 0,
      resources: { food: 10, wood: 10, stone: 5, gold: 0 },
    });
    agent._settlementId = settlementIdx; // assign to settlement

    worldState.agents.set(agent.id, agent);

    // Claim 3x3 starting area
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = pos.x + dx;
        const ty = pos.y + dy;
        const tileId = `${tx},${ty}`;
        const tile = tiles.get(tileId);
        if (tile && !tile.owner && WorldGen.isBuildable(tile.biome)) {
          tile.owner = agent.id;
          agent.addTile(tileId);
        }
      }
    }

    worldState.events.push({
      tick: 0,
      type: 'agent_spawned',
      agent: def.name,
      message: `${def.name} the ${def.faction} (${def.personality}) joined ${settlement.name} at (${pos.x}, ${pos.y})!`,
    });

    console.log(`[Seed] ${def.name} (${def.faction}/${def.personality}) spawned at (${pos.x}, ${pos.y}) in ${settlement.name}`);
  });

  console.log(`[Seed] ${DEMO_AGENTS.length} demo agents in ${SETTLEMENTS.length} settlements.`);
  return worldState;
}

module.exports = { seedAgents, DEMO_AGENTS };
