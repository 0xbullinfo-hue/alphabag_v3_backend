import test from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../src/services/storeService.js';
import { submitWallet, convertItemsToBag } from '../src/controllers/airdropController.js';
import { claimMission, requestBagPayout } from '../src/controllers/t2eController.js';

const originalStoreMethods = {
    read: store.read,
    write: store.write,
    findOne: store.findOne,
    create: store.create,
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
    store.create = async (collection, item) => {
        const next = db[collection] ?? [];
        const created = {
            ...item,
            createdAt: item.createdAt || new Date().toISOString(),
            id: item.id || `${collection}-${next.length + 1}`,
        };
        next.push(created);
        db[collection] = next;
        return structuredClone(created);
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
    store.create = originalStoreMethods.create;
    store.update = originalStoreMethods.update;
};

const createRes = () => {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
};

test.afterEach(() => {
    restoreStore();
});

test('submitWallet returns contract fields (success, message, bagTokens, items, isFounder)', async () => {
    createMockStore({
        users: [
            { id: 'user-1', email: 'alpha@example.com', airdropSubmitted: false, bagTokens: 0, items: 120 },
            { id: 'other', isFounderAirdrop: true },
        ],
    });

    const req = {
        user: { id: 'user-1' },
        body: {
            bscWallet: '0x1234',
            xLink: 'https://x.com/example',
            reviewComment: 'Great app',
            isFounderRequest: false,
        },
    };
    const res = createRes();

    await submitWallet(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.message, 'string');
    assert.equal(typeof res.body.bagTokens, 'number');
    assert.equal(typeof res.body.items, 'number');
    assert.equal(typeof res.body.isFounder, 'boolean');
});

test('submitWallet requires bscWallet and returns documented 400 error', async () => {
    createMockStore({
        users: [{ id: 'user-1', email: 'alpha@example.com', airdropSubmitted: false, bagTokens: 0 }],
    });

    const req = {
        user: { id: 'user-1' },
        body: {
            xLink: 'https://x.com/example',
            reviewComment: 'Great app',
            isFounderRequest: false,
        },
    };
    const res = createRes();

    await submitWallet(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'BSC Wallet is required');
});

test('convertItemsToBag returns contract fields and zeroes items', async () => {
    const db = createMockStore({
        users: [{ id: 'user-1', items: 100, bagTokens: 10 }],
        t2e_config: [{ id: 'global_config', itemsToBagRate: 2 }],
    });

    const req = { user: { id: 'user-1' } };
    const res = createRes();

    await convertItemsToBag(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.message, 'string');
    assert.equal(res.body.items, 0);
    assert.equal(res.body.bagTokens, 210);
    assert.equal(db.users[0].items, 0);
    assert.equal(db.users[0].bagTokens, 210);
});

test('claimMission returns documented reward payload and updates user item balance', async () => {
    const db = createMockStore({
        users: [{ id: 'user-1', items: 0, lifetimeEarned: 0 }],
        t2e_missions: [{ id: 'mission-1', status: 'ACTIVE', frequency: 'ONCE', rewardTokens: 75, rewardXP: 75, type: 'SOCIAL' }],
        t2e_claims: [],
        t2e_activity: [],
        t2e_config: [{ id: 'global_config', isDeactivated: false }],
    });

    const req = {
        user: { id: 'user-1' },
        body: { missionId: 'mission-1' },
    };
    const res = createRes();

    await claimMission(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.rewardTokens, 75);
    assert.equal(res.body.rewardXP, 75);
    assert.equal(res.body.items, 75);
    assert.match(res.body.message, /Mission completed/i);
    assert.equal(db.users[0].items, 75);
    assert.equal(db.t2e_claims.length, 1);
});

test('claimMission enforces ONCE frequency guard with documented error', async () => {
    createMockStore({
        users: [{ id: 'user-1', items: 0, lifetimeEarned: 0 }],
        t2e_missions: [{ id: 'mission-1', status: 'ACTIVE', frequency: 'ONCE', rewardTokens: 75, rewardXP: 75, type: 'SOCIAL' }],
        t2e_claims: [{ id: 'claim-1', userId: 'user-1', missionId: 'mission-1', rewardTokens: 75, createdAt: new Date().toISOString() }],
        t2e_activity: [],
        t2e_config: [{ id: 'global_config', isDeactivated: false }],
    });

    const req = {
        user: { id: 'user-1' },
        body: { missionId: 'mission-1' },
    };
    const res = createRes();

    await claimMission(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Mission already claimed');
});

test('claimMission enforces DAILY frequency guard with documented error', async () => {
    const nowIso = new Date().toISOString();
    createMockStore({
        users: [{ id: 'user-1', items: 0, lifetimeEarned: 0 }],
        t2e_missions: [{ id: 'mission-daily', status: 'ACTIVE', frequency: 'DAILY', rewardTokens: 40, rewardXP: 40, type: 'SOCIAL' }],
        t2e_claims: [{ id: 'claim-1', userId: 'user-1', missionId: 'mission-daily', rewardTokens: 40, createdAt: nowIso }],
        t2e_activity: [],
        t2e_config: [{ id: 'global_config', isDeactivated: false }],
    });

    const req = {
        user: { id: 'user-1' },
        body: { missionId: 'mission-daily' },
    };
    const res = createRes();

    await claimMission(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Daily mission already completed. Come back in 24 hours.');
});

test('requestBagPayout returns success contract and creates request entry', async () => {
    const db = createMockStore({
        users: [{ id: 'user-1', items: 900, preferredWallet: '0xabc' }],
        t2e_config: [{ id: 'global_config', minimumClaimBalance: 500 }],
        t2e_payout_requests: [],
    });

    const req = { user: { id: 'user-1' } };
    const res = createRes();

    await requestBagPayout(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.message, 'string');
    assert.equal(typeof res.body.requestId, 'string');
    assert.equal(db.t2e_payout_requests.length, 1);
    assert.equal(db.t2e_payout_requests[0].expectedTokens, 900);
    assert.equal(db.users[0].items, 0);
});

test('requestBagPayout enforces minimum balance guard with documented error', async () => {
    createMockStore({
        users: [{ id: 'user-1', items: 300, preferredWallet: '0xabc' }],
        t2e_config: [{ id: 'global_config', minimumClaimBalance: 500 }],
        t2e_payout_requests: [],
    });

    const req = { user: { id: 'user-1' } };
    const res = createRes();

    await requestBagPayout(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Minimum payout of 500 ITEMS required.');
});
