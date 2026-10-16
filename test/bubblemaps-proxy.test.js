import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeChain,
  isValidAddress,
  validateBubblemapsParams,
  handleBubblemapsProxyRequest,
} from '../src/routes/bubblemapsProxy.js';
import { memoryCache } from '../src/utils/cache.js';

test('R5: Bubblemaps Proxy & Validation', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.BUBBLEMAPS_API_KEY;

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.BUBBLEMAPS_API_KEY = originalApiKey;
    memoryCache.flushAll();
  });

  await t.test('normalizeChain normalizes supported chains and rejects unsupported', () => {
    assert.equal(normalizeChain('eth'), 'eth');
    assert.equal(normalizeChain('Ethereum'), 'eth');
    assert.equal(normalizeChain('arbi'), 'arbi');
    assert.equal(normalizeChain('arbitrum'), 'arbi');
    assert.equal(normalizeChain('bsc'), 'bsc');
    assert.equal(normalizeChain('binance'), 'bsc');
    assert.equal(normalizeChain('solana'), 'solana');
    assert.equal(normalizeChain('sol'), 'solana');
    assert.equal(normalizeChain('polygon'), 'polygon');
    assert.equal(normalizeChain('base'), 'base');
    assert.equal(normalizeChain('avax'), 'avax');
    assert.equal(normalizeChain('ftm'), 'ftm');
    assert.equal(normalizeChain('cronos'), 'cronos');

    assert.equal(normalizeChain('dogechain'), null);
    assert.equal(normalizeChain(''), null);
    assert.equal(normalizeChain(null), null);
  });

  await t.test('isValidAddress checks EVM and Solana address formats', () => {
    const validEvm = '0x1234567890123456789012345678901234567890';
    const validSolana = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    assert.equal(isValidAddress(validEvm, 'eth'), true);
    assert.equal(isValidAddress(validEvm, 'bsc'), true);
    assert.equal(isValidAddress('0xbad', 'eth'), false);
    assert.equal(isValidAddress(validSolana, 'eth'), false);

    assert.equal(isValidAddress(validSolana, 'solana'), true);
    assert.equal(isValidAddress('short', 'solana'), false);
    assert.equal(isValidAddress(validEvm, 'solana'), false);
  });

  await t.test('validateBubblemapsParams middleware rejects invalid chain or address', () => {
    let status = 0;
    let jsonBody = null;
    let nextCalled = false;

    const mockRes = {
      status(code) { status = code; return this; },
      json(body) { jsonBody = body; return this; }
    };

    // Invalid chain
    validateBubblemapsParams({ params: { chain: 'invalid_chain', address: '0x1234567890123456789012345678901234567890' } }, mockRes, () => { nextCalled = true; });
    assert.equal(status, 400);
    assert.match(jsonBody.error, /unsupported chain/i);

    // Invalid address
    status = 0;
    jsonBody = null;
    validateBubblemapsParams({ params: { chain: 'eth', address: '0xinvalid' } }, mockRes, () => { nextCalled = true; });
    assert.equal(status, 400);
    assert.match(jsonBody.error, /invalid.*address/i);

    // Valid parameters
    status = 0;
    jsonBody = null;
    nextCalled = false;
    validateBubblemapsParams({ params: { chain: 'eth', address: '0x1234567890123456789012345678901234567890' } }, mockRes, () => { nextCalled = true; });
    assert.equal(status, 0);
    assert.equal(nextCalled, true);
  });

  await t.test('handleBubblemapsProxyRequest injects BUBBLEMAPS_API_KEY from server env and forwards request', async () => {
    process.env.BUBBLEMAPS_API_KEY = 'srv_secret_bubblemaps_key_xyz';

    let interceptedHeaders = null;
    let fetchCount = 0;

    globalThis.fetch = async (url, options) => {
      fetchCount++;
      interceptedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ mockMap: true, chain: 'eth' }),
      };
    };

    let status = 0;
    let jsonBody = null;
    const mockRes = {
      status(code) { status = code; return this; },
      json(body) { jsonBody = body; return this; },
    };

    const mockReq = {
      method: 'GET',
      path: '/tokens/map/eth/0x1234567890123456789012345678901234567890',
      query: { limit: '80' },
      body: {},
      params: { chain: 'eth', address: '0x1234567890123456789012345678901234567890' },
    };

    await handleBubblemapsProxyRequest(mockReq, mockRes);

    assert.equal(fetchCount, 1);
    assert.equal(interceptedHeaders['X-ApiKey'], 'srv_secret_bubblemaps_key_xyz');
    assert.deepEqual(jsonBody, { mockMap: true, chain: 'eth' });

    // Second call to same endpoint should hit 5-minute memory cache
    let secondStatus = 0;
    let secondJson = null;
    const secondRes = {
      status(code) { secondStatus = code; return this; },
      json(body) { secondJson = body; return this; },
    };

    await handleBubblemapsProxyRequest(mockReq, secondRes);
    assert.equal(fetchCount, 1, 'Second request should be served from memory cache without upstream fetch');
    assert.deepEqual(secondJson, { mockMap: true, chain: 'eth' });
  });

  await t.test('batch POST requests validate entries and reject oversized payloads', async () => {
    let status = 0;
    let jsonBody = null;
    const mockRes = {
      status(code) { status = code; return this; },
      json(body) { jsonBody = body; return this; },
    };

    const mockReq = {
      method: 'POST',
      path: '/tokens/metadata',
      query: {},
      body: Array(100).fill({ chain: 'eth', address: '0x1234567890123456789012345678901234567890' }),
      params: {},
    };

    await handleBubblemapsProxyRequest(mockReq, mockRes);
    assert.equal(status, 400);
    assert.match(jsonBody.error, /batch.*exceeds/i);
  });
});
