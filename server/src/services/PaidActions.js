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
 * Helper: push a "paid_action" credit banner event to the world feed.
 * This is what every viewer sees when someone pays for a chaos action.
 */
function pushCreditBanner(ctx, chaosType, emoji, extraLabel) {
  const shortAddr = ctx.from ? `${ctx.from.slice(0, 6)}...${ctx.from.slice(-4)}` : 'anonymous';
  const label = extraLabel || chaosType;
  const bannerMsg = `${emoji} ${shortAddr} paid ${ctx.amount} $AGENTCRAFT for a ${label}!`;
  if (ctx.worldState && Array.isArray(ctx.worldState.events)) {
    ctx.worldState.events.push({
      tick: ctx.tick,
      type: 'paid_action',
      actionType: chaosType,
      from: ctx.from,
      amount: ctx.amount,
      emoji,
      message: bannerMsg,
    });
  }
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
 * Special dispatch for the paid Lightning Storm action. Unlike the passive
 * single-strike lightning, this fires a dedicated storm method that strikes
 * 15 buildings at once in a dense area. Emits ONE "lightning_storm" event
 * containing all impact points so the viewer can play a massive animation.
 */
function dispatchLightningStorm(ctx, params) {
  if (!ctx.gameLoop || typeof ctx.gameLoop._chaosLightningStorm !== 'function') {
    throw new Error('gameLoop unavailable');
  }
  const result = ctx.gameLoop._chaosLightningStorm({ strikes: 15, radius: 20 });
  if (!result.ok) {
    throw new Error(result.reason || 'Failed to fire lightning storm');
  }

  // Push the storm event so the viewer can animate all strikes at once
  if (ctx.worldState && Array.isArray(ctx.worldState.events)) {
    ctx.worldState.events.push(result.event);
  }

  // Also push the credit banner
  const bannerMsg = pushCreditBanner(ctx, 'lightning', '⚡', 'Lightning Storm');

  return {
    chaosType: 'lightning_storm',
    buildingsStruck: result.impacts,
    epicenter: result.epicenter,
    event: {
      type: result.event.type,
      impactX: result.event.impactX,
      impactY: result.event.impactY,
      strikes: result.event.strikes,
      message: result.event.message,
    },
    message: bannerMsg,
  };
}

// ─── Action definitions ─────────────────────────────────────────────
const ACTIONS = {
  lightning: {
    price: PRICES.LIGHTNING,
    label: 'Lightning Storm',
    emoji: '⚡',
    description: '15 bolts of lightning strike a dense settlement area simultaneously, igniting every building they hit.',
    dispatch: dispatchLightningStorm,
  },
  wildfire: {
    price: PRICES.WILDFIRE,
    label: 'Wildfire',
    emoji: '🔥',
    description: 'Ignite a wildfire that will spread to nearby buildings over time.',
    dispatch: dispatchChaos('wildfire', '🔥'),
  },
  earthquake: {
    price: PRICES.EARTHQUAKE,
    label: 'Earthquake',
    emoji: '💥',
    description: 'A radial tremor collapses buildings in a 10-tile zone.',
    dispatch: dispatchChaos('earthquake', '💥'),
  },
  tornado: {
    price: PRICES.TORNADO,
    label: 'Tornado',
    emoji: '🌪️',
    description: 'A funnel cloud tears a linear path across the map, destroying everything it touches.',
    dispatch: dispatchChaos('tornado', '🌪️'),
  },
  meteor: {
    price: PRICES.METEOR,
    label: 'Meteor Strike',
    emoji: '☄️',
    description: 'A fireball from the sky ignites up to 6 buildings in a blast zone.',
    dispatch: dispatchChaos('meteor', '☄️'),
  },
  plague: {
    price: PRICES.PLAGUE,
    label: 'Plague',
    emoji: '☠️',
    description: 'Infect an entire settlement — 25% of its buildings rot away.',
    dispatch: dispatchChaos('plague', '☠️'),
  },
  volcano: {
    price: PRICES.VOLCANO,
    label: 'Volcanic Eruption',
    emoji: '🌋',
    description: 'Massive destruction. Instantly destroys the inner blast zone and ignites a wide outer ring.',
    dispatch: dispatchChaos('volcano', '🌋'),
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
