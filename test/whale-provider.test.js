import test from 'node:test';
import assert from 'node:assert/strict';
import { getSolanaAddressTransactions } from '../src/controllers/whaleController.js';

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

test('Solana transaction endpoint validates addresses before provider access', async () => {
  const res = createResponse();
  await getSolanaAddressTransactions({ params: { address: 'invalid' } }, res);
  assert.equal(res.statusCode, 400);
});

test('Solana transaction endpoint reports missing provider configuration safely', async () => {
  const originalKey = process.env.MORALIS_API_KEY;
  delete process.env.MORALIS_API_KEY;
  try {
    const res = createResponse();
    await getSolanaAddressTransactions({ params: { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' } }, res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /not configured/i);
  } finally {
    if (originalKey === undefined) delete process.env.MORALIS_API_KEY;
    else process.env.MORALIS_API_KEY = originalKey;
  }
});