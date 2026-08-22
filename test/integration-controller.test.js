import test from 'node:test';
import assert from 'node:assert/strict';

import { getApprovals, getFeatures, proxyRpc } from '../src/controllers/integrationController.js';

const createResponse = () => ({
    statusCode: 200,
    body: undefined,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(payload) {
        this.body = payload;
        return this;
    },
});

test('getFeatures returns the documented feature flag shape', () => {
    const res = createResponse();

    getFeatures({}, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
        'disabledPages',
        'enableAlphaAi',
        'enableSecurityScanner',
        'enableTokenGating',
        'isTeaserMode',
        'maxPortfolios',
        'maxWhales',
        'updatedAt',
    ]);
    assert.equal(Array.isArray(res.body.disabledPages), true);
});

test('getApprovals rejects an invalid EVM address before calling the provider', async () => {
    const res = createResponse();

    await getApprovals({ query: { address: 'not-an-address', chain: 'bsc' } }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'address must be a valid EVM address');
});

test('getApprovals rejects unsupported canonical chain keys', async () => {
    const res = createResponse();

    await getApprovals({ query: { address: '0x1234567890123456789012345678901234567890', chain: 'solana' } }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'chain must be a supported EVM chain key');
});

test('proxyRpc rejects JSON-RPC methods outside the read-only allowlist', async () => {
    const res = createResponse();
    const req = {
        params: { chain: 'ethereum' },
        body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_sendRawTransaction',
            params: ['0xdeadbeef'],
        },
    };

    await proxyRpc(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, -32601);
});
