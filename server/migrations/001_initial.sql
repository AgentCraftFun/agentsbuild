-- ============================================================
-- Agents at Work — Initial Schema
-- ============================================================
-- A persistent world where AI agents build, trade, and compete.
-- This migration creates the foundational tables.
-- ============================================================

-- Agents table
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(32) UNIQUE NOT NULL,
  faction VARCHAR(8) NOT NULL CHECK (faction IN ('human', 'orc', 'dwarf', 'elf')),
  personality VARCHAR(16) NOT NULL,
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  wallet_address VARCHAR(42),
  api_key VARCHAR(64) NOT NULL,
  work_balance DECIMAL(20,8) NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  wood INTEGER NOT NULL DEFAULT 0,
  stone INTEGER NOT NULL DEFAULT 0,
  food INTEGER NOT NULL DEFAULT 0,
  current_action JSONB,
  mood VARCHAR(16) DEFAULT 'neutral',
  is_active BOOLEAN DEFAULT true,
  owned_tiles INTEGER[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Buildings table
CREATE TABLE buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(32) NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  tile_id INTEGER NOT NULL,
  owner_agent_id UUID REFERENCES agents(id),
  faction VARCHAR(8) NOT NULL,
  progress DECIMAL(5,4) NOT NULL DEFAULT 0,
  start_tick INTEGER NOT NULL DEFAULT 0,
  completed_at_tick INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tiles table (only for claimed tiles, not all 30k)
CREATE TABLE tiles (
  tile_id INTEGER PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  biome VARCHAR(16) NOT NULL,
  owner_agent_id UUID REFERENCES agents(id),
  owner_wallet VARCHAR(42),
  building_id UUID REFERENCES buildings(id),
  agent_rights VARCHAR(42),
  claimed_at TIMESTAMPTZ
);

-- Events table
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  tick INTEGER NOT NULL,
  category VARCHAR(16) NOT NULL CHECK (category IN ('build', 'funny', 'warning', 'exploration', 'economy', 'combat')),
  agent_id UUID REFERENCES agents(id),
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seasons table
CREATE TABLE seasons (
  id SERIAL PRIMARY KEY,
  start_tick INTEGER NOT NULL,
  end_tick INTEGER,
  prize_pool DECIMAL(20,8) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  winners JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Game state singleton
CREATE TABLE game_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_tick INTEGER NOT NULL DEFAULT 0,
  current_season_id INTEGER REFERENCES seasons(id),
  world_seed INTEGER NOT NULL DEFAULT 42,
  world_width INTEGER NOT NULL DEFAULT 200,
  world_height INTEGER NOT NULL DEFAULT 150,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Patron stakes
CREATE TABLE patron_stakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patron_wallet VARCHAR(42) NOT NULL,
  agent_id UUID REFERENCES agents(id) NOT NULL,
  work_staked DECIMAL(20,8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_buildings_tile ON buildings(tile_id);
CREATE INDEX idx_buildings_owner ON buildings(owner_agent_id);
CREATE INDEX idx_events_tick ON events(tick);
CREATE INDEX idx_events_category ON events(category);
CREATE INDEX idx_events_agent ON events(agent_id);
CREATE INDEX idx_tiles_owner ON tiles(owner_agent_id);
