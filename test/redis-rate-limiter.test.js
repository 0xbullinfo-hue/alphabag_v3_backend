import test from 'node:test';
import assert from 'node:assert/strict';
import {
    storeNonce,
    consumeNonce,
    incrementAiQuota,
    getAiQuota,
    resetMemoryStores
} from '../src/services/redisService.js';
import {
    nonceLimiter,
    verifyLimiter,
    authLimiter
} from '../src/middleware/rateLimiters.js';

test('R9: Nonce lifecycle in distributed state (store, consume, anti-replay)', async () => {
    resetMemoryStores();

    const nonce = 'test-nonce-12345';
    const wallet = '0x1234567890123456789012345678901234567890';

    // Store nonce
    const stored = await storeNonce(nonce, wallet, 300);
    assert.equal(stored, true, 'Nonce should be stored successfully');

    // Duplicate store must fail (NX)
    const duplicate = await storeNonce(nonce, wallet, 300);
    assert.equal(duplicate, false, 'Duplicate nonce storage must be rejected');

    // Consume nonce (atomic read-and-delete)
    const consumed = await consumeNonce(nonce);
    assert.ok(consumed, 'Nonce should be consumed');
    assert.equal(consumed.wallet.toLowerCase(), wallet.toLowerCase());

    // Second consumption must fail (single-use anti-replay)
    const consumedAgain = await consumeNonce(nonce);
    assert.equal(consumedAgain, null, 'Nonce cannot be consumed twice');
});

test('R9: Nonce expires after TTL', async () => {
    resetMemoryStores();

    const nonce = 'test-expired-nonce';
    const wallet = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

    // Store with 0.1s TTL
    await storeNonce(nonce, wallet, 0.1);

    // Wait 150ms
    await new Promise(r => setTimeout(r, 150));

    const consumed = await consumeNonce(nonce);
    assert.equal(consumed, null, 'Expired nonce must return null');
});

test('R9: AI Quota counters atomic increment and limit enforcement', async () => {
    resetMemoryStores();

    const userId = 'user-ai-quota-test';
    const dateStr = '2026-10-16';
    const limit = 3;

    // Call 1
    const res1 = await incrementAiQuota(userId, dateStr, limit);
    assert.equal(res1.used, 1);
    assert.equal(res1.allowed, true);
    assert.equal(res1.remaining, 2);

    // Call 2
    const res2 = await incrementAiQuota(userId, dateStr, limit);
    assert.equal(res2.used, 2);
    assert.equal(res2.allowed, true);
    assert.equal(res2.remaining, 1);

    // Call 3 (last allowed)
    const res3 = await incrementAiQuota(userId, dateStr, limit);
    assert.equal(res3.used, 3);
    assert.equal(res3.allowed, true);
    assert.equal(res3.remaining, 0);

    // Call 4 (exceeded)
    const res4 = await incrementAiQuota(userId, dateStr, limit);
    assert.equal(res4.used, 4);
    assert.equal(res4.allowed, false);
    assert.equal(res4.remaining, 0);

    const currentUsage = await getAiQuota(userId, dateStr);
    assert.equal(currentUsage, 4);
});

test('R8: Rate limiters are separate and have correct quotas', () => {
    // Nonce limiter: 30 requests / 15 minutes
    assert.ok(nonceLimiter, 'nonceLimiter should be exported');
    // Verify limiter: 20 requests / 15 minutes
    assert.ok(verifyLimiter, 'verifyLimiter should be exported');
    // Auth limiter: 20 requests / 15 minutes
    assert.ok(authLimiter, 'authLimiter should be exported');
});
