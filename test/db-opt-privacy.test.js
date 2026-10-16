import test from 'node:test';
import assert from 'node:assert/strict';
import { getReferrals } from '../src/controllers/authController.js';
import {
    claimMission,
    getLeaderboard,
    clearLeaderboardCache,
    getAdminActivity,
    getUserEarnProfile,
    getTreasuryStatus
} from '../src/controllers/t2eController.js';
import { store, prisma } from '../src/services/storeService.js';

function createMockRes() {
    return {
        statusCode: 200,
        _json: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this._json = data;
            return this;
        }
    };
}

test('R7: getReferrals does NOT leak email addresses and returns masked handles', async () => {
    // Setup test users in store
    const referrerId = 'referrer-user-1';
    const ref1Id = 'referred-user-1';
    const ref2Id = 'referred-user-2';

    await store.write('users', [
        {
            id: referrerId,
            referralCode: 'REF123',
            email: 'referrer@alphabag.app'
        },
        {
            id: ref1Id,
            email: 'victim1@private.com',
            referredBy: referrerId,
            verifiedWallet: '0x1111222233334444555566667777888899990000',
            items: 150,
            createdAt: new Date().toISOString()
        },
        {
            id: ref2Id,
            email: 'victim2@secret.org',
            referredBy: referrerId,
            verifiedWallet: '0xaaaabbbbccccddddeeeeffff0000111122223333',
            items: 300,
            createdAt: new Date().toISOString()
        }
    ], { replaceAll: true });

    const req = { user: { id: referrerId } };
    const res = createMockRes();

    await getReferrals(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res._json.totalReferrals, 2);
    assert.equal(res._json.referralCode, 'REF123');
    assert.equal(res._json.referrals.length, 2);

    for (const referral of res._json.referrals) {
        // Critical privacy verification: email MUST NOT be present
        assert.equal(referral.email, undefined, 'Referral email must not be exposed');
        assert.ok(referral.handle, 'Referral should have a handle');
        // Check handle masking
        if (referral.handle.startsWith('0x')) {
            assert.match(referral.handle, /^0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}$/);
        }
    }
});

test('R7: getLeaderboard uses 60s cache and bounds responses', async () => {
    clearLeaderboardCache();

    const u1 = 'user-lb-1';
    const u2 = 'user-lb-2';

    await store.write('users', [
        { id: u1, verifiedWallet: '0x1234567890abcdef1234567890abcdef12345678' },
        { id: u2, verifiedWallet: '0xabcdef1234567890abcdef1234567890abcdef12' }
    ], { replaceAll: true });

    const recentTime = new Date().toISOString();
    await store.write('t2e_claims', [
        { id: 'c1', userId: u1, missionId: 'm1', rewardTokens: 100, createdAt: recentTime },
        { id: 'c2', userId: u1, missionId: 'm2', rewardTokens: 250, createdAt: recentTime },
        { id: 'c3', userId: u2, missionId: 'm1', rewardTokens: 50, createdAt: recentTime }
    ], { replaceAll: true });

    const req = {};
    const res1 = createMockRes();
    await getLeaderboard(req, res1);

    assert.equal(res1.statusCode, 200);
    assert.ok(Array.isArray(res1._json));
    assert.equal(res1._json.length, 2);
    assert.equal(res1._json[0].points, 350);
    assert.equal(res1._json[1].points, 50);

    // Modify store data directly - response should still come from cache
    await store.write('t2e_claims', [
        { id: 'c4', userId: u2, missionId: 'm3', rewardTokens: 9999, createdAt: recentTime }
    ], { replaceAll: true });

    const res2 = createMockRes();
    await getLeaderboard(req, res2);

    // Cached response still has 2 items with u1 on top
    assert.equal(res2._json.length, 2);
    assert.equal(res2._json[0].points, 350);

    // Invalidate cache and verify update
    clearLeaderboardCache();
    const res3 = createMockRes();
    await getLeaderboard(req, res3);
    assert.equal(res3._json[0].points, 9999);
});

test('R7: getAdminActivity bounds results to at most 50', async () => {
    // Generate 60 claims
    const claims = [];
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
        claims.push({
            id: `claim-${i}`,
            userId: `user-${i % 5}`,
            missionId: 'mission-test',
            rewardTokens: 10,
            createdAt: new Date(now - i * 1000).toISOString()
        });
    }

    await store.write('t2e_claims', claims, { replaceAll: true });
    await store.write('t2e_missions', [
        { id: 'mission-test', title: 'Test Mission', type: 'SOCIAL' }
    ], { replaceAll: true });

    const req = {};
    const res = createMockRes();
    await getAdminActivity(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res._json));
    assert.equal(res._json.length, 50, 'Activity must be bounded to 50 items');
    // Ensure descending order
    assert.equal(res._json[0].id, 'claim-0');
});

test('R7: claimMission works correctly with targeted queries and atomic updates', async () => {
    const userId = 'claim-user-r7';
    await store.write('users', [
        {
            id: userId,
            items: 100,
            lifetimeEarned: 100,
            isBanned: false
        }
    ], { replaceAll: true });

    await store.write('t2e_missions', [
        {
            id: 'm-r7-once',
            title: 'Once Mission',
            rewardTokens: 75,
            frequency: 'ONCE',
            status: 'ACTIVE'
        }
    ], { replaceAll: true });

    await store.write('t2e_claims', [], { replaceAll: true });

    const req = {
        user: { id: userId },
        body: { missionId: 'm-r7-once' }
    };
    const res = createMockRes();

    await claimMission(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res._json.success, true);
    assert.equal(res._json.rewardTokens, 75);
    assert.equal(res._json.items, 175);

    // Duplicate claim should be rejected
    const resDup = createMockRes();
    await claimMission(req, resDup);
    assert.equal(resDup.statusCode, 400);
    assert.match(resDup._json.error, /already claimed/i);
});
