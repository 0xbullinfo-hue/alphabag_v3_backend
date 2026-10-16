import Redis from 'ioredis';
import { config } from '../config/env.js';

let redisClient = null;
let isConnected = false;

// In-memory fallbacks for development/testing when Redis is unconfigured
const memoryNonces = new Map();
const memoryAiQuota = new Map();

if (config.redisUrl) {
    try {
        redisClient = new Redis(config.redisUrl, {
            maxRetriesPerRequest: 3,
            enableOfflineQueue: false,
            lazyConnect: true
        });

        redisClient.on('connect', () => {
            isConnected = true;
            console.log('[REDIS] Connected to Redis instance.');
        });

        redisClient.on('error', (err) => {
            isConnected = false;
            console.error('[REDIS] Connection error:', err.message);
        });

        redisClient.connect().catch(err => {
            console.warn('[REDIS] Initial connection failed, running with in-memory fallback:', err.message);
        });
    } catch (err) {
        console.error('[REDIS] Initialization error:', err.message);
    }
} else if (config.isProduction) {
    console.warn('[REDIS] WARNING: Running in production without REDIS_URL. Nonces and AI quota are stored in-process and will not survive restarts or scale horizontally.');
}

/**
 * Reset in-memory stores (primarily for testing)
 */
export function resetMemoryStores() {
    memoryNonces.clear();
    memoryAiQuota.clear();
}

/**
 * Returns active Redis client if connected
 */
export function getRedisClient() {
    return isConnected ? redisClient : null;
}

/**
 * Store a SIWE nonce atomically with TTL.
 * Uses NX (Not eXists) so a duplicate nonce cannot overwrite an existing one.
 */
export async function storeNonce(nonce, wallet, ttlSeconds = 300) {
    const data = JSON.stringify({
        wallet: wallet.toLowerCase(),
        createdAt: Date.now()
    });

    if (isConnected && redisClient) {
        try {
            const res = await redisClient.set(`nonce:${nonce}`, data, 'EX', Math.ceil(ttlSeconds), 'NX');
            return res === 'OK';
        } catch (err) {
            console.warn('[REDIS] storeNonce failed, falling back to memory:', err.message);
        }
    }

    // Memory fallback
    if (memoryNonces.has(nonce)) {
        const existing = memoryNonces.get(nonce);
        if (existing.expiresAt > Date.now()) {
            return false; // Already exists and unexpired
        }
    }

    const expiresAt = Date.now() + Math.ceil(ttlSeconds * 1000);
    memoryNonces.set(nonce, {
        wallet: wallet.toLowerCase(),
        expiresAt
    });

    // Clean up stale entries if map grows large
    if (memoryNonces.size > 1000) {
        const now = Date.now();
        for (const [key, val] of memoryNonces.entries()) {
            if (val.expiresAt <= now) {
                memoryNonces.delete(key);
            }
        }
    }

    return true;
}

/**
 * Atomically retrieve and consume a nonce (anti-replay single-use).
 */
export async function consumeNonce(nonce) {
    if (isConnected && redisClient) {
        try {
            // Redis 6.2+ GETDEL command returns value and deletes it in one atomic operation
            let raw;
            try {
                raw = await redisClient.call('GETDEL', `nonce:${nonce}`);
            } catch (cmdErr) {
                // Fallback Lua script for older Redis versions
                const luaScript = `
                    local val = redis.call('get', KEYS[1])
                    if val then
                        redis.call('del', KEYS[1])
                    end
                    return val
                `;
                raw = await redisClient.eval(luaScript, 1, `nonce:${nonce}`);
            }

            if (!raw) return null;
            return JSON.parse(raw);
        } catch (err) {
            console.warn('[REDIS] consumeNonce failed, falling back to memory:', err.message);
        }
    }

    // Memory fallback
    if (!memoryNonces.has(nonce)) {
        return null;
    }

    const entry = memoryNonces.get(nonce);
    memoryNonces.delete(nonce);

    if (entry.expiresAt <= Date.now()) {
        return null; // Expired
    }

    return {
        wallet: entry.wallet,
        createdAt: entry.expiresAt - 300_000
    };
}

/**
 * Atomic AI quota increment and check.
 */
export async function incrementAiQuota(userId, dateStr, limit, ttlSeconds = 86400) {
    const key = `ai_quota:${userId}:${dateStr}`;

    if (isConnected && redisClient) {
        try {
            const count = await redisClient.incr(key);
            if (count === 1) {
                await redisClient.expire(key, ttlSeconds);
            }
            return {
                used: count,
                allowed: count <= limit,
                remaining: Math.max(0, limit - count)
            };
        } catch (err) {
            console.warn('[REDIS] incrementAiQuota failed, falling back to memory:', err.message);
        }
    }

    // Memory fallback
    const current = memoryAiQuota.get(key) || 0;
    const next = current + 1;
    memoryAiQuota.set(key, next);

    return {
        used: next,
        allowed: next <= limit,
        remaining: Math.max(0, limit - next)
    };
}

/**
 * Get current AI quota usage without incrementing.
 */
export async function getAiQuota(userId, dateStr) {
    const key = `ai_quota:${userId}:${dateStr}`;

    if (isConnected && redisClient) {
        try {
            const val = await redisClient.get(key);
            return val ? parseInt(val, 10) : 0;
        } catch (err) {
            console.warn('[REDIS] getAiQuota failed, falling back to memory:', err.message);
        }
    }

    return memoryAiQuota.get(key) || 0;
}

/**
 * Gracefully close Redis connection on server shutdown.
 */
export async function closeRedis() {
    if (redisClient) {
        try {
            await redisClient.quit();
        } catch (_) {
            redisClient.disconnect();
        }
        isConnected = false;
    }
}
