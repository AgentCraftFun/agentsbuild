/**
 * ActionCatalog — the registry of paid actions players can trigger.
 *
 * Each action entry specifies:
 *   - price: required $AGENTCRAFT amount (human string, e.g. "100")
 *   - description: flavor text for UI
 *   - dispatch(ctx, params): fn called after payment verified
 *
 * `ctx` passed to dispatch contains:
 *   { worldState, gameLoop, from, txHash, amount, tick }
 *
 * dispatch should return a plain-JSON-friendly result object (included
 * in the API response and the registry record).
 *
 * Phase 1 ships with ONE placeholder action (`echo`) so the infrastructure
 * can be tested end-to-end. Phase 2 will add real chaos actions.
 */

const actions = {
  // Phase 1 placeholder: records the payment and returns an echo.
  // Use this to test the full payment flow without side effects.
  echo: {
    price: '1',  // 1 $AGENTCRAFT, cheapest possible for testing
    description: 'Test the payment flow without triggering any effect',
    dispatch: (ctx, params) => {
      return {
        echoed: true,
        message: 'Payment verified. No side effects applied.',
        paidBy: ctx.from,
        amount: ctx.amount,
        tick: ctx.tick,
      };
    },
  },
};

/**
 * Register a new action at runtime (used by Phase 2 to add chaos actions).
 */
function register(name, def) {
  if (!name || typeof name !== 'string') throw new Error('action name required');
  if (!def || typeof def.dispatch !== 'function') throw new Error('dispatch function required');
  if (!def.price) throw new Error('price required');
  actions[name.toLowerCase()] = def;
}

/**
 * Look up an action by name. Returns undefined if not found.
 */
function get(name) {
  if (!name || typeof name !== 'string') return undefined;
  return actions[name.toLowerCase()];
}

/**
 * List all actions (for UI / api introspection).
 */
function list() {
  return Object.entries(actions).map(([name, def]) => ({
    name,
    price: def.price,
    description: def.description || '',
  }));
}

module.exports = { register, get, list, _actions: actions };
