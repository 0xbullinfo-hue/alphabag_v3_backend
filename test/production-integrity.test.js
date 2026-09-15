import test from 'node:test';
import assert from 'node:assert/strict';

import { checkProvider, getProviderHealth } from '../src/services/providerHealthService.js';
import { CanonicalPortfolioService } from '../src/services/canonicalPortfolioService.js';
import { store } from '../src/services/storeService.js';
import { getUsers } from '../src/controllers/adminController.js';
import { getServerInfo } from '../src/controllers/cexController.js';
import { findUnsupportedNumbers, buildFacts, validateGrounded } from '../src/utils/guardrails.js';

test('Provider Health returns structured diagnostics without secrets', async () => {
  const result = await checkProvider('gemini');
  assert.ok(result.provider === 'gemini');
  assert.ok(typeof result.status === 'string');
  // Verify no API keys leaked in result
  const json = JSON.stringify(result);
  assert.ok(!json.includes('AIzaSy'));
  assert.ok(!json.includes(process.env.GEMINI_API_KEY || '___NO_KEY___'));
});

test('Provider Health handles unconfigured provider safely without crashing', async () => {
  const original = process.env.COVALENT_API_KEY;
  delete process.env.COVALENT_API_KEY;
  try {
    const result = await checkProvider('covalent');
    assert.equal(result.status, 'UNCONFIGURED');
    assert.equal(result.provider, 'covalent');
  } finally {
    if (original) process.env.COVALENT_API_KEY = original;
  }
});

test('StoreService generates RFC4122 compliant UUIDs instead of Math.random', async () => {
  const originalWrite = store.write;
  try {
    store.write = async () => {};
    const item = { name: 'Test Entity' };
    const created = await store.create('custom_test_collection', item);
    assert.ok(created.id, 'item should have an ID');
    // Verify UUID v4 format: 8-4-4-4-12 hex chars
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(created.id, uuidRegex, 'ID must be a standard UUID, not Math.random');
  } finally {
    store.write = originalWrite;
  }
});

