import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config/env.js';
import { store } from '../src/services/storeService.js';
import { CanonicalPortfolioService } from '../src/services/canonicalPortfolioService.js';
import { verifyToken } from '../src/middleware/authMiddleware.js';
import { streamPortfolio } from '../src/controllers/portfolioController.js';
import { streamRouter } from '../src/routes/serviceRoutes.js';

const originalFindOne = store.findOne;
const originalSnapshot = CanonicalPortfolioService.getSnapshot;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let timers;
let user;

function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.chunks = [];
  res.ended = false;
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.flushHeaders = () => {};
  res.write = (chunk) => { res.chunks.push(chunk); return true; };
  res.end = () => { res.ended = true; res.emit('finish'); };
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function token(tv = 1) {
  return jwt.sign({ id: 'sse-user', wallet: user.wallet, tier: 'ULTIMATE', tv }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '1h' });
}

async function authorize(req, res) {
  let called = false;
  await verifyToken(req, res, () => { called = true; });
  return called;
}

test.beforeEach(() => {
  timers = [];
  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => { if (timer) timer.cleared = true; };
  user = { id: 'sse-user', wallet: '0x2222222222222222222222222222222222222222', tier: 'FREE', tokenVersion: 1, isBanned: false };
  store.findOne = async (collection, query) => {
    if (collection === 'users' && user && (query.id === user.id || query.wallet === user.wallet)) return structuredClone(user);
    if (collection === 'admins') return null;
    return null;
  };
  CanonicalPortfolioService.getSnapshot = async (principal) => {
    assert.equal(principal.tier, user.tier);
    return { totalUSD: 42, valuationStatus: 'VALUED', complete: true, dex: { tokens: [] }, solana: {}, cex: { balances: [], totalUSD: 0 } };
  };
});

