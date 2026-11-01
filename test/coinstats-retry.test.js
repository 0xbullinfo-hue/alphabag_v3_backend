import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCoinStats } from '../src/services/coinstatsService.js';

test('CoinStats retries rate limits and uses the Retry-After delay', async () => {
  let requests = 0;
  const delays = [];
  const response = await requestCoinStats(
    'https://provider.test/coins',
    {},
    async () => {
      requests += 1;
      if (requests < 3) {
        const error = new Error('rate limited');
        error.response = { status: 429, headers: { 'retry-after': '1' } };
        throw error;
      }
      return { data: ['ok'] };
    },
    async (delay) => delays.push(delay),
  );

  assert.deepEqual(response.data, ['ok']);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test('CoinStats does not retry permanent client errors', async () => {
  let requests = 0;
  await assert.rejects(requestCoinStats(
    'https://provider.test/coins',
    {},
    async () => {
      requests += 1;
      const error = new Error('invalid request');
      error.response = { status: 400, headers: {} };
      throw error;
    },
    async () => assert.fail('permanent errors must not be retried'),
  ), /invalid request/);
  assert.equal(requests, 1);
});

test('CoinStats stops after the bounded retry limit', async () => {
  let requests = 0;
  await assert.rejects(requestCoinStats(
    'https://provider.test/coins',
    {},
    async () => {
      requests += 1;
      const error = new Error('provider unavailable');
      error.response = { status: 503, headers: {} };
      throw error;
    },
    async () => {},
  ), /provider unavailable/);
  assert.equal(requests, 4);
});