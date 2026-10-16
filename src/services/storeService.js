import crypto from 'crypto';
import pkg from '@prisma/client';
const { PrismaClient, Prisma } = pkg;
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import { isDev } from '../config/env.js';

dotenv.config();

export class StoreUnavailableError extends Error {
    constructor(message = 'Database service is currently unavailable') {
        super(message);
        this.name = 'StoreUnavailableError';
        this.statusCode = 503;
        this.status = 503;
    }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });

const collectionToModelMap = {
    'users': 'user',
    'news': 'news',
    'signals': 'signal',
    'airdrop': 'airdropCampaign',
    't2e_missions': 't2EMission',
    't2e_claims': 't2EClaim',
    't2e_activity': 't2EActivity',
    't2e_payout_requests': 't2EPayoutRequest',
    'tasks': 'task',
    'user_submitted_pairs': 'userSubmittedPair',
    'projects': 'project',
    'admins': 'admin',
    'cex_connections': 'cexConnection',
    'whale_follows': 'whaleFollow',
    'trades': 'trade',
    'payout_tx_claims': 'payoutTxClaim'
};

const memStore = new Map();
const modelFieldsMap = {};
if (Prisma && Prisma.dmmf && Prisma.dmmf.datamodel && Prisma.dmmf.datamodel.models) {
    for (const model of Prisma.dmmf.datamodel.models) {
        const scalarFields = model.fields
            .filter(f => f.kind === 'scalar')
            .map(f => f.name);
        modelFieldsMap[model.name.toLowerCase()] = new Set(scalarFields);
    }
}

function sanitizeData(modelName, data) {
    if (!data || typeof data !== 'object') return data;
    const modelKey = modelName.toLowerCase();
    const allowedFields = modelFieldsMap[modelKey];
    if (!allowedFields) return data;

    const sanitized = {};
    for (const key of Object.keys(data)) {
        if (allowedFields.has(key)) {
            sanitized[key] = data[key];
        }
    }
    return sanitized;
}

class StoreService {
    constructor() {
        this.mutex = Promise.resolve();
    }

    async init() {
        try {
            await prisma.$connect();
            console.log("StoreService: Connected to PostgreSQL database via Prisma.");
        } catch (err) {
            console.error("StoreService: Failed to connect to database", err);
            throw err;
        }
    }

    // Atomic Lock to maintain serialization in memory
    async lock(fn) {
        let release;
        const lockPromise = new Promise(resolve => release = resolve);
        const previousLock = this.mutex;
        this.mutex = previousLock.then(() => lockPromise);

        try {
            await previousLock;
            return await fn();
        } finally {
            release();
        }
    }

