import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDexScreener } from '../src/controllers/dexController.js';

test('DexScreener retries 429 responses and honors Retry-After', async () => {
  let requests = 0;
  const delays = [];
  const response = await requestDexScreener(
    'https://provider.test/search',
    {},
    async () => {
      requests += 1;
      if (requests === 1) {
        const error = new Error('rate limited');
        error.response = { status: 429, headers: { 'retry-after': '2' } };
        throw error;
      }
      return { data: { pairs: [] } };
    },
    async (delay) => delays.push(delay),
  );

  assert.deepEqual(response.data, { pairs: [] });
  assert.equal(requests, 2);
  assert.deepEqual(delays, [2000]);
});

test('DexScreener does not retry non-transient client errors', async () => {
  let requests = 0;
  await assert.rejects(requestDexScreener(
    'https://provider.test/search',
    {},
    async () => {
      requests += 1;
      const error = new Error('bad request');
      error.response = { status: 400, headers: {} };
      throw error;
    },
    async () => assert.fail('permanent errors must not be retried'),
  ), /bad request/);
  assert.equal(requests, 1);
});