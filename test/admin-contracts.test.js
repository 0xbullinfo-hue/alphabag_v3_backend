import test from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../src/services/storeService.js';
import { getMissionStatus, pauseMission, getStrikeLog } from '../src/controllers/airdropController.js';
import {
    adjustTreasuryBalance,
    approveAllTokenRequests,
    approveTokenRequest,
    markAllPayoutsDone,
    markPayoutDone,
    rejectBulkTokenRequests,
} from '../src/controllers/t2eController.js';

const originalStoreMethods = {
    read: store.read,
    write: store.write,
    findOne: store.findOne,
    update: store.update,
};

const createMockStore = (seed = {}) => {
    const db = structuredClone(seed);

    store.read = async (collection) => structuredClone(db[collection] ?? (collection.includes('config') || collection.includes('settings') ? {} : []));
    store.write = async (collection, data) => {
        db[collection] = structuredClone(data);
    };
    store.findOne = async (collection, query) => {
        const items = db[collection] ?? [];
        if (!Array.isArray(items)) return null;
        return structuredClone(items.find((item) => Object.keys(query).every((key) => item[key] === query[key])) ?? null);
    };
    store.update = async (collection, predicate, updateFn) => {
        const items = db[collection] ?? [];
        if (!Array.isArray(items)) return null;
        const index = items.findIndex(predicate);
        if (index === -1) return null;
        const patch = updateFn(items[index]);
        items[index] = { ...items[index], ...patch };
        db[collection] = items;
        return structuredClone(items[index]);
    };

    return db;
};

const restoreStore = () => {
    store.read = originalStoreMethods.read;
    store.write = originalStoreMethods.write;
    store.findOne = originalStoreMethods.findOne;
    store.update = originalStoreMethods.update;
};

const createRes = () => {
    return {
        statusCode: 200,
        body: undefined,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        send(payload) {
            this.body = payload;
            return this;
        },
    };
};

test.afterEach(() => {
    restoreStore();
});

test('pauseMission and getMissionStatus expose the documented pause lifecycle contract', async () => {
    const db = createMockStore({ missionSettings: {} });

    const pauseRes = createRes();
    await pauseMission({ body: { paused: true } }, pauseRes);

    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.body.success, true);
    assert.equal(pauseRes.body.isPaused, true);
    assert.match(pauseRes.body.message, /PAUSED/i);
    assert.equal(db.missionSettings.isPaused, true);

    const statusRes = createRes();
    await getMissionStatus({}, statusRes);

    assert.deepEqual(statusRes.body.isPaused, true);
    assert.equal(typeof statusRes.body.pausedAt, 'string');
    assert.equal(statusRes.body.tgeDate, null);
});