    async read(collection) {
        const modelName = collectionToModelMap[collection];
        if (modelName) {
            try {
                return await prisma[modelName].findMany();
            } catch (error) {
                if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                    if (isDev) return memStore.get(collection) || [];
                    throw new StoreUnavailableError(`Database connection failed while reading collection ${collection}`);
                }
                console.error(`StoreService: Failed to read collection ${collection}:`, error);
                throw error;
            }
        } else {
            // Fallback: Read from system_configs table
            try {
                const config = await prisma.systemConfig.findUnique({
                    where: { key: collection }
                });
                if (!config) {
                    return collection.includes('config') || collection.includes('settings') ? {} : [];
                }
                return config.value;
            } catch (error) {
                if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                    if (isDev) return collection.includes('config') || collection.includes('settings') ? {} : [];
                    throw new StoreUnavailableError(`Database connection failed while reading fallback collection ${collection}`);
                }
                console.error(`StoreService: Failed to read fallback collection ${collection}:`, error);
                throw error;
            }
        }
    }

    async write(collection, data, options = {}) {
        return this.lock(async () => {
            const modelName = collectionToModelMap[collection];
            if (modelName) {
                if (!options.replaceAll && !isDev) {
                    throw new Error(`Unsafe full collection rewrite on Prisma model '${collection}'. Pass { replaceAll: true } if intentional, or use targeted update/delete.`);
                }
                try {
                    // Find existing IDs and incoming IDs to compute deletions
                    const existingItems = await prisma[modelName].findMany({ select: { id: true } });
                    const existingIds = existingItems.map(item => item.id);
                    const incomingIds = (data || []).map(item => item.id).filter(Boolean);
                    const idsToDelete = existingIds.filter(id => !incomingIds.includes(id));

                    await prisma.$transaction(async (tx) => {
                        // Delete removed items
                        if (idsToDelete.length > 0) {
                            await tx[modelName].deleteMany({
                                where: { id: { in: idsToDelete } }
                            });
                        }

                        // Upsert incoming items
                        for (const item of data) {
                            if (!item.id) continue;
                            const { id, ...rest } = item;
                            
                            // Format Date fields if they are strings/ISO
                            const formattedRest = { ...rest };
                            if (modelName === 'user') {
                                if (formattedRest.airdropSubmittedAt) formattedRest.airdropSubmittedAt = new Date(formattedRest.airdropSubmittedAt);
                                if (formattedRest.lastActive) formattedRest.lastActive = new Date(formattedRest.lastActive);
                                if (formattedRest.lastDailyTaskAt) formattedRest.lastDailyTaskAt = new Date(formattedRest.lastDailyTaskAt);
                                if (formattedRest.lastWeeklyTaskAt) formattedRest.lastWeeklyTaskAt = new Date(formattedRest.lastWeeklyTaskAt);
                                if (formattedRest.createdAt) formattedRest.createdAt = new Date(formattedRest.createdAt);
                            } else if (modelName === 'news' || modelName === 'signal' || modelName === 'project' || modelName === 'airdropCampaign' || modelName === 't2EMission' || modelName === 't2EClaim' || modelName === 't2EActivity' || modelName === 't2EPayoutRequest' || modelName === 'task' || modelName === 'userSubmittedPair' || modelName === 'admin' || modelName === 'cexConnection' || modelName === 'whaleFollow' || modelName === 'trade') {
                                if (formattedRest.createdAt) formattedRest.createdAt = new Date(formattedRest.createdAt);
                                if (formattedRest.updatedAt) formattedRest.updatedAt = new Date(formattedRest.updatedAt);
                                if (formattedRest.lastSyncedAt) formattedRest.lastSyncedAt = new Date(formattedRest.lastSyncedAt);
                                if (formattedRest.startDate) formattedRest.startDate = new Date(formattedRest.startDate);
                                if (formattedRest.sentAt) formattedRest.sentAt = new Date(formattedRest.sentAt);
                                if (formattedRest.boostExpiry) formattedRest.boostExpiry = new Date(formattedRest.boostExpiry);
                            }

                            const sanitizedRest = sanitizeData(modelName, formattedRest);
                            await tx[modelName].upsert({
                                where: { id },
                                update: sanitizedRest,
                                create: { id, ...sanitizedRest }
                            });
                        }
                    });
                } catch (error) {
                    if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                        if (isDev) {
                            memStore.set(collection, data);
                            return data;
                        }
                        throw new StoreUnavailableError(`Database connection failed while writing collection ${collection}`);
                    }
                    console.error(`StoreService: Failed to write collection ${collection}:`, error);
                    throw error;
                }
            } else {
                // Fallback: Write to system_configs table
                try {
                    await prisma.systemConfig.upsert({
                        where: { key: collection },
                        update: { value: data },
                        create: { key: collection, value: data }
                    });
                } catch (error) {
                    console.error(`StoreService: Failed to write fallback collection ${collection}:`, error);
                    throw error;
                }
            }
        });
    }

    
    async findMany(collection, query = {}) {
        const modelName = collectionToModelMap[collection];
        if (modelName) {
            try {
                const where = {};
                for (const key of Object.keys(query)) {
                    if (query[key] !== undefined) {
                        where[key] = query[key];
                    }
                }
                return await prisma[modelName].findMany({ where });
            } catch (error) {
                if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                    if (isDev) {
                        const items = memStore.get(collection) || [];
                        if (Object.keys(query).length === 0) return items;
                        return items.filter(item => Object.keys(query).every(key => item[key] === query[key]));
                    }
                    throw new StoreUnavailableError(`Database connection failed on findMany ${collection}`);
                }
                console.error(`StoreService: Failed findMany on ${collection}:`, error);
                throw error;
            }
        } else {
            const items = await this.read(collection);
            if (!Array.isArray(items)) return [];
            if (Object.keys(query).length === 0) return items;
            return items.filter(item => Object.keys(query).every(key => item[key] === query[key]));
        }
    }

    async findOne(collection, query = {}) {
        let normalizedQuery = { ...query };
        if (collection === 'users' && normalizedQuery.wallet && !normalizedQuery.verifiedWallet) {
            normalizedQuery.verifiedWallet = normalizedQuery.wallet;
            delete normalizedQuery.wallet;
        }
        const modelName = collectionToModelMap[collection];
        if (modelName) {
            try {
                const where = {};
                for (const key of Object.keys(normalizedQuery)) {
                    if (normalizedQuery[key] !== undefined) {
                        where[key] = normalizedQuery[key];
                    }
                }
                return await prisma[modelName].findFirst({ where });
            } catch (error) {
                if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                    if (isDev) {
                        const items = memStore.get(collection) || [];
                        return items.find(item => Object.keys(normalizedQuery).every(key => item[key] === normalizedQuery[key])) || null;
                    }
                    throw new StoreUnavailableError(`Database connection failed on findOne ${collection}`);
                }
                console.error(`StoreService: Failed findOne on ${collection}:`, error);
                throw error;
            }
        } else {
            const items = await this.read(collection);
            if (!Array.isArray(items)) return null;
            return items.find(item => Object.keys(normalizedQuery).every(key => item[key] === normalizedQuery[key]));
        }
    }

    async create(collection, item) {
        return this.lock(async () => {
            const modelName = collectionToModelMap[collection];
            if (!item.id) item.id = crypto.randomUUID();
            
            if (modelName) {
                const data = { ...item };
                try {
                    if (modelName === 'user' && data.wallet && !data.verifiedWallet) {
                        data.verifiedWallet = data.wallet;
                        delete data.wallet;
                    }
                    if (data.createdAt) data.createdAt = new Date(data.createdAt);
                    else data.createdAt = new Date();
                    
                    if (modelName === 'user') {
                        if (data.airdropSubmittedAt) data.airdropSubmittedAt = new Date(data.airdropSubmittedAt);
                        if (data.lastActive) data.lastActive = new Date(data.lastActive);
                        if (data.lastDailyTaskAt) data.lastDailyTaskAt = new Date(data.lastDailyTaskAt);
                        if (data.lastWeeklyTaskAt) data.lastWeeklyTaskAt = new Date(data.lastWeeklyTaskAt);
                    } else if (modelName === 'news' || modelName === 'signal' || modelName === 'project' || modelName === 'airdropCampaign' || modelName === 't2EMission' || modelName === 't2EClaim' || modelName === 't2EActivity' || modelName === 't2EPayoutRequest' || modelName === 'task' || modelName === 'userSubmittedPair' || modelName === 'admin' || modelName === 'cexConnection' || modelName === 'whaleFollow' || modelName === 'trade') {
                        if (data.updatedAt) data.updatedAt = new Date(data.updatedAt);
                        if (data.lastSyncedAt) data.lastSyncedAt = new Date(data.lastSyncedAt);
                        if (data.startDate) data.startDate = new Date(data.startDate);
                        if (data.sentAt) data.sentAt = new Date(data.sentAt);
                        if (data.boostExpiry) data.boostExpiry = new Date(data.boostExpiry);
                    }

                    const sanitizedData = sanitizeData(modelName, data);
                    return await prisma[modelName].create({ data: sanitizedData });
                } catch (error) {
                    if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                        if (isDev) {
                            const items = memStore.get(collection) || [];
                            const created = { ...data, createdAt: data.createdAt || new Date().toISOString() };
                            items.push(created);
                            memStore.set(collection, items);
                            return created;
                        }
                        throw new StoreUnavailableError(`Database connection failed on create ${collection}`);
                    }
                    console.error(`StoreService: Failed to create in ${collection}:`, error);
                    throw error;
                }
            } else {
                const items = await this.read(collection);
                if (!Array.isArray(items)) {
                    const current = items || {};
                    const updated = { ...current, ...item, id: item.id, createdAt: new Date().toISOString() };
                    await this.write(collection, updated);
                    return updated;
                }
                item.createdAt = new Date().toISOString();
                items.push(item);
                await this.write(collection, items);
                return item;
            }
        });
    }

    
    async delete(collection, id) {
        return this.lock(async () => {
            const modelName = collectionToModelMap[collection];
            if (modelName) {
                try {
                    return await prisma[modelName].delete({ where: { id } });
                } catch (error) {
                    console.error(`StoreService: Failed delete in ${collection}:`, error);
                    return null;
                }
            } else {
                const items = await this.read(collection);
                if (!Array.isArray(items)) return null;
                const index = items.findIndex(item => item.id === id);
                if (index === -1) return null;
                const removed = items.splice(index, 1)[0];
                await this.write(collection, items);
                return removed;
            }
        });
    }

    async updateById(collection, id, updateFn) {
        if (this.update !== StoreService.prototype.update) {
            return this.update(collection, item => item.id === id, updateFn);
        }
        const modelName = collectionToModelMap[collection];
        if (!modelName) {
            return this.update(collection, item => item.id === id, updateFn);
        }
        return this.lock(async () => {
            try {
                const current = await prisma[modelName].findUnique({ where: { id } });
                if (!current) return null;
                const patch = updateFn(current) || {};
                if (typeof patch !== 'object') return current;

                if (modelName === 'user') {
                    if (patch.airdropSubmittedAt) patch.airdropSubmittedAt = new Date(patch.airdropSubmittedAt);
                    if (patch.lastActive) patch.lastActive = new Date(patch.lastActive);
                    if (patch.lastDailyTaskAt) patch.lastDailyTaskAt = new Date(patch.lastDailyTaskAt);
                    if (patch.lastWeeklyTaskAt) patch.lastWeeklyTaskAt = new Date(patch.lastWeeklyTaskAt);
                } else if (modelName === 'news' || modelName === 'signal' || modelName === 'project' || modelName === 'airdropCampaign' || modelName === 't2EMission' || modelName === 't2EClaim' || modelName === 't2EActivity' || modelName === 't2EPayoutRequest' || modelName === 'task' || modelName === 'userSubmittedPair' || modelName === 'admin' || modelName === 'cexConnection' || modelName === 'whaleFollow' || modelName === 'trade') {
                    if (patch.createdAt) patch.createdAt = new Date(patch.createdAt);
                    if (patch.updatedAt) patch.updatedAt = new Date(patch.updatedAt);
                    if (patch.lastSyncedAt) patch.lastSyncedAt = new Date(patch.lastSyncedAt);
                    if (patch.startDate) patch.startDate = new Date(patch.startDate);
                    if (patch.sentAt) patch.sentAt = new Date(patch.sentAt);
                    if (patch.boostExpiry) patch.boostExpiry = new Date(patch.boostExpiry);
                }

                const sanitizedFields = sanitizeData(modelName, patch);
                const result = await prisma[modelName].update({
                    where: { id },
                    data: sanitizedFields
                });
                return result;
            } catch (error) {
                if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                    if (isDev) {
                        const items = memStore.get(collection) || (await this.read(collection)) || [];
                        const idx = items.findIndex(item => item.id === id);
                        if (idx !== -1) {
                            const updated = { ...items[idx], ...(updateFn(items[idx]) || {}) };
                            items[idx] = updated;
                            memStore.set(collection, items);
                            return updated;
                        }
                        return null;
                    }
                    throw new StoreUnavailableError(`Database connection failed on updateById in ${collection}`);
                }
                console.error(`StoreService: Failed to updateById in ${collection}:`, error);
                throw error;
            }
        });
    }

    async update(collection, predicate, updateFn) {
        return this.lock(async () => {
            const modelName = collectionToModelMap[collection];
            if (modelName) {
                try {
                    const items = await prisma[modelName].findMany();
                    const target = items.find(predicate);
                    if (!target) return null;
                    const patch = updateFn(target) || {};
                    if (typeof patch !== 'object') return target;

                    if (modelName === 'user') {
                        if (patch.airdropSubmittedAt) patch.airdropSubmittedAt = new Date(patch.airdropSubmittedAt);
                        if (patch.lastActive) patch.lastActive = new Date(patch.lastActive);
                        if (patch.lastDailyTaskAt) patch.lastDailyTaskAt = new Date(patch.lastDailyTaskAt);
                        if (patch.lastWeeklyTaskAt) patch.lastWeeklyTaskAt = new Date(patch.lastWeeklyTaskAt);
                    } else if (modelName === 'news' || modelName === 'signal' || modelName === 'project' || modelName === 'airdropCampaign' || modelName === 't2EMission' || modelName === 't2EClaim' || modelName === 't2EActivity' || modelName === 't2EPayoutRequest' || modelName === 'task' || modelName === 'userSubmittedPair' || modelName === 'admin' || modelName === 'cexConnection' || modelName === 'whaleFollow' || modelName === 'trade') {
                        if (patch.createdAt) patch.createdAt = new Date(patch.createdAt);
                        if (patch.updatedAt) patch.updatedAt = new Date(patch.updatedAt);
                        if (patch.lastSyncedAt) patch.lastSyncedAt = new Date(patch.lastSyncedAt);
                        if (patch.startDate) patch.startDate = new Date(patch.startDate);
                        if (patch.sentAt) patch.sentAt = new Date(patch.sentAt);
                        if (patch.boostExpiry) patch.boostExpiry = new Date(patch.boostExpiry);
                    }

                    const sanitizedFields = sanitizeData(modelName, patch);
                    const result = await prisma[modelName].update({
                        where: { id: target.id },
                        data: sanitizedFields
                    });
                    return result;
                } catch (error) {
                    if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                        if (isDev) {
                            const items = memStore.get(collection) || (await this.read(collection)) || [];
                            const idx = items.findIndex(predicate);
                            if (idx !== -1) {
                                const updated = { ...items[idx], ...(updateFn(items[idx]) || {}) };
                                items[idx] = updated;
                                memStore.set(collection, items);
                                return updated;
                            }
                            return null;
                        }
                        throw new StoreUnavailableError(`Database connection failed on update in ${collection}`);
                    }
                    console.error(`StoreService: Failed to update in ${collection}:`, error);
                    throw error;
                }
            } else {
                const items = await this.read(collection);
                if (!Array.isArray(items)) {
                    const current = items || {};
                    const updatedItem = updateFn(current);
                    const updated = { ...current, ...updatedItem };
                    await this.write(collection, updated);
                    return updated;
                }
                const index = items.findIndex(predicate);
                if (index === -1) return null;

                const updatedItem = updateFn(items[index]);
                items[index] = { ...items[index], ...updatedItem };
                await this.write(collection, items);
                return items[index];
            }
        });
    }

    /**
     * Atomically submit a user's airdrop entry, enforcing the global
     * submission cap and founder-spot cap inside a single Postgres
     * SERIALIZABLE transaction — not just the in-process mutex used by
     * update()/updateById(). This closes a TOCTOU race where concurrent
     * requests could each read a stale count, all pass the "spots
     * remaining" check, and collectively overshoot the 1000/100 caps
     * (this is the DB-enforced fix; it also holds correctly across
     * multiple backend instances, unlike the in-memory `lock()`).
     *
     * Returns one of:
     *   { status: 'ALREADY_SUBMITTED' }
     *   { status: 'FULL' }
     *   { status: 'OK', user, founderApproved }
     */
    async submitAirdropAtomic(userId, buildFields, { isFounderRequest = false, maxTotal = 1000, maxFounders = 100 } = {}) {
        const runFallback = async () => {
            const users = (await this.read('users')) || [];
            const existing = users.find(u => u.id === userId);
            if (!existing) {
                return { status: 'NOT_FOUND' };
            }
            if (existing.airdropSubmitted) {
                return { status: 'ALREADY_SUBMITTED' };
            }
            const submittedCount = users.filter(u => u.airdropSubmitted).length;
            if (submittedCount >= maxTotal) {
                return { status: 'FULL' };
            }
            let founderApproved = false;
            if (isFounderRequest) {
                const founderCount = users.filter(u => u.isFounderAirdrop).length;
                founderApproved = founderCount < maxFounders;
            }
            const patch = buildFields(existing, founderApproved);
            const updated = await this.updateById('users', userId, () => patch);
            return { status: 'OK', user: updated, founderApproved };
        };
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await prisma.$transaction(async (tx) => {
                    const existing = await tx.user.findUnique({ where: { id: userId } });
                    if (!existing) {
                        return { status: 'NOT_FOUND' };
                    }
                    if (existing.airdropSubmitted) {
                        return { status: 'ALREADY_SUBMITTED' };
                    }

                    const submittedCount = await tx.user.count({ where: { airdropSubmitted: true } });
                    if (submittedCount >= maxTotal) {
                        return { status: 'FULL' };
                    }

                    let founderApproved = false;
                    if (isFounderRequest) {
                        const founderCount = await tx.user.count({ where: { isFounderAirdrop: true } });
                        founderApproved = founderCount < maxFounders;
                    }

                    const fields = sanitizeData('user', buildFields(existing, founderApproved));
                    const updated = await tx.user.update({ where: { id: userId }, data: fields });
                    return { status: 'OK', user: updated, founderApproved };
                }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
            } catch (error) {
                // Serialization failures (Prisma P2034) are expected under
                // contention with SERIALIZABLE isolation — retry a few times
                // before giving up.
                const isSerializationConflict = error && (error.code === 'P2034' || /could not serialize/i.test(error.message || ''));
                if (isSerializationConflict && attempt < maxAttempts) {
                    continue;
                }
                if (error && (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED') || error.name === 'AggregateError')) {
                    return await runFallback();
                }
                throw error;
            }
        }
    }
}

export const store = new StoreService();
store.prisma = prisma;

