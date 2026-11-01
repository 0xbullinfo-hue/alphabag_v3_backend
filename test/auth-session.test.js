import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../src/config/env.js';
import { store } from '../src/services/storeService.js';
import { verifyToken } from '../src/middleware/authMiddleware.js';
import { getNonce, verify, login } from '../src/controllers/authController.js';
import { resolveUserTier, checkAndIncrementAiQuota } from '../src/controllers/aiController.js';

const originalStoreMethods = {
  findOne: store.findOne,
  create: store.create,
  updateById: store.updateById,
};

const createMockResponse = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
  };
  return res;
};

test('Phase 3 — Nonce requires valid EVM address', async () => {
  const reqNoWallet = { query: {} };
  const resNoWallet = createMockResponse();
  await getNonce(reqNoWallet, resNoWallet);
  assert.equal(resNoWallet.statusCode, 400);
  assert.match(resNoWallet.body.error, /Valid wallet address is required/i);

  const reqInvalidWallet = { query: { wallet: '0xinvalid' } };
  const resInvalidWallet = createMockResponse();
  await getNonce(reqInvalidWallet, resInvalidWallet);
  assert.equal(resInvalidWallet.statusCode, 400);

  const reqValid = { query: { wallet: '0x1111111111111111111111111111111111111111' } };
  const resValid = createMockResponse();
  await getNonce(reqValid, resValid);
  assert.equal(resValid.statusCode, 200);
  assert.ok(typeof resValid.body.nonce === 'string' && resValid.body.nonce.length > 0);
});

test('Phase 3 — TokenVersion session revocation', async () => {
  let mockUser = {
    id: 'user-tv-1',
    wallet: '0x2222222222222222222222222222222222222222',
    tier: 'FREE',
    tokenVersion: 1,
  };

  store.findOne = async (collection, query) => {
    if (collection === 'users' && (query.id === mockUser.id || query.wallet === mockUser.wallet)) {
      return structuredClone(mockUser);
    }
    if (collection === 'admins') return null;
    return null;
  };

  // Valid token with tv: 1
  const validToken = jwt.sign(
    { id: mockUser.id, wallet: mockUser.wallet, tier: 'FREE', tv: 1 },
    config.jwtSecret,
    { expiresIn: '1h', algorithm: 'HS256' }
  );

  let nextCalled = false;
  const reqValid = {
    headers: { authorization: `Bearer ${validToken}` },
  };
  const resValid = createMockResponse();
  await verifyToken(reqValid, resValid, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(reqValid.user.id, mockUser.id);

  // Token with old tv: 0 (session revoked)
  const staleToken = jwt.sign(
    { id: mockUser.id, wallet: mockUser.wallet, tier: 'FREE', tv: 0 },
    config.jwtSecret,
    { expiresIn: '1h', algorithm: 'HS256' }
  );

  let staleNextCalled = false;
  const reqStale = {
    headers: { authorization: `Bearer ${staleToken}` },
  };
  const resStale = createMockResponse();
  await verifyToken(reqStale, resStale, () => { staleNextCalled = true; });
  assert.equal(staleNextCalled, false);
  assert.equal(resStale.statusCode, 401);
  assert.match(resStale.body.error, /revoked or expired/i);

  // Restore store methods
  store.findOne = originalStoreMethods.findOne;
});

test('Admin login requires the stored password and does not require a client portal secret', async () => {
  const originalPassword = await bcrypt.hash('correct-password', 4);
  const originalAdmin = store.findOne;
  const originalUpdate = store.updateById;
  store.findOne = async (collection) => collection === 'admins'
    ? { id: 'admin-login-1', email: 'admin@alphabag.io', password: originalPassword, tokenVersion: 0 }
    : null;
  store.updateById = async (_collection, _id, update) => ({
    id: 'admin-login-1',
    email: 'admin@alphabag.io',
    tokenVersion: 0,
    ...update({ id: 'admin-login-1', email: 'admin@alphabag.io', tokenVersion: 0 }),
  });

  try {
    const resInvalid = createMockResponse();
    await login({ body: { portal: 'admin', email: 'admin@alphabag.io', password: 'wrong-password' } }, resInvalid);
    assert.equal(resInvalid.statusCode, 400);

    const resValid = createMockResponse();
    await login({ body: { portal: 'admin', email: 'admin@alphabag.io', password: 'correct-password' } }, resValid);
    assert.equal(resValid.statusCode, 200);
    assert.equal(resValid.body.user.isAdmin, true);
    assert.equal(typeof resValid.body.token, 'string');
  } finally {
    store.findOne = originalAdmin;
    store.updateById = originalUpdate;
  }
});

test('Phase 3 — AI Quota resolves tier from DB and caps ULTIMATE tier', async () => {
  let dbUser = {
    id: 'user-ai-1',
    wallet: '0x3333333333333333333333333333333333333333',
    tier: 'ULTIMATE',
  };

  store.findOne = async (collection, query) => {
    if (collection === 'users' && query.id === dbUser.id) {
      return structuredClone(dbUser);
    }
    return null;
  };

  // Even if req.user claims FREE tier, resolveUserTier checks DB
  const resolvedTier = await resolveUserTier({ id: dbUser.id, tier: 'FREE' });
  assert.equal(resolvedTier, 'ULTIMATE');

  const quota = await checkAndIncrementAiQuota({ id: dbUser.id, tier: 'FREE' });
  assert.equal(quota.allowed, true);
  assert.equal(quota.tier, 'ULTIMATE');
  assert.ok(Number.isFinite(quota.limit), 'ULTIMATE tier daily limit must be a finite number');
  assert.equal(quota.limit, 2000);

  // Restore store methods
  store.findOne = originalStoreMethods.findOne;
});
