/**
 * ActionRegistry — persistent record of consumed transaction hashes.
 *
 * Guarantees: each txHash can only be redeemed once. The registry is
 * persisted to disk in the same volume as gamestate.json so it survives
 * server restarts. This prevents a player from reusing a single on-chain
 * payment for multiple actions.
 *
 * Storage format (actions.json):
 *   {
 *     version: 1,
 *     entries: [
 *       { txHash, action, amount, from, appliedAt, tick, result, ... },
 *       ...
 *     ]
 *   }
 *
 * Concurrency model:
 *   - Node is single-threaded, so synchronous state mutations are atomic
 *     between async boundaries.
 *   - `claim(txHash)` returns true only for the first caller; subsequent
 *     callers (even within the same event-loop tick) see the hash is
 *     already claimed and return false. This MUST be called BEFORE any
 *     async verification so simultaneous requests can't both pass.
 *   - If the async verification fails, the caller MUST release the claim
 *     so the tx hash can be retried (release() returns the slot).
 *   - On successful verification + action execution, call record() to
 *     upgrade the claim to a permanent record.
 */

const fs = require('fs');

class ActionRegistry {
  constructor(options = {}) {
    this.filePath = options.filePath;  // set by caller, usually volume/actions.json
    // In-memory set for O(1) duplicate checks. Holds both claimed (pending
    // verification) and recorded (permanently consumed) hashes.
    this._claimed = new Set();
    // Detailed entries list (persisted). Each entry = { txHash, action, ... }
    this._entries = [];
    // Write debouncing
    this._dirty = false;
    this._saveTimer = null;
    this._saveInProgress = false;
  }

  /**
   * Load persisted state from disk. Call this once at startup before
   * the server begins accepting requests.
   */
  load() {
    if (!this.filePath) {
      console.warn('[ActionRegistry] No filePath set, running in-memory only');
      return;
    }
    try {
      if (!fs.existsSync(this.filePath)) {
        console.log(`[ActionRegistry] No existing file at ${this.filePath} — starting fresh`);
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.entries)) {
        console.warn('[ActionRegistry] Malformed file, starting fresh');
        return;
      }
      this._entries = data.entries;
      for (const entry of data.entries) {
        if (entry && entry.txHash) this._claimed.add(entry.txHash.toLowerCase());
      }
      console.log(`[ActionRegistry] Loaded ${this._entries.length} records from ${this.filePath}`);
    } catch (err) {
      console.error('[ActionRegistry] Failed to load:', err.message);
    }
  }

  /**
   * Normalize a tx hash for storage/comparison.
   */
  _normalize(txHash) {
    if (typeof txHash !== 'string') return null;
    return txHash.toLowerCase().trim();
  }

  /**
   * Check whether a tx hash has been consumed (claimed or recorded).
   * Returns true if it has.
   */
  isUsed(txHash) {
    const h = this._normalize(txHash);
    if (!h) return false;
    return this._claimed.has(h);
  }

  /**
   * Atomically claim a txHash slot. Returns true if the slot was free
   * (caller may proceed with verification), false if it was already claimed.
   *
   * CRITICAL: this is the only safe way to prevent double-spend across
   * concurrent requests. Call it BEFORE any async work.
   */
  claim(txHash) {
    const h = this._normalize(txHash);
    if (!h) return false;
    if (this._claimed.has(h)) return false;
    this._claimed.add(h);
    return true;
  }

  /**
   * Release a claimed txHash. Use this if async verification fails so
   * the hash can be retried (e.g. RPC was flaky, user can resubmit).
   */
  release(txHash) {
    const h = this._normalize(txHash);
    if (!h) return false;
    // Only release if not permanently recorded
    if (this._entries.some(e => e.txHash === h)) return false;
    this._claimed.delete(h);
    return true;
  }

  /**
   * Upgrade a claim to a permanent record. Call after successful
   * verification + action execution. Persists to disk.
   */
  record(entry) {
    if (!entry || !entry.txHash) return false;
    const h = this._normalize(entry.txHash);
    if (!h) return false;
    // Ensure claimed (should already be, but defensive)
    this._claimed.add(h);
    // Skip if already permanently recorded
    if (this._entries.some(e => e.txHash === h)) return false;
    this._entries.push({
      txHash: h,
      action: entry.action || null,
      amount: entry.amount || null,
      from: entry.from ? entry.from.toLowerCase() : null,
      appliedAt: entry.appliedAt || Date.now(),
      tick: entry.tick != null ? entry.tick : null,
      result: entry.result || null,
      params: entry.params || null,
    });
    this._markDirty();
    return true;
  }

  /**
   * Return the stored entry for a tx hash, or null.
   */
  getEntry(txHash) {
    const h = this._normalize(txHash);
    if (!h) return null;
    return this._entries.find(e => e.txHash === h) || null;
  }

  /**
   * Return summary stats — handy for /api/action/stats later.
   */
  getStats() {
    return {
      totalRecorded: this._entries.length,
      totalClaimed: this._claimed.size,
      filePath: this.filePath || null,
    };
  }

  /**
   * Return all entries (for leaderboards, admin views, etc.)
   */
  getAllEntries() {
    return this._entries.slice();
  }

  // ─── Persistence ────────────────────────────────────────────────

  _markDirty() {
    this._dirty = true;
    if (this._saveTimer) return;
    // Debounce writes: save at most once per 2 seconds
    this._saveTimer = setTimeout(() => this._flush(), 2000);
  }

  _flush() {
    this._saveTimer = null;
    if (!this._dirty) return;
    if (this._saveInProgress) {
      // Reschedule
      this._saveTimer = setTimeout(() => this._flush(), 1000);
      return;
    }
    this._saveInProgress = true;
    this._dirty = false;
    if (!this.filePath) {
      this._saveInProgress = false;
      return;
    }
    try {
      const data = {
        version: 1,
        savedAt: Date.now(),
        entries: this._entries,
      };
      // Atomic write: write to temp file, then rename
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[ActionRegistry] Save failed:', err.message);
      // Re-mark dirty so we try again
      this._dirty = true;
    } finally {
      this._saveInProgress = false;
    }
  }

  /**
   * Force a synchronous save (used on shutdown).
   */
  flushSync() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._flush();
  }
}

module.exports = ActionRegistry;