test('adjustTreasuryBalance returns the updated config contract and persists array-backed config', async () => {
    const db = createMockStore({
        t2e_config: [{ id: 'global_config', minimumClaimBalance: 500, itemsToBagRate: 10 }],
    });

    const res = createRes();
    await adjustTreasuryBalance({ body: { minimumClaimBalance: '750', itemsToBagRate: 12.5, campaignEnded: true } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.config, {
        id: 'global_config',
        minimumClaimBalance: 750,
        itemsToBagRate: 12.5,
        campaignEnded: true,
    });
    assert.deepEqual(db.t2e_config, [res.body.config]);
});

test('approveTokenRequest supports both reject and approve response contracts', async () => {
    let db = createMockStore({
        t2e_payout_requests: [{ id: 'req-1', status: 'PENDING', userId: 'user-1', expectedTokens: 100, walletAddress: '0xabc', createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    const rejectRes = createRes();
    await approveTokenRequest({ params: { id: 'req-1' }, body: { status: 'REJECTED' } }, rejectRes);
    assert.equal(rejectRes.statusCode, 200);
    assert.deepEqual(rejectRes.body, { success: true, message: 'Request rejected' });
    assert.equal(db.t2e_payout_requests[0].status, 'REJECTED');

    db = createMockStore({
        t2e_payout_requests: [{ id: 'req-2', status: 'PENDING', userId: 'user-2', expectedTokens: 200, walletAddress: '0xdef', createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    const approveRes = createRes();
    await approveTokenRequest({ params: { id: 'req-2' }, body: { status: 'APPROVED' } }, approveRes);
    assert.equal(approveRes.statusCode, 200);
    assert.equal(approveRes.body.success, true);
    assert.match(approveRes.body.txHash, /^0x[0-9a-f]+$/i);
    assert.equal(db.t2e_payout_requests[0].status, 'APPROVED');
});

test('markPayoutDone and markAllPayoutsDone expose sent-state success contracts', async () => {
    let db = createMockStore({
        t2e_payout_requests: [{ id: 'req-1', status: 'APPROVED', userId: 'user-1', expectedTokens: 100, walletAddress: '0xabc', createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    const singleRes = createRes();
    await markPayoutDone({ params: { id: 'req-1' }, body: { txReference: 'manual-1' }, user: { id: 'admin-1' } }, singleRes);
    assert.equal(singleRes.statusCode, 200);
    assert.equal(singleRes.body.success, true);
    assert.match(singleRes.body.message, /SENT/i);
    assert.equal(db.t2e_payout_requests[0].status, 'SENT');
    assert.equal(db.t2e_payout_requests[0].txReference, 'manual-1');

    db = createMockStore({
        t2e_payout_requests: [
            { id: 'req-2', status: 'APPROVED', userId: 'user-2', expectedTokens: 100, walletAddress: '0xabc', createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'req-3', status: 'PENDING', userId: 'user-3', expectedTokens: 120, walletAddress: '0xdef', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
    });

    const bulkRes = createRes();
    await markAllPayoutsDone({ body: {}, user: { id: 'admin-2' } }, bulkRes);
    assert.equal(bulkRes.statusCode, 200);
    assert.equal(bulkRes.body.success, true);
    assert.match(bulkRes.body.message, /Marked 1 approved requests as SENT/i);
    assert.equal(db.t2e_payout_requests[0].status, 'SENT');
    assert.equal(db.t2e_payout_requests[0].txReference, 'Bulk Manual Airdrop');
});

test('approveAllTokenRequests, rejectBulkTokenRequests, and getStrikeLog preserve documented admin list behavior', async () => {
    let db = createMockStore({
        t2e_payout_requests: [
            { id: 'req-1', status: 'PENDING', userId: 'user-1', expectedTokens: 10, walletAddress: '0x1', createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'req-2', status: 'PENDING', userId: 'user-2', expectedTokens: 20, walletAddress: '0x2', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
        strike_log: [
            { id: 'log-1', timestamp: '2026-01-01T00:00:00.000Z', reason: 'older' },
            { id: 'log-2', timestamp: '2026-01-02T00:00:00.000Z', reason: 'newer' },
        ],
    });

    const approveAllRes = createRes();
    await approveAllTokenRequests({}, approveAllRes);
    assert.equal(approveAllRes.statusCode, 200);
    assert.equal(approveAllRes.body.success, true);
    assert.match(approveAllRes.body.message, /Approved 2 pending requests/i);
    assert.equal(db.t2e_payout_requests.every((entry) => entry.status === 'APPROVED'), true);

    db = createMockStore({
        t2e_payout_requests: [
            { id: 'req-1', status: 'PENDING', userId: 'user-1', expectedTokens: 10, walletAddress: '0x1', createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'req-2', status: 'APPROVED', userId: 'user-2', expectedTokens: 20, walletAddress: '0x2', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
        strike_log: [
            { id: 'log-1', timestamp: '2026-01-01T00:00:00.000Z', reason: 'older' },
            { id: 'log-2', timestamp: '2026-01-02T00:00:00.000Z', reason: 'newer' },
        ],
    });

    const rejectRes = createRes();
    await rejectBulkTokenRequests({ body: { ids: ['req-1', 'req-2'] } }, rejectRes);
    assert.equal(rejectRes.statusCode, 200);
    assert.equal(rejectRes.body.success, true);
    assert.match(rejectRes.body.message, /Rejected 1 selected requests/i);
    assert.equal(db.t2e_payout_requests[0].status, 'REJECTED');
    assert.equal(db.t2e_payout_requests[1].status, 'APPROVED');

    const strikeRes = createRes();
    await getStrikeLog({}, strikeRes);
    assert.equal(strikeRes.statusCode, 200);
    assert.equal(strikeRes.body[0].id, 'log-2');
    assert.equal(strikeRes.body[1].id, 'log-1');
});
