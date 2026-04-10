/**
 * TxVerifier — verifies on-chain $AGENTCRAFT payments on Base.
 *
 * Given a transaction hash, confirms:
 *  - The tx is a valid, confirmed (status=success) transaction on Base
 *  - It contains an ERC-20 `Transfer` event from the $AGENTCRAFT contract
 *  - The recipient is the configured treasury address
 *  - The total transferred amount meets or exceeds the required amount
 *
 * All RPC calls go through viem's public client. Client code NEVER talks to
 * the RPC directly — only this server-side module does.
 *
 * Returns a normalized result object:
 *   { ok: true,  from, amount, amountBigInt, blockNumber, txHash }
 *   { ok: false, reason: "string explanation" }
 *
 * The `amount` is returned as a human-readable string (e.g. "500.0")
 * and `amountBigInt` is the raw BigInt (wei) for exact comparisons.
 */

const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');

// ─── Configuration (env-driven with sensible defaults) ──────────────
const AGENTCRAFT_TOKEN = (process.env.AGENTCRAFT_TOKEN_ADDRESS || '0x506059317F8dB90880a60a6968153AD2424ac38F').toLowerCase();
const TREASURY_ADDRESS = (process.env.TREASURY_ADDRESS || '0x25718402087CCd96f5CB980Fc6Ec399c5eA4e82e').toLowerCase();
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const TOKEN_DECIMALS = 18;  // confirmed on-chain: decimals() returned 0x12

// Keccak256 of "Transfer(address,address,uint256)"
// This is the event topic0 we're looking for in the tx logs.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ─── viem client (created lazily, reused across requests) ───────────
let _client = null;
function getClient() {
  if (!_client) {
    _client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, { timeout: 15_000, retryCount: 2 }),
    });
  }
  return _client;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a 0x-prefixed address string to lowercase for comparison.
 * A raw event `topic` is a 32-byte word (64 hex chars) — addresses are
 * the last 20 bytes, so we slice off the leading zero-pad.
 */
function topicToAddress(topic) {
  if (!topic || typeof topic !== 'string') return null;
  // topic is 0x + 64 hex chars. address = last 40 chars
  if (topic.length !== 66) return null;
  return ('0x' + topic.slice(26)).toLowerCase();
}

/**
 * Decode a uint256 data field (0x-prefixed, 64 hex chars) into a BigInt.
 */
function decodeUint256(hex) {
  if (!hex || typeof hex !== 'string') return 0n;
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return 0n;
  return BigInt('0x' + cleaned);
}

/**
 * Validate that a string looks like a 0x-prefixed 32-byte tx hash.
 */
function isValidTxHash(hash) {
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash);
}

/**
 * Format a BigInt token amount (18 decimals) as a human string.
 * Not math-critical — just for display / logging.
 */
