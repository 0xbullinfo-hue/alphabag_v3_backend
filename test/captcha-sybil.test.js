import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyCaptcha, verifyRequestCaptcha } from '../src/services/captchaService.js';
import { checkMissionClaimRateLimit, claimMission, requestBagPayout } from '../src/controllers/t2eController.js';
import { store, prisma } from '../src/services/storeService.js';
import { config } from '../src/config/env.js';

test('R4: CAPTCHA Service & Sybil Eligibility Gates', async (t) => {
    const originalSecret = process.env.CAPTCHA_SECRET_KEY;
    const originalVerifyUrl = process.env.CAPTCHA_VERIFY_URL;
    const originalIsProduction = config.isProduction;

    t.after(() => {
        process.env.CAPTCHA_SECRET_KEY = originalSecret;
        process.env.CAPTCHA_VERIFY_URL = originalVerifyUrl;
        config.isProduction = originalIsProduction;
    });

    await t.test('verifyCaptcha returns valid: true in development when secret is not configured', async () => {
        delete process.env.CAPTCHA_SECRET_KEY;
        config.isProduction = false;

        const res = await verifyCaptcha('any-token');
        assert.equal(res.valid, true);
    });

    await t.test('verifyCaptcha fails closed in production when secret is missing', async () => {
        delete process.env.CAPTCHA_SECRET_KEY;
        config.isProduction = true;

        const res = await verifyCaptcha('any-token');
        assert.equal(res.valid, false);
        assert.equal(res.status, 503);
        assert.match(res.error, /CAPTCHA service is not configured/i);
    });

    await t.test('verifyCaptcha rejects missing token when secret is configured', async () => {
        process.env.CAPTCHA_SECRET_KEY = 'test-secret';
        config.isProduction = true;

        const res = await verifyCaptcha(null);
        assert.equal(res.valid, false);
        assert.equal(res.status, 400);
        assert.match(res.error, /CAPTCHA token required/i);
    });

    await t.test('verifyCaptcha handles service error/timeout gracefully (502)', async () => {
        process.env.CAPTCHA_SECRET_KEY = 'test-secret';
        process.env.CAPTCHA_VERIFY_URL = 'http://127.0.0.1:59999/nonexistent';

        const res = await verifyCaptcha('token-123');
        assert.equal(res.valid, false);
        assert.equal(res.status, 502);
        assert.match(res.error, /CAPTCHA service unreachable/i);
    });

    await t.test('checkMissionClaimRateLimit allows 10 claims and blocks the 11th', () => {
        const testUser = 'user-rate-limit-test-' + Date.now();
        for (let i = 0; i < 10; i++) {
            assert.equal(checkMissionClaimRateLimit(testUser, 10), true);
        }
        assert.equal(checkMissionClaimRateLimit(testUser, 10), false);
    });

    await t.test('claimMission returns 429 when rate limit is exceeded', async () => {
        const rateLimitedUser = 'rate-limited-user-' + Date.now();
        for (let i = 0; i < 10; i++) {
            checkMissionClaimRateLimit(rateLimitedUser, 10);
        }

        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };

        await claimMission({ user: { id: rateLimitedUser }, body: {} }, res);
        assert.equal(res.statusCode, 429);
        assert.match(res.body.error, /Too many mission claims/i);
    });

    await t.test('requestBagPayout rejects users under 24 hours old with 403', async () => {
        delete process.env.CAPTCHA_SECRET_KEY;
        config.isProduction = false;

        const youngUser = {
            id: 'young-user',
            items: 1000,
            preferredWallet: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
            createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours old
        };

        const originalTransaction = prisma.$transaction;
        prisma.$transaction = async (fn) => {
            const mockTx = {
                user: { findUnique: async () => youngUser },
                t2EPayoutRequest: { findFirst: async () => null }
            };
            return await fn(mockTx);
        };

        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };

        await requestBagPayout({ user: { id: youngUser.id }, body: {} }, res);

        prisma.$transaction = originalTransaction;

        assert.equal(res.statusCode, 403);
        assert.match(res.body.error, /Account must be at least 24 hours old/i);
    });

    await t.test('requestBagPayout allows users older than 24 hours', async () => {
        delete process.env.CAPTCHA_SECRET_KEY;
        config.isProduction = false;

        const matureUser = {
            id: 'mature-user',
            items: 1000,
            preferredWallet: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
            createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) // 48 hours old
        };

        const originalTransaction = prisma.$transaction;
        prisma.$transaction = async (fn) => {
            const mockTx = {
                user: {
                    findUnique: async () => matureUser,
                    update: async () => ({ ...matureUser, items: 0 })
                },
                t2EPayoutRequest: {
                    findFirst: async () => null,
                    create: async ({ data }) => ({ id: 'req_mature_1', ...data })
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

        await requestBagPayout({ user: { id: matureUser.id }, body: {} }, res);

        prisma.$transaction = originalTransaction;

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
    });
});
