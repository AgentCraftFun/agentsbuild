/**
 * PaidActions — the catalog of $AGENTCRAFT-funded chaos actions.
 *
 * Each action has:
 *   - name:        identifier used in /api/action body
 *   - price:       required $AGENTCRAFT amount (human string)
 *   - label:       display name for UI
 *   - description: short flavor text for UI
 *   - emoji:       icon for drama banner / UI
 *   - dispatch:    fn called after payment verification
 *
 * Dispatch functions receive (ctx, params) where ctx contains:
 *   { worldState, gameLoop, from, txHash, amount, tick }
 *
 * All chaos actions call `gameLoop.triggerChaosAction(type)` which:
 *   - Resets the cooldown for that event
 *   - Force-fires the chaos event (retries up to 10x)
 *   - Returns { ok, event, buildingsDestroyed, tick }
 *
 * The dispatch then builds a player-friendly result object and pushes
 * an extra "paid action" event into the world feed so the viewer can
 * display a drama banner crediting the payer.
 *
 * Phase 2 ships with all 7 chaos actions.
 */

// Price tiers (in $AGENTCRAFT with 18 decimals) — tuned for v1
// All amounts are human strings; the verifier parses them to BigInt wei.
// Minimum is 10M tokens (~$0.05-$0.10 at current price, adjusts with price action).
const PRICES = {
  LIGHTNING:  '10000000',   //  10M  — cheapest entry
  WILDFIRE:   '20000000',   //  20M
  EARTHQUAKE: '50000000',   //  50M
  TORNADO:    '100000000',  // 100M
  METEOR:     '200000000',  // 200M
  PLAGUE:     '300000000',  // 300M
  VOLCANO:    '500000000',  // 500M  — most dramatic
};

/**
 * Helper: push an event to BOTH the permanent world.events history AND
 * the pending broadcast queue so it goes out in the next tick's diff.
 * HTTP-triggered events (like paid actions) don't run inside the tick
 * loop, so they must be explicitly queued to be broadcast.
 */
function pushBroadcastEvent(worldState, ev) {
  if (!worldState) return;
  if (!Array.isArray(worldState.events)) worldState.events = [];
  if (!Array.isArray(worldState._pendingBroadcastEvents)) worldState._pendingBroadcastEvents = [];
  worldState.events.push(ev);
  worldState._pendingBroadcastEvents.push(ev);
}

/**
 * Helper: push a "paid_action" credit banner event to the world feed.
 * This is what every viewer sees when someone pays for a chaos action.
 */
function pushCreditBanner(ctx, chaosType, emoji, extraLabel) {
  const shortAddr = ctx.from ? `${ctx.from.slice(0, 6)}...${ctx.from.slice(-4)}` : 'anonymous';
  const label = extraLabel || chaosType;
  const bannerMsg = `${emoji} ${shortAddr} paid ${ctx.amount} $AGENTCRAFT for a ${label}!`;
  pushBroadcastEvent(ctx.worldState, {
    tick: ctx.tick,
    type: 'paid_action',
    actionType: chaosType,
    from: ctx.from,
    amount: ctx.amount,
    emoji,
    message: bannerMsg,
  });
  return bannerMsg;
}

/**
 * Shared dispatch helper for ambient-style chaos actions (tornado, meteor,
 * earthquake, etc). Fires one instance of the event via triggerChaosAction.
 */
function dispatchChaos(chaosType, emoji) {
  return function (ctx, params) {
    if (!ctx.gameLoop || typeof ctx.gameLoop.triggerChaosAction !== 'function') {
      throw new Error('gameLoop unavailable');
    }
    const result = ctx.gameLoop.triggerChaosAction(chaosType);
    if (!result.ok) {
      throw new Error(result.reason || `Failed to fire ${chaosType}`);
    }
    const bannerMsg = pushCreditBanner(ctx, chaosType, emoji);
    return {
      chaosType,
      buildingsDestroyed: result.buildingsDestroyed || 0,
      event: result.event
        ? { type: result.event.type, impactX: result.event.impactX, impactY: result.event.impactY, message: result.event.message }
        : null,
      message: bannerMsg,
    };
  };
}

/**
 * Generic dispatch factory for paid chaos actions.
 * Each paid action calls a dedicated method on GameLoop (e.g.
 * _chaosLightningStorm, _chaosWildfireStorm) which:
 *   - Accepts an `opts` object
 *   - Returns { ok, event, impacts, epicenter }
 *
 * The dispatch queues the event for broadcast, pushes the credit banner,
 * and returns a structured result for the API response.
 *
 * @param {string} methodName - GameLoop method to call (e.g. '_chaosLightningStorm')
 * @param {object} opts       - Options passed to the method
 * @param {string} chaosType  - Short name used in the credit banner (e.g. 'lightning')
 * @param {string} emoji      - Emoji for banners
 * @param {string} label      - Display label for banner (e.g. 'Lightning Storm')
 */