test.afterEach(() => {
  store.findOne = originalFindOne;
  CanonicalPortfolioService.getSnapshot = originalSnapshot;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

test('SSE authenticates header, uses current principal, and preserves portfolio event envelope', async () => {
  const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
  const res = response();
  assert.equal(await authorize(req, res), true);
  assert.equal(req.user.tier, 'FREE');
  await streamPortfolio(req, res);
  const event = JSON.parse(res.chunks.find((chunk) => chunk.startsWith('data: ')).slice(6));
  assert.equal(event.type, 'portfolio');
  assert.equal(event.totalUSD, 42);
  for (const field of ['timestamp', 'valuationStatus', 'complete', 'balances', 'tokens', 'solana', 'cexBalances', 'cexTotalUSD']) assert.ok(field in event);
  assert.equal(timers.find((timer) => timer.ms === 25000)?.ms, 25000);
  req.emit('close');
  assert.equal(res.ended, true);
  assert.ok(timers.every((timer) => timer.cleared));
});

test('missing header and query-only token are rejected before SSE starts', async () => {
  for (const req of [
    Object.assign(new EventEmitter(), { headers: {}, query: {} }),
    Object.assign(new EventEmitter(), { headers: {}, query: { token: token() } }),
  ]) {
    const res = response();
    assert.equal(await authorize(req, res), false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['Content-Type'], undefined);
  }
});

test('revoked and banned credentials are rejected before SSE headers are written', async (t) => {
  for (const state of ['revoked', 'banned']) {
    await t.test(state, async () => {
      const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
      if (state === 'revoked') user.tokenVersion++;
      if (state === 'banned') user.isBanned = true;
      const res = response();
      assert.equal(await authorize(req, res), false);
      assert.equal(res.statusCode, state === 'revoked' ? 401 : 403);
      assert.equal(res.headers['Content-Type'], undefined);
      assert.deepEqual(res.chunks, []);
    });
  }
});

test('invalid header cannot be rescued by query token', async () => {
  const req = Object.assign(new EventEmitter(), { headers: { authorization: 'Bearer invalid' }, query: { token: token() } });
  const res = response();
  assert.equal(await authorize(req, res), false);
  assert.equal(res.statusCode, 401);
});

test('mounted streamRouter rejects query token and streams a valid Authorization token', async (t) => {
  const app = express();
  app.use('/api/stream', streamRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const queryOnly = await fetch(`${origin}/api/stream/portfolio?token=${encodeURIComponent(token())}`);
  assert.equal(queryOnly.status, 401);
  assert.notEqual(queryOnly.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  await queryOnly.body?.cancel();

  const streamResponse = await fetch(`${origin}/api/stream/portfolio`, {
    headers: { authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get('content-type'), 'text/event-stream');
  const reader = streamResponse.body.getReader();
  let received = '';
  while (!received.includes('data: ')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += new TextDecoder().decode(value);
  }
  const line = received.split('\n').find((part) => part.startsWith('data: '));
  assert.equal(JSON.parse(line.slice(6)).type, 'portfolio');
  await reader.cancel();
});

test('revoked, banned, or deleted active session emits terminal auth-expired and cleans up', async (t) => {
  for (const state of ['revoked', 'banned', 'deleted']) {
    await t.test(state, async () => {
      const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
      const res = response();
      assert.equal(await authorize(req, res), true);
      await streamPortfolio(req, res);
      assert.ok(res.chunks.some((chunk) => chunk.startsWith('data: ')));
      if (state === 'revoked') user.tokenVersion++;
      if (state === 'banned') user.isBanned = true;
      if (state === 'deleted') user = null;
      await timers.find((timer) => timer.ms === 25000).fn();
      assert.ok(res.chunks.includes('event: auth-expired\ndata: {}\n\n'));
      assert.equal(res.ended, true);
      assert.ok(timers.every((timer) => timer.cleared));
    });
  }
});

test('slow revalidation/snapshot cannot overlap and disconnect prevents later work', async () => {
  let release;
  let snapshotCalls = 0;
  let snapshotStartedResolve;
  const snapshotStarted = new Promise((resolve) => { snapshotStartedResolve = resolve; });
  CanonicalPortfolioService.getSnapshot = async () => ({ totalUSD: 1, valuationStatus: 'VALUED', complete: true, dex: { tokens: [] }, solana: {}, cex: { balances: [], totalUSD: 0 } });
  const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
  const res = response();
  assert.equal(await authorize(req, res), true);
  await streamPortfolio(req, res);
  CanonicalPortfolioService.getSnapshot = async () => {
    snapshotCalls++;
    snapshotStartedResolve();
    await new Promise((resolve) => { release = resolve; });
    return { totalUSD: 1, valuationStatus: 'VALUED', complete: true, dex: { tokens: [] }, solana: {}, cex: { balances: [], totalUSD: 0 } };
  };
  const periodic = timers.find((timer) => timer.ms === 25000);
  assert.ok(periodic);
  const concurrent = periodic.fn();
  await snapshotStarted;
  assert.equal(snapshotCalls, 1);
  await periodic.fn();
  assert.equal(snapshotCalls, 1);
  req.emit('close');
  release();
  await concurrent;
  assert.equal(snapshotCalls, 1);
  assert.ok(timers.every((timer) => timer.cleared));
});

test('response close, error, and finish each clear both timers idempotently', async (t) => {
  for (const event of ['close', 'error', 'finish']) {
    await t.test(event, async () => {
      const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
      const res = response();
      assert.equal(await authorize(req, res), true);
      await streamPortfolio(req, res);
      const intervals = timers.filter((timer) => timer.ms === 25000 || timer.ms === 15000);
      assert.equal(intervals.length, 2);
      res.emit(event, new Error('test close'));
      const chunkCount = res.chunks.length;
      assert.ok(intervals.every((timer) => timer.cleared));
      assert.equal(res.ended, true);
      assert.equal(res.chunks.length, chunkCount);
    });
  }
});

test('revalidation and snapshot errors do not expose internals or stale portfolio data', async (t) => {
  await t.test('revalidation error prevents another snapshot', async () => {
    let snapshots = 0;
    const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
    const res = response();
    assert.equal(await authorize(req, res), true);
    await streamPortfolio(req, res);
    const initialDataEvents = res.chunks.filter((chunk) => chunk.startsWith('data: ')).length;
    CanonicalPortfolioService.getSnapshot = async () => { snapshots++; throw new Error('private portfolio payload'); };
    store.findOne = async () => { throw new Error('database secret'); };
    await timers.find((timer) => timer.ms === 25000).fn();
    assert.equal(snapshots, 0);
    const latest = res.chunks.at(-1);
    assert.ok(latest.includes('Portfolio sync hiccup'));
    assert.ok(!latest.includes('database secret'));
    assert.ok(!latest.includes('private portfolio payload'));
    assert.equal(res.chunks.filter((chunk) => chunk.startsWith('data: ')).length, initialDataEvents + 1);
    req.emit('close');
  });

  await t.test('snapshot failure emits generic non-sensitive handling', async () => {
    CanonicalPortfolioService.getSnapshot = async () => { throw new Error('sensitive wallet balances'); };
    const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
    const res = response();
    assert.equal(await authorize(req, res), true);
    await streamPortfolio(req, res);
    const event = res.chunks.find((chunk) => chunk.startsWith('data: '));
    assert.ok(event.includes('Portfolio sync hiccup'));
    assert.ok(!event.includes('sensitive wallet balances'));
    req.emit('close');
  });
});

test('tier-only DB change leaves stream open and next snapshot receives fresh tier', async () => {
  const tiers = [];
  CanonicalPortfolioService.getSnapshot = async (principal) => {
    tiers.push(principal.tier);
    return { totalUSD: 42, valuationStatus: 'VALUED', complete: true, dex: { tokens: [] }, solana: {}, cex: { balances: [], totalUSD: 0 } };
  };
  const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token()}` }, query: {} });
  const res = response();
  assert.equal(await authorize(req, res), true);
  await streamPortfolio(req, res);
  assert.deepEqual(tiers, ['FREE']);
  user.tier = 'ULTIMATE';
  await timers.find((timer) => timer.ms === 25000).fn();
  assert.deepEqual(tiers, ['FREE', 'ULTIMATE']);
  assert.equal(res.ended, false);
  req.emit('close');
});
