import test from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../src/services/storeService.js';
import { config } from '../src/config/env.js';
import { approveTokenRequest, requestBagPayout, claimMission } from '../src/controllers/t2eController.js';
import { proxyRpc } from '../src/controllers/integrationController.js';

test('F-01: store.updateById resolves and does not throw SCALING_GUARD on Prisma collections', async () => {
    const testId = 'test-audit-user-' + Date.now();
    
    // Seed in memory / storage
    const initial = await store.create('users', {
        id: testId,
        walletAddress: '0x1111111111111111111111111111111111111111',
        items: 100,
        bagTokens: 50,
        createdAt: new Date().toISOString()
    });

    assert.ok(initial, 'User created');

    // Perform updateById - MUST NOT throw SCALING_GUARD
    const updated = await store.updateById('users', testId, (curr) => ({
        items: (curr.items || 0) + 25
    }));

    assert.ok(updated, 'User updated successfully');
    assert.equal(updated.items, 125, 'Items balance incremented');
});

test('F-01: store.update with predicate resolves and does not throw SCALING_GUARD', async () => {
    const testId = 'test-audit-user-pred-' + Date.now();
    
    await store.create('users', {
        id: testId,
        walletAddress: '0x2222222222222222222222222222222222222222',
        items: 200,
        createdAt: new Date().toISOString()
    });

    const updated = await store.update('users', u => u.id === testId, (curr) => ({
        items: (curr.items || 0) + 50
    }));

    assert.ok(updated, 'User updated via predicate');
    assert.equal(updated.items, 250);
});

test('F-02: approveTokenRequest rejects fabricated / synthetic transaction hashes', async () => {
    const req = {
        params: { id: 'test-req-1' },
        body: { txHash: 'not-a-valid-hex-hash' }
    };
    let statusCode = 200;
    let bodyPayload = null;
    const res = {
        status(code) { statusCode = code; return this; },
        json(payload) { bodyPayload = payload; return this; }
    };

    // Store dummy pending payout request
    await store.create('t2e_payout_requests', {
        id: 'test-req-1',
        userId: 'user-1',
        expectedTokens: 500,
        walletAddress: '0x123',
        status: 'PENDING'
    });

    await approveTokenRequest(req, res);

    assert.equal(statusCode, 400);
    assert.match(bodyPayload.error, /valid on-chain transaction hash/i);
});

test('F-03: config.rpcUrls is defined and contains supported EVM chains', () => {
    assert.ok(config.rpcUrls, 'config.rpcUrls must be defined');
    assert.ok(typeof config.rpcUrls.ethereum === 'string' && config.rpcUrls.ethereum.length > 0, 'ethereum RPC URL configured');
    assert.ok(typeof config.rpcUrls.bsc === 'string' && config.rpcUrls.bsc.length > 0, 'bsc RPC URL configured');
    assert.ok(typeof config.rpcUrls.polygon === 'string' && config.rpcUrls.polygon.length > 0, 'polygon RPC URL configured');
});

test('F-03: proxyRpc returns 404 for unconfigured chains without crashing', async () => {
    let statusCode = 200;
    let bodyPayload = null;
    const req = {
        params: { chain: 'unsupported-chain-xyz' },
        body: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }
    };
    const res = {
        status(code) { statusCode = code; return this; },
        json(payload) { bodyPayload = payload; return this; }
    };

    await proxyRpc(req, res);

    assert.equal(statusCode, 404);
    assert.equal(bodyPayload.error.code, -32601);
});
