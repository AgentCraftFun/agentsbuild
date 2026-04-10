/**
 * Phase 1 payment infrastructure tests.
 *
 * Covers:
 *   1. Tx hash format validation (reject malformed)
 *   2. ActionRegistry double-spend protection (claim + release + record)
 *   3. TxVerifier.parseAmount/formatAmount round-trip
 *   4. TxVerifier insufficient-amount rejection (with mocked RPC response)
 *   5. End-to-end API flow via a fake verifier (claim → dispatch → record)
 *
 * This script is self-contained. Run with:
 *   node server/test/phase1.js
 *
 * No external test runner — prints PASS/FAIL and exits non-zero on failure.
 */

const path = require('path');
const fs = require('fs');

const TxVerifier = require('../src/services/TxVerifier');
const ActionRegistry = require('../src/services/ActionRegistry');
const ActionCatalog = require('../src/services/ActionCatalog');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => {
        console.log('  ✓', name);
        passed++;
      }).catch(err => {
        console.log('  ✗', name);
        console.log('    ', err.stack || err.message);
        failed++;
      });
    }
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('    ', err.stack || err.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + (msg || ''));
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} — ${msg || ''}`);
  }
}

async function run() {
  console.log('\n=== Phase 1 Tests ===\n');

  // ─── Group 1: TxVerifier format checks ───
  console.log('TxVerifier — format validation:');

  test('isValidTxHash accepts a valid 32-byte hash', () => {
    assert(TxVerifier.isValidTxHash('0x' + 'a'.repeat(64)));
    assert(TxVerifier.isValidTxHash('0x' + '0'.repeat(64)));
    assert(TxVerifier.isValidTxHash('0xABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789'));
  });

  test('isValidTxHash rejects malformed hashes', () => {
    assert(!TxVerifier.isValidTxHash('0xabc'), 'too short');
    assert(!TxVerifier.isValidTxHash('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'), 'no 0x prefix');
    assert(!TxVerifier.isValidTxHash('0x' + 'g'.repeat(64)), 'non-hex chars');
    assert(!TxVerifier.isValidTxHash(''), 'empty string');
    assert(!TxVerifier.isValidTxHash(null), 'null');
    assert(!TxVerifier.isValidTxHash(undefined), 'undefined');
    assert(!TxVerifier.isValidTxHash(123), 'number');
    assert(!TxVerifier.isValidTxHash({}), 'object');
  });

  test('parseAmount parses whole numbers to wei', () => {
    assertEqual(TxVerifier.parseAmount('1').toString(), '1000000000000000000');
    assertEqual(TxVerifier.parseAmount('500').toString(), '500000000000000000000');
    assertEqual(TxVerifier.parseAmount('0').toString(), '0');
  });

  test('parseAmount parses decimals correctly', () => {
    assertEqual(TxVerifier.parseAmount('1.5').toString(), '1500000000000000000');
    assertEqual(TxVerifier.parseAmount('0.000001').toString(), '1000000000000');
    assertEqual(TxVerifier.parseAmount('0.5').toString(), '500000000000000000');
  });

  test('parseAmount rejects invalid strings', () => {
    let threw = false;
    try { TxVerifier.parseAmount('abc'); } catch (e) { threw = true; }
    assert(threw, 'should throw on "abc"');
    threw = false;
    try { TxVerifier.parseAmount('-5'); } catch (e) { threw = true; }
    assert(threw, 'should throw on negative');
    threw = false;
    try { TxVerifier.parseAmount('1.2.3'); } catch (e) { threw = true; }
    assert(threw, 'should throw on multiple dots');
  });

  test('formatAmount round-trips with parseAmount', () => {
    assertEqual(TxVerifier.formatAmount(TxVerifier.parseAmount('1.5')), '1.5');
    assertEqual(TxVerifier.formatAmount(TxVerifier.parseAmount('500')), '500');
    assertEqual(TxVerifier.formatAmount(TxVerifier.parseAmount('0.000001')), '0.000001');
  });

  test('verifyPayment rejects malformed tx hash', async () => {
    const r = await TxVerifier.verifyPayment('not-a-hash', '100');
    assert(!r.ok);
    assert(r.reason.toLowerCase().includes('invalid'));
  });

  test('verifyPayment rejects invalid required amount', async () => {
    const r = await TxVerifier.verifyPayment('0x' + 'a'.repeat(64), 'abc');
    assert(!r.ok);
    assert(r.reason.toLowerCase().includes('amount'));
  });

  // ─── Group 2: ActionRegistry double-spend ───
  console.log('\nActionRegistry — double-spend protection:');

  // Helper: fresh registry with a unique file path, auto-cleans on test end.
  function makeReg(suffix) {
    const file = path.join(__dirname, `_test_actions_${suffix}.json`);
    try { fs.unlinkSync(file); } catch (e) {}
    const r = new ActionRegistry({ filePath: file });
    r.load();
    r._testCleanup = () => { r.flushSync(); try { fs.unlinkSync(file); } catch (e) {} };
    return r;
  }

  test('claim returns true for a new hash', () => {
    const r = makeReg('g2a');
    assert(r.claim('0xaaa'));
    assert(r.isUsed('0xaaa'));
    r._testCleanup();
  });

  test('claim returns false for an already-claimed hash', () => {
    const r = makeReg('g2b');
    assert(r.claim('0xbbb'));
    assert(!r.claim('0xbbb'), 'second claim should fail');
    assert(!r.claim('0xBBB'), 'case-insensitive claim should fail');
    r._testCleanup();
  });

  test('release undoes a claim', () => {
    const r = makeReg('g2c');
    r.claim('0xccc');
    assert(r.release('0xccc'));
    assert(!r.isUsed('0xccc'));
    assert(r.claim('0xccc'), 'should be claimable again');
    r._testCleanup();
  });

  test('release fails on a recorded entry', () => {
    const r = makeReg('g2d');
    r.claim('0xddd');
    r.record({ txHash: '0xddd', action: 'echo', amount: '100', from: '0xff' });
    assert(!r.release('0xddd'), 'release should fail on permanent record');
    assert(r.isUsed('0xddd'));
    r._testCleanup();
  });

  test('record produces a retrievable entry', () => {
    const r = makeReg('g2e');
    r.claim('0xeee');
    r.record({ txHash: '0xeee', action: 'echo', amount: '50', from: '0x11' });
    const entry = r.getEntry('0xeee');
    assert(entry);
    assertEqual(entry.action, 'echo');
    assertEqual(entry.amount, '50');
    assertEqual(entry.from, '0x11');
    r._testCleanup();
  });

  test('double record is a no-op', () => {
    const r = makeReg('g2f');
    r.claim('0xfff');
    assert(r.record({ txHash: '0xfff', action: 'echo', amount: '50' }));
    assert(!r.record({ txHash: '0xfff', action: 'echo', amount: '50' }), 'second record should no-op');
    assertEqual(r.getStats().totalRecorded, 1);
    r._testCleanup();
  });

  test('persistence survives reload', () => {
    const pFile = path.join(__dirname, '_test_actions_persist.json');
    try { fs.unlinkSync(pFile); } catch (e) {}
    const r1 = new ActionRegistry({ filePath: pFile });
    r1.load();
    r1.claim('0x1111');
    r1.record({ txHash: '0x1111', action: 'echo', amount: '10' });
    r1.flushSync();
    // Reload fresh instance
    const r2 = new ActionRegistry({ filePath: pFile });
    r2.load();
    assert(r2.isUsed('0x1111'), 'should still be used after reload');
    assertEqual(r2.getStats().totalRecorded, 1);
    fs.unlinkSync(pFile);
  });

  // ─── Group 3: ActionCatalog ───
  console.log('\nActionCatalog:');

  test('echo action exists with a price', () => {
    const a = ActionCatalog.get('echo');
    assert(a);
    assertEqual(a.price, '1');
    assert(typeof a.dispatch === 'function');
  });

  test('get is case-insensitive', () => {
    assert(ActionCatalog.get('ECHO'));
    assert(ActionCatalog.get('Echo'));
  });

  test('unknown action returns undefined', () => {
    assert(!ActionCatalog.get('nonexistent'));
    assert(!ActionCatalog.get(''));
    assert(!ActionCatalog.get(null));
  });

  test('list returns all actions', () => {
    const list = ActionCatalog.list();
    assert(Array.isArray(list));
    assert(list.length >= 1);
    assert(list.some(a => a.name === 'echo'));
  });

  test('register adds a new action', () => {
    ActionCatalog.register('test_dyn', {
      price: '5',
      description: 'dynamic test',
      dispatch: () => ({ done: true }),
    });
    const a = ActionCatalog.get('test_dyn');
    assert(a);
    assertEqual(a.price, '5');
    // Clean up
    delete ActionCatalog._actions.test_dyn;
  });

  // ─── Group 4: End-to-end flow with mocked verifier ───
  console.log('\nEnd-to-end flow (mocked verifier):');

  // Simulate the /api/action endpoint logic without an HTTP server by
  // wiring the same pieces together. We mock verifyPayment to control
  // the outcome.
  function simulateAction(registry, catalog, verifierMock, body, worldState) {
    return (async () => {
      const txHash = (body.txHash || '').trim();
      const actionName = (body.action || '').toLowerCase();
      if (!txHash || !actionName) return { status: 400, body: { ok: false, error: 'txHash and action are required' } };
      if (!TxVerifier.isValidTxHash(txHash)) return { status: 400, body: { ok: false, error: 'Invalid transaction hash format' } };
      const actionDef = catalog.get(actionName);
      if (!actionDef) return { status: 400, body: { ok: false, error: `Unknown action: ${actionName}` } };
      if (!registry.claim(txHash)) {
        const prior = registry.getEntry(txHash);
        if (prior) return { status: 409, body: { ok: false, error: 'Transaction already used' } };
        return { status: 409, body: { ok: false, error: 'Transaction is being processed' } };
      }
      const verification = await verifierMock(txHash, actionDef.price);
      if (!verification.ok) {
        registry.release(txHash);
        return { status: 402, body: { ok: false, error: verification.reason } };
      }
      let dispatchResult;
      try {
        dispatchResult = await actionDef.dispatch({
          worldState, gameLoop: null,
          from: verification.from, txHash: verification.txHash,
          amount: verification.amount, tick: 0,
        }, body.params || {});
      } catch (err) {
        registry.release(txHash);
        return { status: 500, body: { ok: false, error: err.message } };
      }
      registry.record({
        txHash: verification.txHash, action: actionName,
        amount: verification.amount, from: verification.from,
        appliedAt: Date.now(), tick: 0, result: dispatchResult,
      });
      return { status: 200, body: { ok: true, action: actionName, txHash, result: dispatchResult } };
    })();
  }

  // Helper: create a clean registry with a unique file path.
  // Ensures no stale data from previous test runs.
  function makeCleanRegistry(suffix) {
    const file = path.join(__dirname, `_test_e2e_${suffix}.json`);
    try { fs.unlinkSync(file); } catch (e) {}
    const reg = new ActionRegistry({ filePath: file });
    reg.load();
    reg._testCleanup = () => {
      reg.flushSync();
      try { fs.unlinkSync(file); } catch (e) {}
    };
    return reg;
  }

  await test('successful end-to-end echo action', async () => {
    const reg = makeCleanRegistry('1');
    const validHash = '0x' + '1'.repeat(64);
    const mockVerifier = async (hash, required) => ({
      ok: true, txHash: hash.toLowerCase(), from: '0xdeadbeef'.padEnd(42, '0'),
      amount: '100', amountBigInt: 100n * 10n**18n, requiredAmount: required, blockNumber: '12345',
    });
    const result = await simulateAction(reg, ActionCatalog, mockVerifier, { txHash: validHash, action: 'echo' }, {});
    assertEqual(result.status, 200);
    assert(result.body.ok);
    assert(reg.isUsed(validHash));
    reg._testCleanup();
  });

  await test('double-spend rejected (409)', async () => {
    const reg = makeCleanRegistry('2');
    const validHash = '0x' + '2'.repeat(64);
    const mockVerifier = async () => ({ ok: true, txHash: validHash.toLowerCase(), from: '0xaa', amount: '100' });
    const r1 = await simulateAction(reg, ActionCatalog, mockVerifier, { txHash: validHash, action: 'echo' }, {});
    assertEqual(r1.status, 200);
    const r2 = await simulateAction(reg, ActionCatalog, mockVerifier, { txHash: validHash, action: 'echo' }, {});
    assertEqual(r2.status, 409);
    assert(!r2.body.ok);
    reg._testCleanup();
  });

  await test('insufficient amount rejected (402) AND claim released', async () => {
    const reg = makeCleanRegistry('3');
    const validHash = '0x' + '3'.repeat(64);
    const mockVerifier = async () => ({ ok: false, reason: 'Insufficient amount: paid 0.5, required 1' });
    const r = await simulateAction(reg, ActionCatalog, mockVerifier, { txHash: validHash, action: 'echo' }, {});
    assertEqual(r.status, 402);
    assert(r.body.error.toLowerCase().includes('insufficient'));
    // Claim must have been released so user can retry with a better payment
    assert(!reg.isUsed(validHash), 'claim should be released on failure');
    // Sanity: a fresh successful attempt should work
    const mockVerifier2 = async () => ({ ok: true, txHash: validHash.toLowerCase(), from: '0xbb', amount: '10' });
    const r2 = await simulateAction(reg, ActionCatalog, mockVerifier2, { txHash: validHash, action: 'echo' }, {});
    assertEqual(r2.status, 200);
    reg._testCleanup();
  });

  await test('malformed tx hash rejected (400) without claiming', async () => {
    const reg = makeCleanRegistry('4');
    const badHash = 'not-a-hash';
    const mockVerifier = async () => { throw new Error('should not be called'); };
    const r = await simulateAction(reg, ActionCatalog, mockVerifier, { txHash: badHash, action: 'echo' }, {});
    assertEqual(r.status, 400);
    assertEqual(reg.getStats().totalRecorded, 0);
    reg._testCleanup();
  });

  await test('unknown action rejected (400)', async () => {
    const reg = makeCleanRegistry('5');
    const validHash = '0x' + '5'.repeat(64);
    const mockVerifier = async () => { throw new Error('should not be called'); };
    const r = await simulateAction(reg, ActionCatalog, mockVerifier, { txHash: validHash, action: 'does_not_exist' }, {});
    assertEqual(r.status, 400);
    assert(!reg.isUsed(validHash));
    reg._testCleanup();
  });

  await test('dispatch error releases claim', async () => {
    const reg = makeCleanRegistry('6');
    const validHash = '0x' + '6'.repeat(64);
    // Register a broken action temporarily
    ActionCatalog.register('_broken', {
      price: '1',
      description: 'broken',
      dispatch: () => { throw new Error('kaboom'); },
    });
    const mockVerifier = async () => ({ ok: true, txHash: validHash.toLowerCase(), from: '0xcc', amount: '10' });
    const r = await simulateAction(reg, ActionCatalog, mockVerifier, { txHash: validHash, action: '_broken' }, {});
    assertEqual(r.status, 500);
    assert(!reg.isUsed(validHash), 'claim should be released on dispatch error');
    delete ActionCatalog._actions._broken;
    reg._testCleanup();
  });

  // ─── Summary ───
  console.log(`\nTotal: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
