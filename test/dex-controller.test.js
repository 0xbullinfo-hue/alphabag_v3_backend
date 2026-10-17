import test from 'node:test';
import assert from 'node:assert/strict';
import { dexController } from '../src/controllers/dexController.js';

const createResponse = () => ({
  statusCode: 200,
  headers: {},
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  set(header, value) {
    this.headers[header] = value;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

test('searchPairs requires non-empty query parameter q', async () => {
  const res = createResponse();
  await dexController.searchPairs({ query: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Query parameter "q" is required');
});

test('getTokenPairs requires valid tokenAddress param', async () => {
  const res = createResponse();
  await dexController.getTokenPairs({ params: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Valid token address required');
});

test('getMultiTokenPairs requires chainId and tokenAddresses', async () => {
  const res = createResponse();
  await dexController.getMultiTokenPairs({ params: { chainId: 'solana' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'chainId and tokenAddresses parameters are required');
});

test('getPairByAddress requires chainId and pairAddress', async () => {
  const res = createResponse();
  await dexController.getPairByAddress({ params: { chainId: 'ethereum' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'chainId and pairAddress parameters are required');
});
