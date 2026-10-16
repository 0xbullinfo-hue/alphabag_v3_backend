import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma, store } from '../src/services/storeService.js';
import * as t2eController from '../src/controllers/t2eController.js';
import { config } from '../src/config/env.js';

test('Payout Verification & Anti-Replay', async (t) => {
    const originalIsProduction = config.isProduction;
    const originalBag = config.bagTokenAddress;
    const originalTreasury = config.treasuryAddress;

    t.after(() => {
        config.isProduction = originalIsProduction;
        config.bagTokenAddress = originalBag;
        config.treasuryAddress = originalTreasury;
    });

    await t.test('approveTokenRequest requires valid 64-hex char txHash', async () => {
        // Mock request
        store.findOne = async () => ({
            id: 'req_1',
            status: 'PENDING',
            expectedTokens: 100,
            walletAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
        });

        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };

        await t2eController.approveTokenRequest(
            { params: { id: 'req_1' }, body: { txHash: 'not-a-hash' } },
            res
        );

        assert.equal(res.statusCode, 400);
        assert.match(res.body.error, /A valid on-chain transaction hash/i);
    });

    await t.test('approveTokenRequest returns 503 in production if token or treasury address is missing', async () => {
        config.isProduction = true;
        config.bagTokenAddress = null;
        config.treasuryAddress = null;

        store.findOne = async () => ({
            id: 'req_1',
            status: 'PENDING',
            expectedTokens: 100,
            walletAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
        });

        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };

        const validHash = '0x' + 'a'.repeat(64);
        await t2eController.approveTokenRequest(
            { params: { id: 'req_1' }, body: { txHash: validHash } },
            res
        );

        assert.equal(res.statusCode, 503);
        assert.match(res.body.error, /Payout verification unavailable/i);
    });

    await t.test('approveTokenRequest prevents replay of same txHash for same wallet address (409)', async () => {
        config.isProduction = false;
        config.bagTokenAddress = null;
        config.treasuryAddress = null;

        const recipient = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
        const validHash = '0x' + 'b'.repeat(64);

        store.findOne = async () => ({
            id: 'req_1',
            status: 'PENDING',
            expectedTokens: 100,
            walletAddress: recipient
        });

        // Mock prisma $transaction to simulate finding an existing claim
        const originalTransaction = prisma.$transaction;
        prisma.$transaction = async (fn) => {
            const mockTx = {
                t2EPayoutRequest: {
                    findUnique: async () => ({ id: 'req_1', status: 'PENDING' }),
                    update: async () => ({ id: 'req_1', status: 'APPROVED' })
                },
                payoutTxClaim: {
                    findUnique: async () => ({ id: 'claim_existing', txHash: validHash.toLowerCase() }),
                    create: async () => ({ id: 'claim_new' })
                }
            };
            return await fn(mockTx);
        };

        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };

        await t2eController.approveTokenRequest(
            { params: { id: 'req_1' }, body: { txHash: validHash } },
            res
        );

        prisma.$transaction = originalTransaction;

        assert.equal(res.statusCode, 409);
        assert.match(res.body.error, /Transaction hash has already been used/i);
    });

    await t.test('markPayoutDone rejects if status is not APPROVED', async () => {
        store.findOne = async () => ({
            id: 'req_pending',
            status: 'PENDING',
            txHash: '0x' + 'c'.repeat(64)
        });

        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };

        await t2eController.markPayoutDone(
            { params: { id: 'req_pending' }, body: {} },
            res
        );

        assert.equal(res.statusCode, 400);
        assert.match(res.body.error, /payout must be in APPROVED status/i);
    });

    await t.test('updatePreferredWallet rejects without SIWE signature when changing address', async () => {
        store.findOne = async (col) => {
            if (col === 't2e_payout_requests') return null;
            if (col === 'users') {
                return {
                    id: 'user_1',
                    preferredWallet: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
                };
            }
            return null;
        };

        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };

        await t2eController.updatePreferredWallet(
            {
                user: { id: 'user_1' },
                body: { wallet: '0x0000000000000000000000000000000000000002' }
            },
            res
        );

        assert.equal(res.statusCode, 403);
        assert.equal(res.body.requiresSignature, true);
    });
});