function makePaidChaosDispatch(methodName, opts, chaosType, emoji, label) {
  return function dispatch(ctx, params) {
    if (!ctx.gameLoop || typeof ctx.gameLoop[methodName] !== 'function') {
      throw new Error(`gameLoop.${methodName} unavailable`);
    }
    const result = ctx.gameLoop[methodName](opts || {});
    if (!result.ok) {
      throw new Error(result.reason || `Failed to fire ${chaosType}`);
    }

    // Queue the main storm/disaster event for broadcast
    pushBroadcastEvent(ctx.worldState, result.event);

    // Push the credit banner crediting the payer
    const bannerMsg = pushCreditBanner(ctx, chaosType, emoji, label);

    return {
      chaosType: result.event.type,
      impacts: result.impacts || 0,
      epicenter: result.epicenter,
      event: result.event,
      message: bannerMsg,
    };
  };
}

// Lightning Storm — retained as a named export for clarity
const dispatchLightningStorm = makePaidChaosDispatch(
  '_chaosLightningStorm',
  { strikes: 15, radius: 20 },
  'lightning', '⚡', 'Lightning Storm'
);

// ─── Action definitions ─────────────────────────────────────────────
// Every action fires a dedicated "paid" GameLoop method that emits ONE
// event with all impact points. The viewer plays a unified massive
// animation for each event type.
const ACTIONS = {
  lightning: {
    price: PRICES.LIGHTNING,
    label: 'Lightning Storm',
    emoji: '⚡',
    description: '15 bolts of lightning strike a dense area simultaneously, igniting every building they hit.',
    dispatch: dispatchLightningStorm,
  },
  wildfire: {
    price: PRICES.WILDFIRE,
    label: 'Wildfire Inferno',
    emoji: '🔥',
    description: '8 fires erupt across the land at once. The blazes spread and chain-react into an unstoppable inferno.',
    dispatch: makePaidChaosDispatch(
      '_chaosWildfireStorm', { ignitions: 8 },
      'wildfire', '🔥', 'Wildfire Inferno'
    ),
  },
  earthquake: {
    price: PRICES.EARTHQUAKE,
    label: 'Mega Earthquake',
    emoji: '💥',
    description: 'A massive 15-tile tremor collapses up to 20 buildings at once. Nothing in the inner ring survives.',
    dispatch: makePaidChaosDispatch(
      '_chaosMegaEarthquake', { radius: 15, maxCollapse: 20 },
      'earthquake', '💥', 'Mega Earthquake'
    ),
  },
  tornado: {
    price: PRICES.TORNADO,
    label: 'Tornado Swarm',
    emoji: '🌪️',
    description: '3 tornadoes spawn from different edges and converge through the map, destroying up to 45 buildings.',
    dispatch: makePaidChaosDispatch(
      '_chaosTornadoSwarm', { count: 3 },
      'tornado', '🌪️', 'Tornado Swarm'
    ),
  },
  meteor: {
    price: PRICES.METEOR,
    label: 'Meteor Shower',
    emoji: '☄️',
    description: '5 meteors rain from the sky in a 25-tile area, igniting dozens of buildings across multiple blast zones.',
    dispatch: makePaidChaosDispatch(
      '_chaosMeteorShower', { count: 5, radius: 25 },
      'meteor', '☄️', 'Meteor Shower'
    ),
  },
  plague: {
    price: PRICES.PLAGUE,
    label: 'Plague Wave',
    emoji: '☠️',
    description: 'A devastating plague strikes the 3 largest settlements simultaneously. 50% of buildings in each rot away.',
    dispatch: makePaidChaosDispatch(
      '_chaosPlagueWave', { targetCount: 3 },
      'plague', '☠️', 'Plague Wave'
    ),
  },
  volcano: {
    price: PRICES.VOLCANO,
    label: 'Volcanic Eruption',
    emoji: '🌋',
    description: 'CATACLYSMIC. A volcano erupts in the densest settlement. 25-tile radius: inner zone vaporized, outer ring engulfed in lava.',
    dispatch: makePaidChaosDispatch(
      '_chaosVolcanicEruption', { radius: 25 },
      'volcano', '🌋', 'Volcanic Eruption'
    ),
  },
};

/**
 * Register a subset of paid actions into an ActionCatalog instance.
 * Pass a list of action names to register (or omit to register all).
 * Call this once at server startup, after ActionCatalog is loaded.
 */
function register(catalog, names) {
  const toRegister = names && names.length > 0
    ? names.filter(n => ACTIONS[n])
    : Object.keys(ACTIONS);
  for (const name of toRegister) {
    catalog.register(name, ACTIONS[name]);
  }
  return toRegister;
}

/**
 * Register every paid action.
 */
function registerAll(catalog) {
  return register(catalog);
}

module.exports = { ACTIONS, PRICES, register, registerAll };
