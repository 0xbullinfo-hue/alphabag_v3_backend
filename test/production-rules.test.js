// test/production-rules.test.js
// Verifies production-mode rules (R2):
// 1. Static check: No controller calls store.write on a Prisma-mapped collection
// 2. Runtime check under NODE_ENV=production: Admin CRUD handlers execute cleanly without throwing store.write collection rewrite errors.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const controllersDir = path.join(__dirname, '../src/controllers');

// Prisma-mapped collections from storeService.js
const MAPPED_COLLECTIONS = new Set([
  'users',
  'news',
  'signals',
  'airdrop',
  't2e_missions',
  't2e_claims',
  't2e_activity',
  't2e_payout_requests',
  'tasks',
  'user_submitted_pairs',
  'projects',
  'admins',
  'cex_connections',
  'whale_follows',
  'trades'
]);

test('R2 Static Check: Controllers must not call store.write on Prisma-mapped collections', () => {
  const controllerFiles = fs.readdirSync(controllersDir).filter(f => f.endsWith('.js'));
  const violations = [];

  for (const file of controllerFiles) {
    const fullPath = path.join(controllersDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    // Regex to match store.write('collectionName' or store.write("collectionName"
    const regex = /store\.write\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const collection = match[1];
      if (MAPPED_COLLECTIONS.has(collection)) {
        violations.push({
          file,
          collection,
          line: content.substring(0, match.index).split('\n').length
        });
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found store.write calls on mapped collections in production controllers: ${JSON.stringify(violations, null, 2)}`
  );
});

test('R2 Runtime Check: Admin CRUD handlers succeed under NODE_ENV=production against mocked prisma', async () => {
  // Ensure NODE_ENV is set to production
  process.env.NODE_ENV = 'production';

  const { store, prisma } = await import('../src/services/storeService.js');
  const adminController = await import('../src/controllers/adminController.js');
  const airdropController = await import('../src/controllers/airdropController.js');
  const t2eController = await import('../src/controllers/t2eController.js');

  // Mock res object helper
  const mockRes = () => {
    const res = {
      statusCode: 200,
      jsonData: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonData = data;
        return this;
      }
    };
    return res;
  };

  // Mock store.findOne to return dummy records
  const origFindOne = store.findOne;
  store.findOne = async (coll, query) => {
    return { id: query.id || 'test-id', status: 'ACTIVE', userId: 'user-1', expectedTokens: 100 };
  };

  // Mock prisma models used in admin CRUD
  const origSignalUpdate = prisma.signal.update;
  const origAirdropCreate = prisma.airdropCampaign.create;
  const origAirdropUpdate = prisma.airdropCampaign.update;
  const origAirdropDelete = prisma.airdropCampaign.delete;
  const origTaskUpsert = prisma.task.upsert;
  const origTaskDelete = prisma.task.delete;
  const origMissionUpsert = prisma.t2EMission.upsert;
  const origMissionDelete = prisma.t2EMission.delete;
  const origPayoutUpdateMany = prisma.t2EPayoutRequest.updateMany;
  const origTx = prisma.$transaction;

  try {
    prisma.signal.update = async ({ where, data }) => ({ id: where.id, ...data });
    prisma.airdropCampaign.create = async ({ data }) => ({ ...data });
    prisma.airdropCampaign.update = async ({ where, data }) => ({ id: where.id, ...data });
    prisma.airdropCampaign.delete = async ({ where }) => ({ id: where.id });
    prisma.task.upsert = async ({ where, update }) => ({ id: where.id, ...update });
    prisma.task.delete = async ({ where }) => ({ id: where.id });
    prisma.t2EMission.upsert = async ({ where, update }) => ({ id: where.id, ...update });
    prisma.t2EMission.delete = async ({ where }) => ({ id: where.id });
    prisma.t2EPayoutRequest.updateMany = async () => ({ count: 5 });
    prisma.$transaction = async (fn) => {
      const mockTx = {
        t2EPayoutRequest: {
          findMany: async () => [{ id: 'req-1', userId: 'u1', expectedTokens: 50, status: 'PENDING' }],
          updateMany: async () => ({ count: 1 })
        },
        user: {
          update: async () => ({ id: 'u1' })
        }
      };
      return fn(mockTx);
    };

    // 1. updateSignal
    const resSignal = mockRes();
    await adminController.updateSignal({ params: { id: 'sig-1' }, body: { status: 'ACTIVE' } }, resSignal);
    assert.equal(resSignal.statusCode, 200);
    assert.equal(resSignal.jsonData.success, true);

    // 2. airdrop CRUD
    const resCampCreate = mockRes();
    await airdropController.createCampaign({ body: { tokenTicker: 'BAG', pointsPerClaim: 100 } }, resCampCreate);
    assert.equal(resCampCreate.statusCode, 200);
    assert.equal(resCampCreate.jsonData.success, true);

    const resCampUpdate = mockRes();
    await airdropController.updateCampaign({ params: { id: 'c1' }, body: { status: 'ACTIVE' } }, resCampUpdate);
    assert.equal(resCampUpdate.statusCode, 200);
    assert.equal(resCampUpdate.jsonData.success, true);

    const resCampDelete = mockRes();
    await airdropController.deleteCampaign({ params: { id: 'c1' } }, resCampDelete);
    assert.equal(resCampDelete.statusCode, 200);
    assert.equal(resCampDelete.jsonData.success, true);

    // 3. tasks CRUD
    const resTaskUpsert = mockRes();
    await airdropController.upsertTask({ body: { id: 'task-1', title: 'Follow X' } }, resTaskUpsert);
    assert.equal(resTaskUpsert.statusCode, 200);
    assert.equal(resTaskUpsert.jsonData.success, true);

    const resTaskDelete = mockRes();
    await airdropController.deleteTask({ params: { id: 'task-1' } }, resTaskDelete);
    assert.equal(resTaskDelete.statusCode, 200);
    assert.equal(resTaskDelete.jsonData.success, true);

    // 4. t2e missions CRUD
    const resMissionUpsert = mockRes();
    await t2eController.upsertMission({ body: { id: 'm1', title: 'Join TG', rewardTokens: 50 } }, resMissionUpsert);
    assert.equal(resMissionUpsert.statusCode, 200);
    assert.equal(resMissionUpsert.jsonData.success, true);

    const resMissionDelete = mockRes();
    await t2eController.deleteMission({ params: { id: 'm1' } }, resMissionDelete);
    assert.equal(resMissionDelete.statusCode, 200);
    assert.equal(resMissionDelete.jsonData.success, true);

    // 5. markAllPayoutsDone & rejectBulkTokenRequests
    const resPayoutsDone = mockRes();
    await t2eController.markAllPayoutsDone({ body: { txReference: '0x123' }, user: { id: 'admin' } }, resPayoutsDone);
    assert.equal(resPayoutsDone.statusCode, 200);
    assert.equal(resPayoutsDone.jsonData.success, true);

    const resBulkReject = mockRes();
    await t2eController.rejectBulkTokenRequests({ body: { ids: ['req-1'] } }, resBulkReject);
    assert.equal(resBulkReject.statusCode, 200);
    assert.equal(resBulkReject.jsonData.success, true);

  } finally {
    // Restore mocks
    store.findOne = origFindOne;
    prisma.signal.update = origSignalUpdate;
    prisma.airdropCampaign.create = origAirdropCreate;
    prisma.airdropCampaign.update = origAirdropUpdate;
    prisma.airdropCampaign.delete = origAirdropDelete;
    prisma.task.upsert = origTaskUpsert;
    prisma.task.delete = origTaskDelete;
    prisma.t2EMission.upsert = origMissionUpsert;
    prisma.t2EMission.delete = origMissionDelete;
    prisma.t2EPayoutRequest.updateMany = origPayoutUpdateMany;
    prisma.$transaction = origTx;
  }
});
