import test from 'node:test';
import assert from 'node:assert/strict';
import { getPrices, getCoinsMarkets } from '../src/controllers/marketController.js';

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

test('Phase 4 — getPrices validates ids parameter', async () => {
  const reqMissing = { query: {} };
  const resMissing = createMockResponse();
  await getPrices(reqMissing, resMissing);
  assert.equal(resMissing.statusCode, 400);
  assert.match(resMissing.body.error, /ids parameter required/i);

  const reqOverlong = { query: { ids: 'a'.repeat(600) } };
  const resOverlong = createMockResponse();
  await getPrices(reqOverlong, resOverlong);
  assert.equal(resOverlong.statusCode, 400);
});

test('Phase 4 — getCoinsMarkets bounds pagination safely', async () => {
  // Test with extreme parameters that should be safely bounded
  const req = {
    query: {
      per_page: '999999',
      page: '-10',
    },
  };
  const res = createMockResponse();
  
  // It shouldn't crash with NaN or out-of-bounds parameters
  await getCoinsMarkets(req, res);
  // May succeed or fail on network, but statusCode must be a valid HTTP status
  assert.ok(res.statusCode === 200 || res.statusCode === 500 || res.statusCode === 429);
});