test('Canonical Portfolio computes unified snapshot with valuationStatus and completeness', async () => {
  const mockUser = {
    id: 'user-test-1',
    portfolioWallets: [
      { address: '0x1111111111111111111111111111111111111111', chain: 'ethereum', type: 'manual' },
      { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', chain: 'solana', type: 'manual' },
    ],
  };

  const snapshot = await CanonicalPortfolioService.getSnapshot(mockUser, { force: true });
  assert.ok(snapshot, 'snapshot must be generated');
  assert.equal(snapshot.userId, 'user-test-1');
  assert.ok(typeof snapshot.totalUSD === 'number');
  assert.ok(['VALUED', 'PARTIAL', 'UNAVAILABLE'].includes(snapshot.valuationStatus));
  assert.ok(snapshot.completeness, 'completeness metadata must exist');
  assert.equal(snapshot.completeness.evmWallets, 1);
  assert.equal(snapshot.completeness.solanaWallets, 1);
  assert.ok(Array.isArray(snapshot.dex.tokens));
  assert.ok(Array.isArray(snapshot.solana.tokens));
  assert.ok(Array.isArray(snapshot.cex.balances));
});

test('Missing token price is represented as priceUSD=null and valuationStatus=UNAVAILABLE, not $0', async () => {
  // Test computeSingleDexPortfolio valuation contract
  const result = await CanonicalPortfolioService.computeSingleDexPortfolio('0x0000000000000000000000000000000000000001');
  assert.ok(Array.isArray(result.tokens));
  for (const token of result.tokens) {
    if (token.priceUSD === null) {
      assert.equal(token.valueUSD, null, 'valueUSD must be null when priceUSD is null');
      assert.equal(token.valuationStatus, 'UNAVAILABLE');
    } else {
      assert.equal(token.valuationStatus, 'VALUED');
    }
  }
});

test('CEX Server Info endpoint returns outbound IP configuration and explicit account coverage', async () => {
  let jsonOutput = null;
  const mockRes = {
    json(data) {
      jsonOutput = data;
      return this;
    }
  };
  await getServerInfo({}, mockRes);
  assert.ok(jsonOutput, 'response must be sent');
  assert.ok('outboundIp' in jsonOutput);
  assert.ok(Array.isArray(jsonOutput.supportedAccounts));
  assert.ok(jsonOutput.supportedAccounts.includes('SPOT'));
  assert.ok(jsonOutput.unsupportedAccounts.includes('FUTURES'));
  assert.ok(jsonOutput.unsupportedAccounts.includes('OPTIONS'));
});

test('Admin getUsers supports server-side pagination with page and limit', async () => {
  const originalRead = store.read;
  try {
    const mockUsers = Array.from({ length: 25 }, (_, i) => ({
      id: `user-${i + 1}`,
      email: `user${i + 1}@alphabag.app`,
      tier: i % 2 === 0 ? 'FREE' : 'ULTIMATE',
      createdAt: new Date().toISOString(),
    }));
    store.read = async () => mockUsers;

    let jsonOutput = null;
    const mockRes = {
      json(data) {
        jsonOutput = data;
        return this;
      }
    };

    // Test paginated request: page 2, limit 10
    await getUsers({ query: { page: '2', limit: '10' } }, mockRes);
    assert.ok(jsonOutput.users, 'paginated output should contain users array');
    assert.equal(jsonOutput.users.length, 10);
    assert.equal(jsonOutput.total, 25);
    assert.equal(jsonOutput.page, 2);
    assert.equal(jsonOutput.limit, 10);
    assert.equal(jsonOutput.totalPages, 3);
    assert.equal(jsonOutput.users[0].id, 'user-11');
  } finally {
    store.read = originalRead;
  }
});

test('AI Grounding facts extraction and number verification rejects hallucinated figures', () => {
  const testSnapshot = {
    totalUSD: 5432.10,
    dex: {
      tokens: [
        { symbol: 'ETH', balance: '1.5', valueUSD: 4000 },
        { symbol: 'USDC', balance: '1432.10', valueUSD: 1432.10 },
      ]
    }
  };

  const facts = buildFacts(testSnapshot);
  assert.ok(facts.length > 0, 'facts should be generated');

  // Verify that an answer with hallucinated numbers is flagged
  const hallucinatedAnswer = 'Your portfolio is currently worth $99,999.00 with 150 BTC.';
  const rejected = findUnsupportedNumbers(hallucinatedAnswer, facts);
  assert.ok(rejected.includes('99999.00') || rejected.includes('99999') || rejected.includes('150'), 'invented numbers must be rejected');

  // Verify that legitimate numbers in facts pass
  const accurateAnswer = 'Your portfolio has a total of 5432.10 USD.';
  const accurateRejected = findUnsupportedNumbers(accurateAnswer, facts);
  assert.equal(accurateRejected.length, 0, 'legitimate fact numbers must be allowed');
});

test('Deterministic DeFi position IDs: same user, chain, protocol, position yields identical ID', async () => {
  const { generateDeterministicPositionId } = await import('../src/controllers/defiController.js');
  const id1 = generateDeterministicPositionId('ethereum', '0x1234567890abcdef', 'aave_v3', 'borrow');
  const id2 = generateDeterministicPositionId('ethereum', '0x1234567890abcdef', 'aave_v3', 'borrow');
  const id3 = generateDeterministicPositionId('ethereum', '0x9999999999abcdef', 'aave_v3', 'borrow');

  assert.strictEqual(id1, id2, 'Identical parameters must generate identical position IDs');
  assert.notStrictEqual(id1, id3, 'Different addresses must generate different position IDs');
  assert.ok(id1.startsWith('ethereum:'), 'Position ID must start with chain name');
});

test('DeFi opportunities separate from positions: /api/portfolio/defi does not bundle opportunities', async () => {
  const { getDefiPositions, getDefiOpportunities } = await import('../src/controllers/defiController.js');

  const reqPositions = { user: { id: 'u1' }, query: { address: '0x1111111111111111111111111111111111111111' } };
  let positionsRes = {};
  const resPositions = {
    json: (data) => { positionsRes = data; },
    status: () => resPositions
  };

  await getDefiPositions(reqPositions, resPositions);
  assert.ok(Array.isArray(positionsRes.positions), 'getDefiPositions must return positions array');
  assert.strictEqual(positionsRes.opportunities, undefined, 'getDefiPositions must not bundle opportunities');

  const reqOpp = { query: {} };
  let oppRes = {};
  const resOpp = {
    json: (data) => { oppRes = data; },
    status: () => resOpp
  };

  await getDefiOpportunities(reqOpp, resOpp);
  assert.ok(Array.isArray(oppRes.opportunities), 'getDefiOpportunities must return opportunities array');
});
