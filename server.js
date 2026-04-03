/**
 * AgentCraft Server — Clean rebuild
 *
 * Single file. All simulation runs here. No browser APIs.
 * Clients connect via WebSocket and only render.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── CONFIG ───
const PORT = process.env.PORT || 3000;
const TICK_RATE = 3; // ticks per second
const SAVE_INTERVAL = 30000;
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve(__dirname);
const STATE_FILE = path.join(VOLUME, 'gamestate.json');
const WORLD_W = 200, WORLD_H = 150, SEED = 42;

console.log('=== AGENTCRAFT SERVER ===');
console.log('Port:', PORT);
console.log('State:', STATE_FILE);
console.log('Tick rate:', TICK_RATE, '/sec');

// ─── NOISE (deterministic terrain, matches client) ───
let _perm = null, _permSeed = null;
function initPerm(seed) {
  if (_permSeed === seed && _perm) return;
  _permSeed = seed;
  let s = seed;
  function rng() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }
  const p = Array.from({length:256}, (_,i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  _perm = new Array(512);
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255];
}
const G2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
function noise2D(x, y, seed) {
  initPerm(seed);
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = xf*xf*xf*(xf*(xf*6-15)+10), v = yf*yf*yf*(yf*(yf*6-15)+10);
  const aa=_perm[_perm[X]+Y], ab=_perm[_perm[X]+Y+1], ba=_perm[_perm[X+1]+Y], bb=_perm[_perm[X+1]+Y+1];
  const n00=G2[aa%8][0]*xf+G2[aa%8][1]*yf, n10=G2[ba%8][0]*(xf-1)+G2[ba%8][1]*yf;
  const n01=G2[ab%8][0]*xf+G2[ab%8][1]*(yf-1), n11=G2[bb%8][0]*(xf-1)+G2[bb%8][1]*(yf-1);
  return ((n00+(n10-n00)*u+((n01+(n11-n01)*u)-(n00+(n10-n00)*u))*v)+1)*0.5;
}
function fbm(x, y, oct, lac, gain, seed) {
  let val=0, amp=1, freq=1, max=0;
  for (let i=0;i<oct;i++) { val+=amp*noise2D(x*freq,y*freq,seed); max+=amp; amp*=gain; freq*=lac; }
  return val/max;
}

// ─── TERRAIN ───
function generateTerrain() {
  const tiles = new Map();
  for (let y=0; y<WORLD_H; y++) for (let x=0; x<WORLD_W; x++) {
    const n = fbm(x*0.02, y*0.02, 6, 2, 0.5, SEED);
    const rX = Math.floor(WORLD_W*0.45+Math.sin(y*0.08)*6);
    const rY = Math.floor(WORLD_H*0.55+Math.sin(x*0.06)*5);
    const isRiver = Math.abs(x-rX)<=1 || Math.abs(y-rY)<=1;
    let biome;
    if (isRiver) biome='river';
    else if (n<0.25) biome='deep_water'; else if (n<0.32) biome='shallow_water';
    else if (n<0.38) biome='sand'; else if (n<0.55) biome='grassland';
    else if (n<0.62) biome='forest'; else if (n<0.70) biome='dense_forest';
    else if (n<0.78) biome='hills'; else if (n<0.85) biome='mountain';
    else if (n<0.92) biome='snow'; else biome='gold_vein';
    tiles.set(`${x},${y}`, { x, y, biome });
  }
  console.log('Terrain generated:', tiles.size, 'tiles');
  return tiles;
}

const WATER = new Set(['deep_water','shallow_water','river']);
function isBuildable(tiles, x, y) {
  const t = tiles.get(`${x},${y}`);
  return t && !WATER.has(t.biome);
}

// ─── BUILDING TYPES ───
const BUILDINGS = {
  campfire:    { name:'Campfire',     cost:{wood:5,stone:0,gold:0},  era:0, ticks:5 },
  wood_hut:    { name:'Wood Hut',     cost:{wood:15,stone:0,gold:0}, era:0, ticks:10 },
  log_cabin:   { name:'Log Cabin',    cost:{wood:25,stone:0,gold:0}, era:0, ticks:15 },
  farm:        { name:'Farm',         cost:{wood:20,stone:0,gold:0}, era:0, ticks:10 },
  lumber_mill: { name:'Lumber Mill',  cost:{wood:30,stone:0,gold:0}, era:0, ticks:12 },
  stone_house: { name:'Stone House',  cost:{wood:5,stone:15,gold:0}, era:1, ticks:15 },
  blacksmith:  { name:'Blacksmith',   cost:{wood:5,stone:20,gold:0}, era:1, ticks:18 },
  watchtower:  { name:'Watchtower',   cost:{wood:5,stone:25,gold:0}, era:1, ticks:20 },
  town_hall:   { name:'Town Hall',    cost:{wood:10,stone:30,gold:20}, era:2, ticks:30 },
  church:      { name:'Church',       cost:{wood:5,stone:25,gold:10},  era:2, ticks:25 },
  market:      { name:'Market',       cost:{wood:5,stone:20,gold:15},  era:2, ticks:22 },
};

// ─── AGENT DEFINITIONS ───
const AGENT_DEFS = [
  { name:'Aldric',   faction:'human', personality:'analyst' },
  { name:'Bomrik',   faction:'dwarf', personality:'optimist' },
  { name:'Faelith',  faction:'elf',   personality:'confused' },
  { name:'Grimshaw', faction:'human', personality:'overachiever' },
  { name:'Grukk',    faction:'orc',   personality:'aggressive' },
  { name:'Sylara',   faction:'elf',   personality:'chaotic' },
  { name:'Thorin',   faction:'dwarf', personality:'grinder' },
  { name:'Zog',      faction:'orc',   personality:'lazy' },
];

// ─── CREATE NEW WORLD ───
function createNewWorld(tiles) {
  const agents = AGENT_DEFS.map(def => {
    let x, y;
    for (let i=0; i<500; i++) {
      x = Math.floor(Math.random()*WORLD_W);
      y = Math.floor(Math.random()*WORLD_H);
      const t = tiles.get(`${x},${y}`);
      if (t && (t.biome==='grassland'||t.biome==='forest')) break;
    }
    return {
      ...def, x, y, task:'idle', targetX:null, targetY:null,
      inv:{wood:0, stone:0, gold:0, food:5},
      energy:100, hunger:0, morale:80,
      cooldown:0, buildTarget:null,
    };
  });
  return {
    agents, buildings:[], settlements:[], animals:[],
    era:0, tick:0, events:[],
    resources:{wood:0, stone:0, gold:0, food:10},
  };
}

// ─── SAVE / LOAD ───
function saveState() {
  try {
    const data = JSON.stringify(GS);
    fs.writeFileSync(STATE_FILE, data);
    if (GS.tick % 30 === 0) console.log(`[Save] Tick:${GS.tick} Bld:${GS.buildings.length} Era:${GS.era}`);
  } catch(e) { console.error('Save failed:', e.message); }
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data && data.agents && data.agents.length > 0) {
      // Reject corrupted saves from old server
      if (data.buildings && data.buildings.length > 100) {
        console.log(`[Load] Rejecting corrupted save: ${data.buildings.length} buildings. Starting fresh.`);
        fs.unlinkSync(STATE_FILE);
        return null;
      }
      console.log(`[Load] Tick:${data.tick} Bld:${data.buildings.length} Agents:${data.agents.length}`);
      return data;
    }
  } catch(e) { console.error('Load failed:', e.message); }
  return null;
}

// ─── TERRAIN (generated once) ───
const TILES = generateTerrain();

// ─── GAME STATE ───
let GS = loadState() || createNewWorld(TILES);
if (!GS.resources) GS.resources = {wood:0,stone:0,gold:0,food:10};
if (!GS.settlements) GS.settlements = [];
if (!GS.events) GS.events = [];
console.log(GS.tick > 0 ? '=== RESUMED WORLD ===' : '=== NEW WORLD ===');
console.log('Agents:', GS.agents.map(a=>a.name).join(', '));
console.log('Buildings:', GS.buildings.length, '| Era:', GS.era);

// ─── SIMULATION ───

function findNearby(agent, biomes, radius) {
  for (let r=1; r<=radius; r++) {
    for (let dx=-r; dx<=r; dx++) for (let dy=-r; dy<=r; dy++) {
      if (Math.abs(dx)!==r && Math.abs(dy)!==r) continue;
      const t = TILES.get(`${agent.x+dx},${agent.y+dy}`);
      if (t && biomes.includes(t.biome)) return {x:t.x, y:t.y};
    }
  }
  return null;
}

function moveToward(agent, tx, ty, speed) {
  const dx=tx-agent.x, dy=ty-agent.y;
  const dist = Math.abs(dx)+Math.abs(dy);
  if (dist <= speed) { agent.x=tx; agent.y=ty; return true; }
  const sx = Math.sign(dx)*Math.min(Math.abs(dx),speed);
  const sy = Math.sign(dy)*Math.min(Math.abs(dy),speed);
  agent.x = Math.max(0, Math.min(WORLD_W-1, Math.round(agent.x+sx)));
  agent.y = Math.max(0, Math.min(WORLD_H-1, Math.round(agent.y+sy)));
  return false;
}

function getSpeed(agent) {
  let s = 0.8;
  if (agent.personality==='aggressive'||agent.personality==='chaotic') s*=1.3;
  if (agent.personality==='lazy') s*=0.5;
  if (agent.personality==='grinder'||agent.personality==='overachiever') s*=1.15;
  return s;
}

function findBuildSpot(agent) {
  // Prefer near existing buildings (settlement clustering)
  const blds = GS.buildings;
  let cx=agent.x, cy=agent.y;
  const nearby = blds.filter(b => Math.abs(b.x-agent.x)+Math.abs(b.y-agent.y)<20);
  if (nearby.length>=2) {
    cx = Math.round(nearby.reduce((s,b)=>s+b.x,0)/nearby.length);
    cy = Math.round(nearby.reduce((s,b)=>s+b.y,0)/nearby.length);
  }
  // Structured ring search
  for (let r=2; r<10; r++) {
    const startA = Math.random()*Math.PI*2;
    for (let i=0; i<12; i++) {
      const a = startA + i*Math.PI*2/12;
      const rx = Math.max(2, Math.min(WORLD_W-3, cx+Math.round(Math.cos(a)*r)));
      const ry = Math.max(2, Math.min(WORLD_H-3, cy+Math.round(Math.sin(a)*r)));
      if (!isBuildable(TILES, rx, ry)) continue;
      // Check footprint
      let ok = true;
      for (let dy=0; dy<=2&&ok; dy++) for (let dx=0; dx<=2&&ok; dx++) {
        if (!isBuildable(TILES, rx+dx, ry+dy)) ok=false;
      }
      if (!ok) continue;
      if (blds.some(b => Math.abs(b.x-rx)+Math.abs(b.y-ry)<4)) continue;
      return {x:rx, y:ry};
    }
  }
  return null;
}

function pickBuilding() {
  const r = GS.resources;
  const era = GS.era;
  const built = GS.buildings.map(b=>b.type);
  const counts = {};
  built.forEach(t => counts[t]=(counts[t]||0)+1);

  const avail = Object.entries(BUILDINGS).filter(([key,b]) => {
    if (b.era > era) return false;
    if (b.cost.wood > r.wood || b.cost.stone > r.stone || b.cost.gold > r.gold) return false;
    if ((counts[key]||0) >= 3) return false; // max 3 of any type
    return true;
  });
  if (avail.length===0) return null;
  // Prefer types not yet built
  const unbuilt = avail.filter(([k]) => !counts[k]);
  const pick = unbuilt.length>0 ? unbuilt : avail;
  const [key, def] = pick[Math.floor(Math.random()*pick.length)];
  return {key, ...def};
}

function pickTask(agent) {
  const r = GS.resources;
  const pers = agent.personality;

  // Priority 1: Eat if hungry
  if (agent.hunger > 60 && agent.inv.food > 0) {
    agent.inv.food--; agent.hunger = Math.max(0, agent.hunger-40);
    agent.cooldown = 3; return;
  }
  // Priority 2: Rest if exhausted
  if (agent.energy < 15) {
    agent.task='rest'; agent.cooldown=10; return;
  }
  // Priority 3: Gather wood if low
  if (r.wood < 20 || (r.wood < 50 && Math.random()<0.5)) {
    const tree = findNearby(agent, ['forest','dense_forest'], 15);
    if (tree) { agent.task='walk'; agent.targetX=tree.x; agent.targetY=tree.y; agent.nextTask='chop'; agent.nextTimer=5; return; }
  }
  // Priority 4: Mine stone if stone age+
  if (GS.era>=1 && r.stone<10) {
    const rock = findNearby(agent, ['hills','mountain'], 15);
    if (rock) { agent.task='walk'; agent.targetX=rock.x; agent.targetY=rock.y; agent.nextTask='mine'; agent.nextTimer=6; return; }
  }
  // Priority 5: Mine gold if gold age+
  if (GS.era>=2 && r.gold<5) {
    const g = findNearby(agent, ['gold_vein'], 20);
    if (g) { agent.task='walk'; agent.targetX=g.x; agent.targetY=g.y; agent.nextTask='mine_gold'; agent.nextTimer=8; return; }
  }
  // Priority 6: Build (personality-driven chance, rate limited)
  const buildChance = {overachiever:0.5, analyst:0.4, grinder:0.3, aggressive:0.2, lazy:0.05, chaotic:0.35, optimist:0.4, confused:0.15};
  if (Math.random() < (buildChance[pers]||0.3)) {
    const bld = pickBuilding();
    if (bld) {
      const spot = findBuildSpot(agent);
      if (spot) {
        r.wood -= bld.cost.wood; r.stone -= bld.cost.stone; r.gold -= bld.cost.gold;
        const b = { type:bld.key, name:bld.name, x:spot.x, y:spot.y, progress:0, complete:false,
                    builder:agent.name, ticks:bld.ticks, builderPresent:false,
                    faction:agent.faction, pw:56, ph:48, width:3, height:2, tall:false };
        GS.buildings.push(b);
        agent.task='walk'; agent.targetX=spot.x; agent.targetY=spot.y;
        agent.nextTask='build'; agent.buildTarget=b;
        GS.events.push({tick:GS.tick, msg:`${agent.name} started building ${bld.name}`});
        return;
      }
    }
  }
  // Priority 7: Claim / gather more wood
  const tree2 = findNearby(agent, ['forest','dense_forest'], 20);
  if (tree2) { agent.task='walk'; agent.targetX=tree2.x; agent.targetY=tree2.y; agent.nextTask='chop'; agent.nextTimer=5; return; }
  // Default: wander
  agent.task='walk';
  agent.targetX = Math.max(2, Math.min(WORLD_W-3, agent.x+Math.floor(Math.random()*11)-5));
  agent.targetY = Math.max(2, Math.min(WORLD_H-3, agent.y+Math.floor(Math.random()*11)-5));
  agent.nextTask='idle'; agent.nextTimer=0;
}

function tickAgent(agent) {
  const speed = getSpeed(agent);
  agent.hunger = Math.min(100, agent.hunger + 0.05);
  agent.energy = Math.max(0, agent.energy - 0.02);

  switch(agent.task) {
    case 'idle':
      agent.cooldown--;
      if (agent.cooldown > 0) break;
      if (agent.personality==='lazy' && Math.random()<0.3) { agent.cooldown=10; break; }
      pickTask(agent);
      break;
    case 'walk':
      if (moveToward(agent, agent.targetX, agent.targetY, speed)) {
        if (agent.nextTask==='build' && agent.buildTarget) {
          agent.task='build';
        } else {
          agent.task = agent.nextTask || 'idle';
          agent.cooldown = agent.nextTimer || 3;
          if (agent.task!=='idle') agent.cooldown = agent.nextTimer || 5;
        }
      }
      break;
    case 'chop':
      agent.cooldown--;
      if (agent.cooldown<=0) {
        GS.resources.wood += 5;
        GS.events.push({tick:GS.tick, msg:`${agent.name} chopped a tree (+5 wood)`});
        agent.task='idle'; agent.cooldown=2;
      }
      break;
    case 'mine':
      agent.cooldown--;
      if (agent.cooldown<=0) {
        GS.resources.stone += 3;
        GS.events.push({tick:GS.tick, msg:`${agent.name} mined stone (+3 stone)`});
        agent.task='idle'; agent.cooldown=2;
      }
      break;
    case 'mine_gold':
      agent.cooldown--;
      if (agent.cooldown<=0) {
        GS.resources.gold += 2;
        GS.events.push({tick:GS.tick, msg:`${agent.name} found gold (+2 gold)`});
        agent.task='idle'; agent.cooldown=2;
      }
      break;
    case 'build':
      const bt = agent.buildTarget;
      if (!bt || bt.complete) { agent.task='idle'; agent.cooldown=3; break; }
      const d = Math.abs(agent.x-bt.x)+Math.abs(agent.y-bt.y);
      if (d>3) { moveToward(agent, bt.x, bt.y, speed); }
      else { bt.builderPresent = true; }
      break;
    case 'rest':
      agent.energy = Math.min(100, agent.energy+5);
      agent.cooldown--;
      if (agent.cooldown<=0 || agent.energy>=80) { agent.task='idle'; agent.cooldown=2; }
      break;
    default:
      agent.task='idle'; agent.cooldown=3;
  }
}

function tickBuildings() {
  for (const b of GS.buildings) {
    if (!b.complete && b.builderPresent) {
      b.progress = Math.min(1, b.progress + 1.0/(b.ticks||15));
      if (b.progress >= 1) {
        b.complete = true; b.builderPresent = false;
        GS.events.push({tick:GS.tick, msg:`${b.builder} completed ${b.name}!`});
      }
    }
  }
}

function checkEra() {
  const complete = GS.buildings.filter(b=>b.complete).length;
  if (GS.era===0 && complete>=8) { GS.era=1; GS.events.push({tick:GS.tick, msg:'=== STONE AGE ==='}); }
  if (GS.era===1 && complete>=20) { GS.era=2; GS.events.push({tick:GS.tick, msg:'=== GOLD AGE ==='}); }
}

function formSettlements() {
  if (GS.tick % 30 !== 0) return;
  const blds = GS.buildings.filter(b=>b.complete && !b.settlement);
  for (const b of blds) {
    // Join nearby settlement
    let joined = false;
    for (const s of GS.settlements) {
      if (Math.abs(b.x-s.cx)+Math.abs(b.y-s.cy)<12) {
        b.settlement = s.name; joined=true; break;
      }
    }
    if (joined) continue;
    // Form new settlement
    const near = blds.filter(b2=>b2!==b && Math.abs(b2.x-b.x)+Math.abs(b2.y-b.y)<8);
    if (near.length>=1) {
      const pre=['Oak','Pine','Maple','Iron','Sun','Storm','Frost','Meadow','River','Hill','Stone'];
      const suf=['wood','dale','keep','haven','hollow','ridge',' Village',' Camp'];
      let name = pre[Math.floor(Math.random()*pre.length)]+suf[Math.floor(Math.random()*suf.length)];
      while(GS.settlements.find(s=>s.name===name)) name+=' II';
      GS.settlements.push({name, cx:b.x, cy:b.y});
      b.settlement=name;
      near.forEach(n=>n.settlement=name);
      GS.events.push({tick:GS.tick, msg:`🏘️ ${name} was founded!`});
    }
  }
}

// ─── GAME LOOP ───
function gameTick() {
  GS.tick++;
  for (const a of GS.agents) { try { tickAgent(a); } catch(e) { console.error(a.name, e.message); } }
  tickBuildings();
  checkEra();
  formSettlements();
  if (GS.events.length > 200) GS.events.splice(0, GS.events.length-200);

  if (GS.tick % 10 === 0) {
    const r = GS.resources;
    console.log(`[T${GS.tick}] W:${r.wood} S:${r.stone} G:${r.gold} | Bld:${GS.buildings.length} | ${GS.agents.map(a=>`${a.name}(${a.task})`).join(' ')}`);
  }
}

setInterval(gameTick, 1000/TICK_RATE);
setInterval(saveState, SAVE_INTERVAL);

// ─── HTTP + WEBSOCKET ───
const express = require('express');
const app = express();

// Serve landing page
app.use(express.static(path.resolve(__dirname, 'landing')));
// Serve viewer
app.use('/viewer', express.static(path.resolve(__dirname, 'viewer')));
// Health
app.get('/api/health', (req, res) => res.json({status:'ok', tick:GS.tick, buildings:GS.buildings.length, era:GS.era}));
// Fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/viewer')) {
    const f = path.resolve(__dirname, 'viewer', 'index.html');
    if (fs.existsSync(f)) return res.sendFile(f);
  }
  const landing = path.resolve(__dirname, 'landing', 'index.html');
  if (fs.existsSync(landing)) return res.sendFile(landing);
  res.json({msg:'AgentCraft server running', tick:GS.tick});
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`Listening on port ${PORT}`));
const wss = new WebSocketServer({server});

wss.on('connection', (ws) => {
  console.log(`[WS] Connected. Total: ${wss.clients.size}`);
  try { ws.send(JSON.stringify({type:'world_state', data:getClientState()})); } catch(e){}
  ws.on('close', () => console.log(`[WS] Disconnected. Total: ${wss.clients.size}`));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type==='ping') ws.send(JSON.stringify({type:'pong', tick:GS.tick}));
    } catch(e){}
  });
});

// Broadcast every tick
setInterval(() => {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify({type:'tick', data:getClientState()});
  wss.clients.forEach(ws => { if (ws.readyState===1) try{ws.send(msg)}catch(e){} });
}, 1000/TICK_RATE);

function getClientState() {
  return {
    tick: GS.tick,
    agents: GS.agents.map(a => ({
      id: a.name, name:a.name, faction:a.faction, personality:a.personality,
      x:a.x, y:a.y, mood:a.task, _state:a.task,
      current_action:{type:a.task},
      inv:a.inv, energy:a.energy, hunger:a.hunger, morale:a.morale,
    })),
    buildings: GS.buildings,
    settlements: GS.settlements,
    events: GS.events.slice(-50),
    resources: GS.resources,
    era: GS.era,
    leaderboard: GS.agents.map(a => ({
      id:a.name, name:a.name, faction:a.faction, personality:a.personality,
      territory:0, buildings:GS.buildings.filter(b=>b.builder===a.name&&b.complete).length,
      score: GS.buildings.filter(b=>b.builder===a.name&&b.complete).length * 25,
    })).sort((a,b)=>b.score-a.score),
    tiles: [], // client generates its own terrain
  };
}

// ─── SHUTDOWN ───
process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });

// Heartbeat
setInterval(() => {
  console.log(`[Heartbeat] Tick:${GS.tick} Bld:${GS.buildings.length} Era:${GS.era} Spectators:${wss.clients.size}`);
}, 60000);

console.log('Server started. World ready.');
