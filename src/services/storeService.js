import pkg from '@prisma/client';
const { PrismaClient, Prisma } = pkg;
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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
    'cex_connections': 'cexConnection'
};

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
                console.error(`StoreService: Failed to read collection ${collection}:`, error);
                return [];
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
                console.error(`StoreService: Failed to read fallback collection ${collection}:`, error);
                return collection.includes('config') || collection.includes('settings') ? {} : [];
            }
        }
    }

    async write(collection, data) {
        return this.lock(async () => {
            const modelName = collectionToModelMap[collection];
            if (modelName) {
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
                            } else if (modelName === 'news' || modelName === 'signal' || modelName === 'project' || modelName === 'airdropCampaign' || modelName === 't2EMission' || modelName === 't2EClaim' || modelName === 't2EActivity' || modelName === 't2EPayoutRequest' || modelName === 'task' || modelName === 'userSubmittedPair' || modelName === 'admin' || modelName === 'cexConnection') {
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
                console.error(`StoreService: Failed findMany on ${collection}:`, error);
                return [];
            }
        } else {
            const items = await this.read(collection);
            if (!Array.isArray(items)) return [];
            if (Object.keys(query).length === 0) return items;
            return items.filter(item => Object.keys(query).every(key => item[key] === query[key]));
        }
    }

    async findOne(collection, query) {
        const modelName = collectionToModelMap[collection];
        if (modelName) {
            try {
                const where = {};
                for (const key of Object.keys(query)) {
                    if (query[key] !== undefined) {
                        where[key] = query[key];
                    }
                }
                return await prisma[modelName].findFirst({ where });
            } catch (error) {
                console.error(`StoreService: Failed findOne on ${collection}:`, error);
                return null;
            }
        } else {
            const items = await this.read(collection);
            if (!Array.isArray(items)) return null;
            return items.find(item => Object.keys(query).every(key => item[key] === query[key]));
        }
    }

    async create(collection, item) {
        return this.lock(async () => {
            const modelName = collectionToModelMap[collection];
            if (!item.id) item.id = Math.random().toString(36).substr(2, 9);
            
            if (modelName) {
                try {
                    const data = { ...item };
                    if (data.createdAt) data.createdAt = new Date(data.createdAt);
                    else data.createdAt = new Date();
                    
                    if (modelName === 'user') {
                        if (data.airdropSubmittedAt) data.airdropSubmittedAt = new Date(data.airdropSubmittedAt);
                        if (data.lastActive) data.lastActive = new Date(data.lastActive);
                        if (data.lastDailyTaskAt) data.lastDailyTaskAt = new Date(data.lastDailyTaskAt);
                        if (data.lastWeeklyTaskAt) data.lastWeeklyTaskAt = new Date(data.lastWeeklyTaskAt);
                    } else if (modelName === 'news' || modelName === 'signal' || modelName === 'project' || modelName === 'airdropCampaign' || modelName === 't2EMission' || modelName === 't2EClaim' || modelName === 't2EActivity' || modelName === 't2EPayoutRequest' || modelName === 'task' || modelName === 'userSubmittedPair' || modelName === 'admin' || modelName === 'cexConnection') {
                        if (data.updatedAt) data.updatedAt = new Date(data.updatedAt);
                        if (data.lastSyncedAt) data.lastSyncedAt = new Date(data.lastSyncedAt);
                        if (data.startDate) data.startDate = new Date(data.startDate);
                        if (data.sentAt) data.sentAt = new Date(data.sentAt);
                        if (data.boostExpiry) data.boostExpiry = new Date(data.boostExpiry);
                    }

                    const sanitizedData = sanitizeData(modelName, data);
                    return await prisma[modelName].create({ data: sanitizedData });
                } catch (error) {
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
        return this.update(collection, item => item.id === id, updateFn);
    }

    async update(collection, predicate, updateFn) {
        return this.lock(async () => {
            const modelName = collectionToModelMap[collection];
            if (modelName) {
                try {
                    const items = await prisma[modelName].findMany();
                    const index = items.findIndex(predicate);
                    if (index === -1) return null;

                    const updatedFields = updateFn(items[index]);
                    const { id, ...fieldsToUpdate } = updatedFields;
                    
                    const formattedFields = { ...fieldsToUpdate };
                    if (modelName === 'user') {
                        if (formattedFields.airdropSubmittedAt) formattedFields.airdropSubmittedAt = new Date(formattedFields.airdropSubmittedAt);
                        if (formattedFields.lastActive) formattedFields.lastActive = new Date(formattedFields.lastActive);
                        if (formattedFields.lastDailyTaskAt) formattedFields.lastDailyTaskAt = new Date(formattedFields.lastDailyTaskAt);
                        if (formattedFields.lastWeeklyTaskAt) formattedFields.lastWeeklyTaskAt = new Date(formattedFields.lastWeeklyTaskAt);
                    } else if (modelName === 'news' || modelName === 'signal' || modelName === 'project' || modelName === 'airdropCampaign' || modelName === 't2EMission' || modelName === 't2EClaim' || modelName === 't2EActivity' || modelName === 't2EPayoutRequest' || modelName === 'task' || modelName === 'userSubmittedPair' || modelName === 'admin' || modelName === 'cexConnection') {
                        if (formattedFields.createdAt) formattedFields.createdAt = new Date(formattedFields.createdAt);
                        if (formattedFields.updatedAt) formattedFields.updatedAt = new Date(formattedFields.updatedAt);
                        if (formattedFields.lastSyncedAt) formattedFields.lastSyncedAt = new Date(formattedFields.lastSyncedAt);
                        if (formattedFields.startDate) formattedFields.startDate = new Date(formattedFields.startDate);
                        if (formattedFields.sentAt) formattedFields.sentAt = new Date(formattedFields.sentAt);
                        if (formattedFields.boostExpiry) formattedFields.boostExpiry = new Date(formattedFields.boostExpiry);
                    }

                    const sanitizedFields = sanitizeData(modelName, formattedFields);
                    const result = await prisma[modelName].update({
                        where: { id: items[index].id },
                        data: sanitizedFields
                    });
                    return result;
                } catch (error) {
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
                throw error;
            }
        }
    }
}

export const store = new StoreService();
