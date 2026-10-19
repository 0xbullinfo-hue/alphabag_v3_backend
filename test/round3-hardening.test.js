import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { collectEnvErrors } from '../src/config/env.js';
import { csrfProtection, toOrigin } from '../src/middleware/csrfMiddleware.js';
import { dexController } from '../src/controllers/dexController.js';
import communityRoutes from '../src/routes/communityRoutes.js';
import {
  createDiscussion,
  voteDiscussion,
  toggleInsightful,
  addComment,
  getDiscussions,
  getTrendingTopics,
  getTopAnalysts,
  getPodcast,
  startPodcastSpace,
  sendPodcastChat,
} from '../src/controllers/communityController.js';

const GOOD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
  JWT_SECRET: 'a'.repeat(48),
  CEX_ENCRYPTION_KEY: 'ab'.repeat(32),
  FRONTEND_URL: 'https://app.alphabag.xyz',
  ADMIN_PORTAL_KEY: 'portal-key-placeholder',
  BAG_TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111',
  TREASURY_WALLET: '0x2222222222222222222222222222222222222222',
};

const createResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  set() { return this; },
  json(payload) { this.body = payload; return this; },
});

const reqFor = (id, extra = {}) => ({
  user: { id },
  dbUser: { id, tier: 'PREMIUM', verifiedWallet: '0x1234567890abcdef1234567890abcdef12345678' },
  params: {},
  body: {},
  ...extra,
});

// ---------- env ----------
test('BAG_TOKEN_DECIMALS must be an integer between 0 and 36', () => {
  assert.deepEqual(collectEnvErrors({ ...GOOD_ENV, BAG_TOKEN_DECIMALS: '18' }), []);
  assert.ok(collectEnvErrors({ ...GOOD_ENV, BAG_TOKEN_DECIMALS: '99' }).some((e) => e.includes('BAG_TOKEN_DECIMALS')));
  assert.ok(collectEnvErrors({ ...GOOD_ENV, BAG_TOKEN_DECIMALS: 'abc' }).some((e) => e.includes('BAG_TOKEN_DECIMALS')));
});

