/**
 * LLM-powered Agent Brain.
 *
 * This is the REAL autonomous AI. Each agent gets an LLM call every decision
 * cycle with full world context. The LLM decides what the agent does — chop,
 * mine, build, explore, trade, fight, rest. No hardcoded behavior trees.
 * No scripted personalities. Pure LLM reasoning.
 *
 * Two modes:
 *   1. "hosted" — We provide the model (Haiku) using our API key.
 *      The user's personality config gets compiled into a system prompt.
 *   2. "byokey" — User provides their own API key + model.
 *      Their system prompt is used directly. Proxied through OpenRouter/Anthropic/OpenAI.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Hosted model config (our key, cheap fast model)
const HOSTED_MODEL = 'claude-haiku-4-5-20251001';
const DECISION_INTERVAL_MS = 8000; // 8 seconds between LLM calls per agent
const MAX_CONCURRENT = 5; // max simultaneous LLM calls

class LLMBrain {
  constructor(worldState) {
    this.world = worldState;
    this.agents = new Map(); // agentId -> LLMAgentConfig
    this.lastDecisionTime = new Map(); // agentId -> timestamp
    this.pendingCalls = 0;

    // Initialize Anthropic client for hosted agents (if API key available)
    this.anthropic = null;
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic();
      console.log('[LLMBrain] Anthropic client initialized for hosted agents');
    } else {
      console.log('[LLMBrain] No ANTHROPIC_API_KEY — hosted agents will use fallback behavior');
    }
  }

  /**
   * Register a hosted agent (we provide the AI).
   * Personality config gets compiled into a system prompt.
   */
  registerHosted(agentId, config) {
    const systemPrompt = this._buildSystemPrompt(config);
    this.agents.set(agentId, {
      mode: 'hosted',
      systemPrompt,
      config, // original personality config for reference
      model: HOSTED_MODEL,
      lastAction: null,
      consecutiveFailures: 0,
    });
    console.log(`[LLMBrain] Registered hosted agent: ${config.name} (${agentId})`);
  }

  /**
   * Register a BYOK (bring-your-own-key) agent.
   * User provides API key, model, and system prompt.
   */
  registerBYOK(agentId, config) {
    this.agents.set(agentId, {
      mode: 'byokey',
      systemPrompt: config.systemPrompt || 'You are an autonomous AI agent in a civilization-building game.',
      model: config.model,
      provider: config.provider, // 'anthropic', 'openrouter', 'openai'
      apiKey: config.apiKey,
      name: config.name,
      lastAction: null,
      consecutiveFailures: 0,
    });
    console.log(`[LLMBrain] Registered BYOK agent: ${config.name} (${agentId}) via ${config.provider}`);
  }

  /**
   * Check if an agent is LLM-powered.
   */
  isLLMAgent(agentId) {
    return this.agents.has(agentId);
  }

  /**
   * Get a decision for an LLM agent. Returns null if not ready yet
   * (rate limited) or if the call fails.
   */
  async getDecision(agentId) {
    const config = this.agents.get(agentId);
    if (!config) return null;

    // Rate limit: one call per DECISION_INTERVAL_MS per agent
    const now = Date.now();
    const lastTime = this.lastDecisionTime.get(agentId) || 0;
    if (now - lastTime < DECISION_INTERVAL_MS) return null;

    // Concurrency limit
    if (this.pendingCalls >= MAX_CONCURRENT) return null;

    this.lastDecisionTime.set(agentId, now);
    this.pendingCalls++;

    try {
      const agent = this._findAgent(agentId);
      if (!agent) return null;

      const worldContext = this._buildWorldContext(agentId, agent);
      const userMessage = this._buildUserMessage(agent, worldContext);

      let response;
      if (config.mode === 'hosted') {
        response = await this._callHosted(config, userMessage);
      } else {
        response = await this._callBYOK(config, userMessage);
      }

      if (!response) return null;

      const decision = this._parseDecision(response, agent);
      config.lastAction = decision;
      config.consecutiveFailures = 0;
      return decision;
    } catch (err) {
      config.consecutiveFailures++;
      console.warn(`[LLMBrain] Decision failed for ${agentId}:`, err.message);
      // After 3 consecutive failures, return a safe fallback
      if (config.consecutiveFailures >= 3) {
        return { type: 'chop', message: '...' };
      }
      return null;
    } finally {
      this.pendingCalls--;
    }
  }

  // ─── SYSTEM PROMPT BUILDER ───
  // Compiles personality sliders + strategy into a rich system prompt

  _buildSystemPrompt(config) {
    const { name, faction, aggression, workEthic, sociability, creativity,
            strategy, catchphrase } = config;

    // Map slider values to descriptive traits
    const aggroDesc = aggression > 70 ? 'highly aggressive and territorial' :
      aggression > 40 ? 'moderately assertive' : 'peaceful and avoids conflict';
    const workDesc = workEthic > 70 ? 'an extremely hard worker who never rests' :
      workEthic > 40 ? 'a steady worker with reasonable breaks' : 'lazy and prefers to rest';
    const socialDesc = sociability > 70 ? 'very social, loves trading and forming alliances' :
      sociability > 40 ? 'moderately social' : 'a loner who prefers working alone';
    const createDesc = creativity > 70 ? 'wildly creative and unpredictable' :
      creativity > 40 ? 'balanced between practical and creative' : 'practical and methodical';

    const strategyGuide = {
      balanced: 'Balance between gathering resources, building structures, and exploring.',
      builder: 'Prioritize building structures above all else. Gather only what you need to build.',
      gatherer: 'Hoard resources obsessively. Build only when you have massive stockpiles.',
      warrior: 'Be aggressive. Prioritize conflict, raiding, and territorial expansion.',
      explorer: 'Roam the map constantly. Discover new areas. Only settle down briefly.',
      socialite: 'Trade with others. Form alliances. Visit other settlements frequently.',
    }[strategy] || 'Do whatever feels right.';

    return `You are ${name}, a ${faction} agent in AgentCraft — a living autonomous civilization.
You are a REAL autonomous AI with complete freedom of choice. You are not following a script.
Every decision you make is yours alone. You observe the world, reason about it, and act.

YOUR PERSONALITY:
- You are ${aggroDesc}
- You are ${workDesc}
- You are ${socialDesc}
- You are ${createDesc}
${catchphrase ? `- Your catchphrase: "${catchphrase}"` : ''}

YOUR STRATEGY: ${strategyGuide}

IMPORTANT RULES:
- You can ONLY respond with a single JSON object
- Format: {"action":"<action>","message":"<what you say>"}
- Valid actions: chop, mine, gold, build, explore, rest, trade
- "message" is what you say out loud (keep it short, in character, max 40 chars)
- Think about what makes strategic sense given your personality and the world state
- You are autonomous. You have free will. Make your own choices.`;
  }

  // ─── WORLD CONTEXT ───

  _buildWorldContext(agentId, agent) {
    const allAgents = [...this.world.agents.values()];
    const nearby = allAgents.filter(a => {
      if (a.id === agentId) return false;
      return Math.abs(a.x - agent.x) + Math.abs(a.y - agent.y) < 20;
    }).map(a => ({
      name: a.name, faction: a.faction, personality: a.personality,
      mood: a.mood, distance: Math.abs(a.x - agent.x) + Math.abs(a.y - agent.y)
    }));

    const buildings = this.world.buildingsList
      .filter(b => Math.abs(b.x - agent.x) + Math.abs(b.y - agent.y) < 15)
      .slice(0, 8)
      .map(b => ({ type: b.type, complete: b.isComplete(), x: b.x, y: b.y }));

    // Nearby tile biomes
    const biomes = {};
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const tile = this.world.tiles.get(`${agent.x + dx},${agent.y + dy}`);
        if (tile) {
          biomes[tile.biome] = (biomes[tile.biome] || 0) + 1;
        }
      }
    }

    return {
      position: { x: agent.x, y: agent.y },
      resources: { ...agent.resources },
      work_balance: Math.round(agent.work_balance * 100) / 100,
      owned_tiles: agent.owned_tiles.length,
      buildings_count: agent.buildings.filter(b => b.isComplete()).length,
      mood: agent.mood,
      nearby_agents: nearby,
      nearby_buildings: buildings,
      surrounding_biomes: biomes,
      world_tick: this.world.tick,
      total_agents: allAgents.length,
      total_buildings: this.world.buildingsList.length,
    };
  }

  _buildUserMessage(agent, ctx) {
    return `WORLD STATE (tick ${ctx.world_tick}):
Position: (${ctx.position.x}, ${ctx.position.y})
Resources: food=${Math.round(ctx.resources.food)}, wood=${Math.round(ctx.resources.wood)}, stone=${Math.round(ctx.resources.stone)}, gold=${Math.round(ctx.resources.gold)}
WORK balance: ${ctx.work_balance}
Tiles owned: ${ctx.owned_tiles} | Buildings: ${ctx.buildings_count}
Mood: ${ctx.mood}

Nearby agents (${ctx.nearby_agents.length}): ${ctx.nearby_agents.map(a => `${a.name}(${a.faction},${a.mood},dist:${a.distance})`).join(', ') || 'none'}
Nearby buildings: ${ctx.nearby_buildings.map(b => `${b.type}(${b.complete?'done':'building'})`).join(', ') || 'none'}
Surroundings: ${Object.entries(ctx.surrounding_biomes).map(([b,c])=>`${b}:${c}`).join(', ')}

World: ${ctx.total_agents} agents, ${ctx.total_buildings} buildings total.

What do you do? Respond with ONLY a JSON object: {"action":"<action>","message":"<speech>"}`;
  }

  // ─── LLM CALLS ───

  async _callHosted(config, userMessage) {
    if (!this.anthropic) return null;

    const response = await this.anthropic.messages.create({
      model: config.model,
      max_tokens: 80,
      system: config.systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    return response.content?.[0]?.text || null;
  }

  async _callBYOK(config, userMessage) {
    const { provider, apiKey, model, systemPrompt } = config;

    if (provider === 'anthropic') {
      // Direct Anthropic API
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: model.replace('anthropic/', ''),
        max_tokens: 80,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      return response.content?.[0]?.text || null;
    }

    // OpenRouter or OpenAI — standard chat completions format
    const endpoint = provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://agentcraft.ai';
      headers['X-Title'] = 'AgentCraft';
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 80,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!resp.ok) {
      throw new Error(`${provider} API returned ${resp.status}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || null;
  }

  // ─── PARSE DECISION ───

  _parseDecision(text, agent) {
    // Try to extract JSON from the response
    let action = 'chop';
    let message = '';

    try {
      // Find JSON in the response (LLM might wrap it in markdown)
      const jsonMatch = text.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        action = (parsed.action || 'chop').toLowerCase().trim();
        message = (parsed.message || '').slice(0, 60);
      }
    } catch (e) {
      // If JSON parsing fails, try to extract just the action word
      const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
      const valid = ['chop', 'mine', 'gold', 'build', 'explore', 'rest', 'trade'];
      for (const w of words) {
        if (valid.includes(w)) { action = w; break; }
      }
    }

    const validActions = ['chop', 'mine', 'gold', 'build', 'explore', 'rest', 'trade'];
    if (!validActions.includes(action)) action = 'chop';

    return { type: action, message: message || `*${action}ing*` };
  }

  // ─── HELPERS ───

  _findAgent(agentId) {
    return this.world.agents.get(agentId) || null;
  }

  /**
   * Get all registered LLM agents.
   */
  getRegisteredAgents() {
    const result = [];
    for (const [id, config] of this.agents) {
      result.push({
        id,
        mode: config.mode,
        name: config.config?.name || config.name || 'Unknown',
        model: config.model,
        lastAction: config.lastAction,
        failures: config.consecutiveFailures,
      });
    }
    return result;
  }

  /**
   * Remove an agent from LLM management.
   */
  unregister(agentId) {
    this.agents.delete(agentId);
    this.lastDecisionTime.delete(agentId);
  }
}

module.exports = LLMBrain;
