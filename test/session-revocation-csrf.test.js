import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { verifyToken } from '../src/middleware/authMiddleware.js';
import { csrfProtection } from '../src/middleware/csrfMiddleware.js';
import { logout } from '../src/controllers/authController.js';
import { toggleBanUser } from '../src/controllers/adminController.js';
import { store } from '../src/services/storeService.js';
import { config } from '../src/config/env.js';

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
    cookiesCleared: [],
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
    clearCookie(name, options) {
      this.cookiesCleared.push({ name, options });
      return this;
    },
  };
  return res;
};

test('R6: verifyToken returns 401 when dbRecord is not found (deleted/unregistered user)', async () => {
  const token = jwt.sign(
    { id: 'non-existent-user-id', wallet: '0x1111111111111111111111111111111111111111', tv: 0 },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );

  let nextCalled = false;
  const req = {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
  };
  const res = createMockResponse();

  store.findOne = async () => null;

  try {
    await verifyToken(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /User record not found/i);
    assert.equal(nextCalled, false);
  } finally {
    store.findOne = originalStoreMethods.findOne;
  }
});

test('R6: verifyToken returns 401 when tokenVersion does not match current DB version', async () => {
  const token = jwt.sign(
    { id: 'user-tv-test', wallet: '0x2222222222222222222222222222222222222222', tv: 1 },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );

  let nextCalled = false;
  const req = {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
  };
  const res = createMockResponse();

  store.findOne = async (col) => {
    if (col === 'users') {
      return { id: 'user-tv-test', wallet: '0x2222222222222222222222222222222222222222', tokenVersion: 2, isBanned: false };
    }
    return null;
  };

  try {
    await verifyToken(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /Session has been revoked/i);
    assert.equal(nextCalled, false);
  } finally {
    store.findOne = originalStoreMethods.findOne;
  }
});

test('R6: verifyToken authenticates via alphabag_session HttpOnly cookie', async () => {
  const token = jwt.sign(
    { id: 'user-cookie-test', wallet: '0x3333333333333333333333333333333333333333', tv: 0 },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );

  let nextCalled = false;
  const req = {
    headers: {},
    cookies: { alphabag_session: token },
  };
  const res = createMockResponse();

  store.findOne = async (col) => {
    if (col === 'users') {
      return { id: 'user-cookie-test', wallet: '0x3333333333333333333333333333333333333333', tokenVersion: 0, isBanned: false };
    }
    return null;
  };

  try {
    await verifyToken(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.id, 'user-cookie-test');
  } finally {
    store.findOne = originalStoreMethods.findOne;
  }
});

test('R6: logout increments user tokenVersion and clears alphabag_session cookie', async () => {
  let updatedTv = 0;

  store.findOne = async (col) => {
    if (col === 'users') return { id: 'user-logout-test', tokenVersion: 3 };
    return null;
  };
  store.updateById = async (col, id, fn) => {
    const res = fn({ tokenVersion: 3 });
    updatedTv = res.tokenVersion;
    return res;
  };

  const req = {
    user: { id: 'user-logout-test', wallet: '0x4444444444444444444444444444444444444444' },
  };
  const res = createMockResponse();

  try {
    await logout(req, res);
    assert.equal(updatedTv, 4, 'tokenVersion should be incremented from 3 to 4');
    assert.equal(res.cookiesCleared.length, 1);
    assert.equal(res.cookiesCleared[0].name, 'alphabag_session');
    assert.equal(res.cookiesCleared[0].options.httpOnly, true);
    assert.equal(res.body.success, true);
  } finally {
    store.findOne = originalStoreMethods.findOne;
    store.updateById = originalStoreMethods.updateById;
  }
});

test('R6: toggleBanUser increments tokenVersion to revoke active sessions immediately', async () => {
  let updatedFields = null;

  store.findOne = async () => ({ id: 'user-ban-test', isBanned: false, tokenVersion: 1 });
  store.updateById = async (col, id, fn) => {
    updatedFields = fn({ isBanned: false, tokenVersion: 1 });
    return updatedFields;
  };

  const req = { params: { id: 'user-ban-test' } };
  const res = createMockResponse();

  try {
    await toggleBanUser(req, res);
    assert.equal(updatedFields.isBanned, true);
    assert.equal(updatedFields.tokenVersion, 2);
    assert.equal(res.body.success, true);
    assert.equal(res.body.isBanned, true);
  } finally {
    store.findOne = originalStoreMethods.findOne;
    store.updateById = originalStoreMethods.updateById;
  }
});

test('R6: csrfProtection blocks mutating cookie requests with missing custom header', () => {
  let nextCalled = false;
  const req = {
    method: 'POST',
    cookies: { alphabag_session: 'some-cookie' },
    headers: {
      origin: 'http://localhost:3005',
    },
  };
  const res = createMockResponse();

  csrfProtection(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /CSRF.*Missing custom client header/i);
  assert.equal(nextCalled, false);
});

test('R6: csrfProtection allows mutating cookie requests with X-Requested-With header and valid origin', () => {
  let nextCalled = false;
  const req = {
    method: 'POST',
    cookies: { alphabag_session: 'some-cookie' },
    headers: {
      origin: 'http://localhost:3005',
      'x-requested-with': 'AlphaBAG-Client',
    },
  };
  const res = createMockResponse();

  csrfProtection(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