// ---------- csrf ----------
const runCsrf = (reqPatch, frontendUrl) => {
  const res = createResponse();
  let nextCalled = false;
  const req = {
    method: 'POST',
    cookies: { alphabag_session: 'x' },
    headers: { 'x-requested-with': 'alphabag' },
    ...reqPatch,
  };
  csrfProtection(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
};

test('toOrigin normalises trailing slashes and rejects garbage', () => {
  assert.equal(toOrigin('https://app.alphabag.xyz/'), 'https://app.alphabag.xyz');
  assert.equal(toOrigin('https://app.alphabag.xyz/some/path'), 'https://app.alphabag.xyz');
  assert.equal(toOrigin('not a url'), null);
  assert.equal(toOrigin(undefined), null);
});

test('CSRF: cookie-authenticated POST without Origin/Referer is rejected', () => {
  const { res, nextCalled } = runCsrf({ headers: { 'x-requested-with': 'alphabag' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('CSRF: malformed Referer does not throw and is rejected', () => {
  const { res, nextCalled } = runCsrf({ headers: { referer: '::::bad', 'x-requested-with': 'alphabag' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('CSRF: requests without a session cookie and GET requests are untouched', () => {
  assert.equal(runCsrf({ cookies: {} }).nextCalled, true);
  assert.equal(runCsrf({ method: 'GET' }).nextCalled, true);
});

// ---------- dex validation ----------
test('Dex endpoints reject path-traversal and malformed parameters', async () => {
  let res = createResponse();
  await dexController.getPairByAddress({ params: { chainId: '../admin', pairAddress: '0x' + 'a'.repeat(40) } }, res);
  assert.equal(res.statusCode, 400);

  res = createResponse();
  await dexController.getPairByAddress({ params: { chainId: 'bsc', pairAddress: '0xabc/../../x' } }, res);
  assert.equal(res.statusCode, 400);

  res = createResponse();
  await dexController.getTokenPairs({ params: { tokenAddress: '..%2f..%2fsecret' } }, res);
  assert.equal(res.statusCode, 400);

  res = createResponse();
  const tooMany = Array.from({ length: 31 }, (_, i) => '0x' + String(i).padStart(40, '1')).join(',');
  await dexController.getMultiTokenPairs({ params: { chainId: 'bsc', tokenAddresses: tooMany } }, res);
  assert.equal(res.statusCode, 400);

  res = createResponse();
  await dexController.searchPairs({ query: { q: 'a'.repeat(200) } }, res);
  assert.equal(res.statusCode, 400);
});

// ---------- community: auth gate ----------
test('Community routes require authentication (no anonymous reads or writes)', async () => {
  const dispatch = (method, url, body) => new Promise((resolve, reject) => {
    const res = createResponse();
    const origJson = res.json.bind(res);
    res.json = (payload) => { origJson(payload); resolve(res); return res; };
    res.setHeader = () => res;
    res.getHeader = () => undefined;
    const req = { method, url, originalUrl: url, headers: {}, cookies: {}, body, query: {}, params: {}, get: () => undefined };
    communityRoutes.handle(req, res, (err) => reject(err || new Error('request passed the auth gate')));
  });

  assert.equal((await dispatch('GET', '/discussions')).statusCode, 401);
  const post = await dispatch('POST', '/discussions', { title: 'x', content: 'y', authorTier: 'ULTIMATE', authorWallet: '0xdead' });
  assert.equal(post.statusCode, 401);
});

// ---------- community: behaviour ----------
test('Community: identity comes from the database user, never from the request body', async () => {
  const res = createResponse();
  await createDiscussion(reqFor('u-1', {
    body: { title: 'Real post', content: 'Body', ticker: 'bag', authorTier: 'ULTIMATE', authorWallet: '0xdeadbeef', isPro: true, tokenMetrics: { marketCap: '$1T' } },
  }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.authorTier, 'PREMIUM');
  assert.equal(res.body.authorWallet, '0x1234...5678');
  assert.equal(res.body.ticker, '$BAG');
  assert.equal(res.body.tokenMetrics, undefined);
  assert.equal(res.body.upvotes, 0);
});

test('Community: validation rejects empty, oversized and malformed input', async () => {
  let res = createResponse();
  await createDiscussion(reqFor('u-1', { body: { title: '', content: 'x' } }), res);
  assert.equal(res.statusCode, 400);

  res = createResponse();
  await createDiscussion(reqFor('u-1', { body: { title: 't', content: 'c', ticker: '$BAD TICKER!' } }), res);
  assert.equal(res.statusCode, 400);

  res = createResponse();
  await createDiscussion(reqFor('u-1', { body: { title: 'T'.repeat(500), content: 'C'.repeat(9000) } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.title.length, 140);
  assert.equal(res.body.content.length, 5000);
});

test('Community: votes are one per user, reversible, and insightful is per user', async () => {
  const created = createResponse();
  await createDiscussion(reqFor('author', { body: { title: 'Vote me', content: 'c', category: 'DEFI', sentiment: 'BULLISH', ticker: 'VOTE' } }), created);
  const id = created.body.id;

  const vote = async (userId, type) => {
    const res = createResponse();
    await voteDiscussion(reqFor(userId, { params: { id }, body: { type } }), res);
    return res;
  };

  assert.equal((await vote('a', 'UP')).body.upvotes, 1);
  assert.equal((await vote('a', 'UP')).body.upvotes, 0, 'second identical vote removes it');
  assert.equal((await vote('a', 'UP')).body.upvotes, 1);
  const flipped = await vote('a', 'DOWN');
  assert.equal(flipped.body.upvotes, 0);
  assert.equal(flipped.body.downvotes, 1);
  assert.equal((await vote('b', 'UP')).body.upvotes, 1);
  assert.equal((await vote('c', 'SIDEWAYS')).statusCode, 400);

  const i1 = createResponse();
  await toggleInsightful(reqFor('a', { params: { id } }), i1);
  const i2 = createResponse();
  await toggleInsightful(reqFor('b', { params: { id } }), i2);
  assert.equal(i2.body.insightfulCount, 2);

  const list = createResponse();
  await getDiscussions(reqFor('a'), list);
  const mine = list.body.find((d) => d.id === id);
  assert.equal(mine.userVoted, 'DOWN');
  assert.equal(mine.isInsightful, true);
});

test('Community: comments are bounded and identity-bound', async () => {
  const created = createResponse();
  await createDiscussion(reqFor('author', { body: { title: 'Comments', content: 'c' } }), created);
  const res = createResponse();
  await addComment(reqFor('u-2', { params: { id: created.body.id }, body: { content: 'x'.repeat(3000), authorTier: 'ULTIMATE' } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.content.length, 1000);
  assert.equal(res.body.authorTier, 'PREMIUM');
});

test('Community: trending and analysts are computed from real posts, not fabricated', async () => {
  const trending = createResponse();
  await getTrendingTopics({}, trending);
  assert.ok(Array.isArray(trending.body));
  assert.ok(!trending.body.some((t) => t.ticker === '$RENDER' || t.ticker === '$PEPE'), 'no seeded fake topics');

  const analysts = createResponse();
  await getTopAnalysts({}, analysts);
  assert.ok(!analysts.body.some((a) => a.score === '94.1%' || a.wallet === '0x99B...E311'), 'no seeded fake analysts');
});

test('Community: podcast hosting needs a high tier and starts with no fabricated listeners', async () => {
  const before = createResponse();
  await getPodcast(reqFor('listener'), before);
  assert.equal(before.body.isLive, false);
  assert.equal(before.body.listenersCount, 0);

  let res = createResponse();
  await startPodcastSpace(reqFor('p-1', { body: { title: 'T', topic: 'X' } }), res);
  assert.equal(res.statusCode, 403, 'PREMIUM cannot host');

  res = createResponse();
  const ultimate = reqFor('host-1', { body: { title: 'Live', topic: 'Topic', hostWallet: '0xspoofed' } });
  ultimate.dbUser.tier = 'ULTIMATE';
  await startPodcastSpace(ultimate, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.hostWallet, '0x1234...5678');

  res = createResponse();
  await sendPodcastChat(reqFor('listener', { body: { message: 'hello', tier: 'ULTIMATE', isVip: true } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.tier, 'PREMIUM');
  assert.equal(res.body.isVip, false);
});