function formatAmount(raw) {
  if (raw == null) return '0';
  const big = typeof raw === 'bigint' ? raw : BigInt(raw);
  const divisor = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = big / divisor;
  const frac = big % divisor;
  if (frac === 0n) return whole.toString();
  // Trim trailing zeros on fractional part
  let fracStr = frac.toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Parse a human string amount like "500" or "500.5" into a raw BigInt (wei).
 */
function parseAmount(str) {
  if (str == null) return 0n;
  const s = String(str).trim();
  if (s === '') return 0n;
  if (!/^\d+(\.\d*)?$/.test(s)) throw new Error(`Invalid amount string: ${str}`);
  const [whole, frac = ''] = s.split('.');
  const wholeBig = BigInt(whole) * (10n ** BigInt(TOKEN_DECIMALS));
  const fracPadded = frac.padEnd(TOKEN_DECIMALS, '0').slice(0, TOKEN_DECIMALS);
  return wholeBig + BigInt(fracPadded);
}

// ─── Main verification function ─────────────────────────────────────

/**
 * Verify a transaction hash represents a valid $AGENTCRAFT payment to treasury.
 *
 * @param {string} txHash - The transaction hash to verify
 * @param {bigint|string|number} requiredAmount - Minimum amount (raw BigInt or human string)
 * @returns {Promise<Object>} result object
 */
async function verifyPayment(txHash, requiredAmount) {
  // ── 1. Basic format validation ──
  if (!isValidTxHash(txHash)) {
    return { ok: false, reason: 'Invalid transaction hash format' };
  }

  // Normalize required amount to BigInt
  let requiredBig;
  try {
    if (typeof requiredAmount === 'bigint') requiredBig = requiredAmount;
    else if (typeof requiredAmount === 'string') requiredBig = parseAmount(requiredAmount);
    else if (typeof requiredAmount === 'number') requiredBig = parseAmount(requiredAmount.toString());
    else return { ok: false, reason: 'Invalid required amount' };
  } catch (e) {
    return { ok: false, reason: `Invalid required amount: ${e.message}` };
  }

  // ── 2. Fetch the transaction receipt ──
  let receipt;
  try {
    receipt = await getClient().getTransactionReceipt({ hash: txHash });
  } catch (err) {
    // viem throws TransactionReceiptNotFoundError if tx doesn't exist / unconfirmed.
    // Everything else (HTTP errors, timeouts, 5xx, DNS) is a transient RPC failure
    // and should be retryable by the user — we mark it with `transient: true` so
    // the endpoint returns 502 instead of 402.
    const msg = err.shortMessage || err.message || String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('not found') || lower.includes('could not be found')) {
      return { ok: false, reason: 'Transaction not found or not yet confirmed' };
    }
    return { ok: false, transient: true, reason: `RPC error: ${msg}` };
  }

  if (!receipt) {
    return { ok: false, reason: 'Transaction not found or not yet confirmed' };
  }

  // ── 3. Check the transaction succeeded ──
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'Transaction reverted / failed on-chain' };
  }

  // ── 4. Scan the logs for Transfer events from our token to treasury ──
  // An ERC-20 Transfer event has:
  //   topic[0] = keccak256("Transfer(address,address,uint256)")
  //   topic[1] = from (padded to 32 bytes)
  //   topic[2] = to (padded to 32 bytes)
  //   data     = uint256 amount
  let totalTransferred = 0n;
  let firstFrom = null;
  for (const log of receipt.logs || []) {
    if (!log.address || log.address.toLowerCase() !== AGENTCRAFT_TOKEN) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;

    const fromAddr = topicToAddress(log.topics[1]);
    const toAddr = topicToAddress(log.topics[2]);
    if (!toAddr || toAddr !== TREASURY_ADDRESS) continue;  // not paying the treasury

    const amount = decodeUint256(log.data);
    totalTransferred += amount;
    if (!firstFrom) firstFrom = fromAddr;
  }

  if (totalTransferred === 0n) {
    return {
      ok: false,
      reason: `No $AGENTCRAFT transfer to treasury found in this transaction (treasury=${TREASURY_ADDRESS})`,
    };
  }

  if (totalTransferred < requiredBig) {
    return {
      ok: false,
      reason: `Insufficient amount: paid ${formatAmount(totalTransferred)}, required ${formatAmount(requiredBig)}`,
      amount: formatAmount(totalTransferred),
    };
  }

  // ── 5. Success ──
  return {
    ok: true,
    txHash: txHash.toLowerCase(),
    from: firstFrom,
    amount: formatAmount(totalTransferred),
    amountBigInt: totalTransferred,
    requiredAmount: formatAmount(requiredBig),
    blockNumber: receipt.blockNumber ? receipt.blockNumber.toString() : null,
    treasury: TREASURY_ADDRESS,
    token: AGENTCRAFT_TOKEN,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────
module.exports = {
  verifyPayment,
  parseAmount,
  formatAmount,
  isValidTxHash,
  // Exported for testing
  _internals: {
    topicToAddress,
    decodeUint256,
    TRANSFER_TOPIC,
    AGENTCRAFT_TOKEN,
    TREASURY_ADDRESS,
    BASE_RPC_URL,
    TOKEN_DECIMALS,
  },
};
