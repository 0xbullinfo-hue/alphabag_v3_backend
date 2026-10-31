import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { config } from '../src/config/env.js';
import { store } from '../src/services/storeService.js';
import { optionalAuth } from '../src/middleware/authMiddleware.js';
import { getSignals } from '../src/controllers/publicController.js';

const originalFindOne = store.findOne;
const originalRead = store.read;
const makeToken = (claims) => jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256' });
const runOptionalAuth = async (token) => {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const errors = [];
  let nextCalls = 0;
  await optionalAuth(req, {}, (error) => {
    nextCalls += 1;
    if (error) errors.push(error);
  });
  return { req, errors, nextCalls };
};

function mockStore(t, implementation) {
  store.findOne = implementation;
  t.after(() => { store.findOne = originalFindOne; });
}

test('optionalAuth uses current DB tier and tokenVersion rather than token claims', async (t) => {
  const user = { id: 'user-1', email: 'one@example.test', verifiedWallet: '0x1111', tier: 'FREE', tokenVersion: 4, isBanned: false };
  mockStore(t, async (collection, query) => {
    if (collection === 'users' && query.id === user.id) return user;
    return null;
  });
  const result = await runOptionalAuth(makeToken({ id: user.id, tier: 'ULTIMATE', tv: 4 }));
  assert.equal(result.errors.length, 0);
  assert.equal(result.req.user.tier, 'FREE');
  assert.equal(result.req.user.tokenVersion, 4);
  assert.equal(result.req.user.isAdmin, false);
  assert.equal(result.req.user.kind, 'user');
});

test('optionalAuth makes stale, future-version, and banned credentials anonymous', async (t) => {
  const user = { id: 'user-2', tier: 'ULTIMATE', tokenVersion: 3, isBanned: false };
  mockStore(t, async (collection, query) => {
    if (collection === 'users' && query.id === user.id) return { ...user };
    return null;
  });
  for (const tv of [2, 4]) {
    const result = await runOptionalAuth(makeToken({ id: user.id, tier: 'ULTIMATE', tv }));
    assert.equal(result.req.user, null);
    assert.equal(result.errors.length, 0);
    assert.equal(result.nextCalls, 1);
  }
  user.isBanned = true;
  const banned = await runOptionalAuth(makeToken({ id: user.id, tier: 'ULTIMATE', tv: 3 }));
  assert.equal(banned.req.user, null);
  assert.equal(banned.errors.length, 0);
});

test('optionalAuth does not grant admin from a claim without an Admin row', async (t) => {
  mockStore(t, async () => null);
  const result = await runOptionalAuth(makeToken({ id: 'missing-admin', isAdmin: true, tier: 'ULTIMATE', tv: 0 }));
  assert.equal(result.req.user, null);
  assert.equal(result.errors.length, 0);
});

test('optionalAuth resolves admin by DB record and validates DB tokenVersion', async (t) => {
  mockStore(t, async (collection, query) => {
    if (collection === 'admins' && query.id === 'admin-1') return { id: 'admin-1', email: 'admin@example.test', tokenVersion: 2 };
    return null;
  });
  const result = await runOptionalAuth(makeToken({ id: 'admin-1', isAdmin: true, tv: 2 }));
  assert.equal(result.req.user.isAdmin, true);
  assert.equal(result.req.user.kind, 'admin');
  assert.equal(result.req.user.tokenVersion, 2);
});

test('optionalAuth requires JWT wallet to match current verifiedWallet before admin linkage', async (t) => {
  const user = {
    id: 'user-email-collision',
    email: 'shared@example.test',
    verifiedWallet: '0x1111',
    tokenVersion: 0,
    isBanned: false,
  };
  mockStore(t, async (collection, query) => {
    if (collection === 'users' && query.id === user.id) return user;
    if (collection === 'admins' && query.wallet === '0x2222') return { id: 'admin-token-wallet', wallet: '0x2222' };
    return null;
  });

  const mismatch = await runOptionalAuth(makeToken({ id: user.id, email: user.email, wallet: '0x2222', tv: 0 }));
  assert.equal(mismatch.req.user.isAdmin, false);
  assert.equal(mismatch.req.user.kind, 'user');

  mockStore(t, async (collection, query) => {
    if (collection === 'users' && query.id === user.id) return user;
    if (collection === 'admins' && query.wallet?.mode === 'insensitive' && query.wallet.equals === '0x1111') {
      return { id: 'admin-linked-wallet', wallet: '0X1111' };
    }
    return null;
  });
  const walletMatch = await runOptionalAuth(makeToken({ id: user.id, wallet: '0X1111', tv: 0 }));
  assert.equal(walletMatch.req.user.isAdmin, true);
  assert.equal(walletMatch.req.user.kind, 'user');
});

test('optionalAuth treats malformed credentials as anonymous, but forwards store outages', async (t) => {
  mockStore(t, async () => { throw new Error('database unavailable'); });
  const malformed = await runOptionalAuth('not-a-jwt');
  assert.equal(malformed.req.user, null);
  assert.equal(malformed.errors.length, 0);
  const outage = await runOptionalAuth(makeToken({ id: 'user-db-down', tv: 0 }));
  assert.equal(outage.req.user, undefined);
  assert.equal(outage.errors.length, 1);
  assert.match(outage.errors[0].message, /database unavailable/);
});

test('optionalAuth without credentials remains anonymous', async (t) => {
  mockStore(t, async () => { throw new Error('must not query without a credential'); });
  const result = await runOptionalAuth(null);
  assert.equal(result.req.user, null);
  assert.equal(result.errors.length, 0);
  assert.equal(result.nextCalls, 1);
});

test('invalid credentials reach public signals as anonymous and receive redacted fields', async (t) => {
  store.findOne = async () => null;
  store.read = async (collection) => collection === 'signals' ? [{
    id: 'signal-1', pair: 'ABC/USDT', type: 'BUY', status: 'ACTIVE', timestamp: 'now',
    isFree: false, target: 10, stopLoss: 5,
  }] : [];
  t.after(() => {
    store.findOne = originalFindOne;
    store.read = originalRead;
  });

  const { req } = await runOptionalAuth(makeToken({ id: 'deleted-user', tier: 'ULTIMATE', tv: 0 }));
  const res = { body: null, json(payload) { this.body = payload; return this; } };
  await getSignals(req, res);
  assert.equal(req.user, null);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].isBlurred, true);
  assert.equal('target' in res.body[0], false);
  assert.equal('stopLoss' in res.body[0], false);
});
