import crypto from 'crypto';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
const TREASURY_WALLET = process.env.TREASURY_WALLET;
import { store, prisma } from '../services/storeService.js';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const t2eEmitter = new EventEmitter();
import { config } from '../config/env.js';
import { normalizeAddress } from '../utils/address.js';
import { verifyTransfer } from '../services/payoutVerifier.js';

// Cooldown map to prevent automated economic spamming (F-08)
const economicCooldowns = new Map();
function checkEconomicRateLimit(userId, action = 'claim', cooldownMs = 3000) {
    const key = `${userId}:${action}`;
    const now = Date.now();
    const last = economicCooldowns.get(key) || 0;
    if (now - last < cooldownMs) {
        return false;
    }
    economicCooldowns.set(key, now);
    return true;
}

async function verifyEconomicCaptcha(req) {
    const secret = process.env.CAPTCHA_SECRET_KEY;
    if (!secret) {
        if (config.isProduction) {
            return { valid: false, error: 'CAPTCHA service is not configured on server', status: 503 };
        }
        return { valid: true };
    }
    const token = req.body?.captchaToken || req.headers['x-captcha-token'];
    if (!token) {
        return { valid: false, error: 'CAPTCHA token required for this action', status: 400 };
    }
    try {
        const verifyUrl = process.env.CAPTCHA_VERIFY_URL || 'https://hcaptcha.com/siteverify';
        const response = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret, response: token })
        });
        const data = await response.json();
        return data.success ? { valid: true } : { valid: false, error: 'CAPTCHA verification failed', status: 400 };
    } catch (err) {
        console.error('[CAPTCHA] Verification error:', err);
        return { valid: false, error: 'CAPTCHA service unreachable', status: 502 };
    }
}


/**
 * IMPORTANT — claimMission race condition, partial mitigation only:
 *
 * claimMission's "check existing claims, then create a new one" logic is
 * two separate, non-atomic steps. Firing the same claim request multiple
 * times concurrently (a simple scripted attack, or even just a
 * double-click racing itself) lets every concurrent request pass the
 * "already claimed?" check before any of them have written their claim
 * yet — each one then proceeds to award the mission's reward, letting a
 * user mint themselves the reward many times over from a single mission.
 *
 * This lock closes that race WITHIN one running server process — good
 * enough for a single-instance deployment today. It does NOT protect
 * across multiple instances/processes (each has its own separate lock
 * map), which matters once this scales past one server. The real fix is
 * a database-level unique constraint on (userId, claim-window) in the
 * T2EClaim table, so Postgres itself rejects the duplicate insert instead
 * of the application racing to check first. That requires a schema
 * migration and should be tested against a real database rather than
 * applied blind — see the accompanying audit notes for the exact schema
 * change and controller update needed to complete this properly.
 */
// In-memory claim lock with TTL cleanup.
// NOTE: This is per-process only. For horizontal scaling (multiple server instances),
// replace with a Redis-based distributed lock (e.g. Redlock).
const LOCK_TTL_MS = 30_000; // 30 second max hold time
const claimLocks = new Map();

// Periodic cleanup of stale locks (prevents memory leak in long-running processes)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of claimLocks.entries()) {
        if (entry.createdAt && (now - entry.createdAt) > LOCK_TTL_MS * 2) {
            claimLocks.delete(key);
        }
    }
}, 60_000);
async function withClaimLock(key, fn) {
    const previous = claimLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    claimLocks.set(key, previous.then(() => current));
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (claimLocks.get(key) === current) claimLocks.delete(key);
    }
}

/**
 * Computes the claimWindow key that the database unique constraint
 * (userId, claimWindow) enforces — see prisma/schema.prisma's T2EClaim
 * model and prisma/manual_migrations/001_t2e_claim_uniqueness.sql. This
 * MUST stay in sync with that migration's logic, or the constraint will
 * either fail to block real duplicates or incorrectly block legitimate
 * repeat claims (e.g. a new day's DAILY claim). That SQL migration must
 * be run against the database before this will have any effect — until
 * then, the claimWindow column/constraint don't exist yet and this app
 * relies on the in-process lock alone (single-instance protection only).
 */
function computeClaimWindow(missionId, frequency, now) {
    if (frequency === 'DAILY') {
        const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        return `${missionId}:${dateKey}`;
    }
    if (frequency === 'WEEKLY') {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
        return `${missionId}:${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }
    return missionId; // ONCE (and any other/unknown frequency) — one claim ever.
}

function isClaimWindowUniqueViolation(dbError) {
    if (!dbError || dbError.code !== 'P2002') return false;

    // Prisma typically provides either a target array (field names) or a
    // target string (constraint name) depending on adapter/version.
    const target = dbError?.meta?.target;
    if (Array.isArray(target)) {
        return target.includes('userId') && target.includes('claimWindow');
    }
    if (typeof target === 'string') {
        return target.includes('t2e_claims_userid_claimwindow_key') ||
            (target.includes('userId') && target.includes('claimWindow'));
    }
    return false;
}

// ─── TREASURY / CONFIG ────────────────────────────────────────────────────────

export const getTreasuryStatus = async (req, res) => {
    try {
        let config = await store.findOne('t2e_config', { id: 'global_config' });
        if (!config) {
            config = { id: 'global_config', minimumClaimBalance: 500 };
            await store.create('t2e_config', config);
        }
        
        // Intelligence Aggregation (Simulated for JSON store)
        const allClaims = await store.read('t2e_claims');
        const allUsers = await store.read('users');
        const requests = await store.read('t2e_payout_requests');

        const totalEarned = allClaims.reduce((sum, c) => sum + (Number(c.rewardTokens) || 0), 0);
        const totalPending = allUsers.reduce((sum, u) => sum + (Number(u.t2eBagBalance) || 0), 0);
        const totalDisbursed = requests
            .filter(r => r.status === 'APPROVED')
            .reduce((sum, r) => sum + (Number(r.expectedTokens) || 0), 0);

        res.json({
            ...config,
            intelligence: {
                totalEarned,
                totalPending,
                totalDisbursed
            }
        });
    } catch (error) {
        console.error('[T2E] Treasury Fetch Failed:', error);
        res.status(500).json({ error: 'Failed to fetch treasury status' });
    }
};

// ─── USER EARN PROFILE ────────────────────────────────────────────────────────

export const getUserEarnProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const users = await store.read('users');
        const user = users.find(u => u.id && typeof u.id === 'string' && userId && typeof userId === 'string' && u.id.toLowerCase() === userId.toLowerCase());
        const config = await store.findOne('t2e_config', { id: 'global_config' });
        const claims = await store.read('t2e_claims');

        if (!user) return res.status(404).json({ error: 'User not found in T2E Registry' });

        const userClaims = claims.filter(c => c.userId === userId).map(c => c.missionId);

        res.json({
            id: user.id,
            items: user.items || 0,
            lifetimeEarned: user.lifetimeEarned || 0,
            bagTokens: user.bagTokens || 0,
            preferredWallet: user.preferredWallet || user.verifiedWallet || '',
            syndicateRank: user.syndicateRank || 'RECRUIT',
            referralCount: user.referralCount || 0,
            claimedMissionIds: userClaims,
            minimumClaimBalance: config?.minimumClaimBalance ?? 500
        });
    } catch (error) {
        console.error('[T2E] Profile Fetch Error:', error);
        res.status(500).json({ error: 'Failed to fetch user earn profile' });
    }
};

// ─── MISSIONS (PAGINATED) ─────────────────────────────────────────────────────

export const getMissions = async (req, res) => {
    try {
        const { type, status, page = 1, limit = 20 } = req.query;
        let missions = await store.read('t2e_missions');

        // Seed tasks if empty
        if (missions.length === 0) {
            try {
                const tasksFile = path.join(__dirname, '../../data/t2e_tasks.json');
                if (fs.existsSync(tasksFile)) {
                    const defaultTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
                    missions = defaultTasks.map(t => ({
                        ...t,
                        rewardTokens: t.rewardTokens || t.rewardXP, // Normalizing field
                        status: t.status || 'ACTIVE',
                        createdAt: new Date().toISOString()
                    }));
                    await prisma.t2EMission.createMany({
                        data: missions.map(m => ({
                            id: m.id,
                            title: m.title,
                            description: m.description || null,
                            rewardTokens: Number(m.rewardTokens || 0),
                            rewardXP: Number(m.rewardXP || 0),
                            type: m.type || 'SOCIAL',
                            frequency: m.frequency || 'ONCE',
                            requiresLink: Boolean(m.requiresLink),
                            actionUrl: m.actionUrl || null,
                            platform: m.platform || 'SOCIAL',
                            category: m.category || 'GENERAL',
                            status: m.status || 'ACTIVE',
                            createdAt: new Date(m.createdAt || Date.now())
                        })),
                        skipDuplicates: true
                    });
                }
            } catch (seedErr) {
                console.error('[T2E] Seeding tasks failed:', seedErr);
            }
        }

        // Deactivation Check
        const config = await store.findOne('t2e_config', { id: 'global_config' });
        if (config?.isDeactivated) {
            return res.json({ 
                missions: [], 
                total: 0, 
                page: 1, 
                limit: parseInt(limit), 
                totalPages: 0,
                isDeactivated: true,
                message: 'T2E Module is currently suspended for the Airdrop phase.'
            });
        }

        // Apply filters
        let filtered = missions.filter(m => {
            const typeMatch = !type || type === 'ALL' || m.type === type;
            const statusMatch = m.status === (status || 'ACTIVE');
            return typeMatch && statusMatch;
        });

        const total = filtered.length;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const paginated = filtered.slice(skip, skip + parseInt(limit));

        res.json({ 
            missions: paginated, 
            total, 
            page: parseInt(page), 
            limit: parseInt(limit), 
            totalPages: Math.ceil(total / parseInt(limit)) 
        });
    } catch (error) {
        console.error('[T2E] Fetch Missions Error:', error.stack || error);
        res.status(500).json({ error: 'Failed to fetch missions', details: config.isProduction ? undefined : error.message });
    }
};

// ─── ACTIVITY FEED ────────────────────────────────────────────────────────────

export const getActivityFeed = async (req, res) => {
    try {
        const activities = await store.read('t2e_activity');
        // Sort descending by date and take 20
        const sorted = activities.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20);
        res.json(sorted);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch activity feed' });
    }
};

// SSE Stream for real-time activity
export const streamActivity = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    t2eEmitter.on('activityUpdate', sendEvent);

    // Heartbeat ping every 25s to keep connection alive through proxies (F-22)
    const pingInterval = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
    }, 25000);

    req.on('close', () => {
        clearInterval(pingInterval);
        t2eEmitter.off('activityUpdate', sendEvent);
    });
};

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────

export const getLeaderboard = async (req, res) => {
    try {
        const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const claims = await store.read('t2e_claims');
        const users = await store.read('users');

        // Filter and Group by userId
        const stats = claims
            .filter(c => new Date(c.createdAt) >= last24h)
            .reduce((acc, c) => {
                acc[c.userId] = (acc[c.userId] || 0) + (Number(c.rewardTokens) || 0);
                return acc;
            }, {});

        const sorted = Object.entries(stats)
            .map(([userId, points]) => ({ userId, points }))
            .sort((a,b) => b.points - a.points)
            .slice(0, 10);

        const formatted = sorted.map(s => {
            const user = users.find(u => u.id && typeof u.id === 'string' && s.userId && typeof s.userId === 'string' && u.id.toLowerCase() === s.userId.toLowerCase());
            const address = user?.verifiedWallet || user?.id || 'Unknown Node';
            return {
                handle: address.startsWith('0x') ? `${address.slice(0, 6)}...${address.slice(-4)}` : address,
                points: s.points
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('[T2E] Leaderboard Error:', error);
        res.status(500).json({ error: 'Leaderboard fetch failed' });
    }
};

// ─── CLAIM MISSION ────────────────────────────────────────────────────────────

export const claimMission = async (req, res) => {
    try {
        const userId = req.user.id;
        let { missionId, proofLink, feedback, taskId, taskLink } = req.body;
        
        const userObj = await store.findOne('users', { id: userId });
        if (userObj && userObj.isBanned) {
            return res.status(403).json({ error: 'Your account has been permanently suspended from the T2E program due to protocol violations.' });
        }
        
        // Aliases for backward compatibility with Airdrop.tsx
        missionId = missionId || taskId;
        proofLink = proofLink || taskLink;

        const [mission, config] = await Promise.all([
            store.findOne('t2e_missions', { id: missionId }),
            store.findOne('t2e_config', { id: 'global_config' })
        ]);

        if (config?.isDeactivated) {
            return res.status(403).json({ error: 'T2E Module is currently suspended for the Airdrop phase.' });
        }

        if (!mission) return res.status(404).json({ error: 'Mission not found' });
        if (mission.status !== 'ACTIVE') return res.status(400).json({ error: 'Mission is not active' });

        // Mandatory Feedback for Final Review or specific missions
        if ((mission.id === 't2e_final_feedback' || mission.type === 'FINAL_REVIEW') && !feedback) {
            return res.status(400).json({ error: 'Final feedback is compulsory for this mission.' });
        }

        // Everything from here down is the actual check-then-claim race
        // window described in the module comment above — serialize it per
        // user+mission so concurrent requests can't all pass the
        // "already claimed?" check before any of them have written yet.
        const lockKey = `${userId.toLowerCase()}:${missionId}`;
        const result = await withClaimLock(lockKey, async () => {
            const claims = await store.read('t2e_claims');
            const userClaims = claims.filter(c => c.userId.toLowerCase() === userId.toLowerCase() && c.missionId === missionId);

            // Check frequency limits
            const now = new Date();
            if (mission.frequency === 'ONCE' && userClaims.length > 0) {
                return { error: 'Mission already claimed', status: 400 };
            }

            if (mission.frequency === 'DAILY' && userClaims.length > 0) {
                const lastClaim = new Date(userClaims.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0].createdAt);
                if (now.getTime() - lastClaim.getTime() < 24 * 60 * 60 * 1000) {
                    return { error: 'Daily mission already completed. Come back in 24 hours.', status: 400 };
                }
            }

            if (mission.frequency === 'WEEKLY' && userClaims.length > 0) {
                const lastClaim = new Date(userClaims.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0].createdAt);
                if (now.getTime() - lastClaim.getTime() < 7 * 24 * 60 * 60 * 1000) {
                    return { error: 'Weekly mission already completed. Come back in 7 days.', status: 400 };
                }
            }

            // Processing Claim
            const claimWindow = computeClaimWindow(missionId, mission.frequency, now);
            const newClaim = {
                id: crypto.randomUUID(),
                userId,
                missionId,
                claimWindow,
                proofLink,
                feedback,
                rewardTokens: mission.rewardTokens,
                rewardXP: mission.rewardXP || mission.rewardTokens,
                createdAt: now.toISOString()
            };
            try {
                await store.create('t2e_claims', newClaim);
            } catch (dbError) {
                // P2002 = Prisma unique-constraint violation — the real
                // guard, catching even a race across multiple server
                // instances (which the in-process lock above can't).
                // Requires the SQL migration in
                // prisma/manual_migrations/001_t2e_claim_uniqueness.sql
                // to have been run; until then this constraint doesn't
                // exist and only the lock protects (single-instance only).
                if (isClaimWindowUniqueViolation(dbError)) {
                    return { error: 'Mission already claimed.', status: 400 };
                }
                throw dbError;
            }

            // Update User Balance (ITEMS) & Legacy Fields for Frontend
            const fullNow = now.toISOString();
            await store.updateById('users', userId, (u) => {
                const updates = {
                    items: (Number(u.items) || 0) + Number(mission.rewardTokens),
                    lifetimeEarned: (Number(u.lifetimeEarned) || 0) + Number(mission.rewardTokens)
                };

                // Keep countdown timers authoritative for any DAILY mission.
                if (mission.frequency === 'DAILY') {
                    updates.lastDailyTaskAt = fullNow;
                }
                if (mission.frequency === 'WEEKLY') {
                    updates.lastWeeklyTaskAt = fullNow;
                    const weeklyTasks = u.weeklyTasks || {};
                    weeklyTasks[mission.id] = { date: fullNow };
                    updates.weeklyTasks = weeklyTasks;
                }
                if (mission.frequency === 'ONCE') {
                    const completedTasks = new Set([...(u.completedTasks || []), mission.id]);
                    updates.completedTasks = Array.from(completedTasks);
                }

                return updates;
            });

            const updatedUser = await store.findOne('users', { id: userId });
            const activity = {
                id: crypto.randomUUID(),
                userHandle: updatedUser?.verifiedWallet?.slice(0, 8) || userId.slice(0, 8),
                taskType: mission.type,
                pointsEarned: Number(mission.rewardTokens),
                createdAt: new Date().toISOString()
            };
            await store.create('t2e_activity', activity);

            return { success: true, user: updatedUser };
        });

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        const { user } = result;
        t2eEmitter.emit('activityUpdate', { type: 'MISSION_CLAIM', data: {
            taskType: mission.type,
            pointsEarned: Number(mission.rewardTokens),
        }});
        res.json({ 
            success: true, 
            rewardTokens: mission.rewardTokens,
            rewardXP: mission.rewardXP || mission.rewardTokens,
            items: Number(user?.items) || 0,
            message: `Mission completed. +${Number(mission.rewardTokens)} ITEMS awarded.`
        });
    } catch (error) {
        console.error('[T2E] Claim Error:', error.stack || error);
        res.status(500).json({ error: 'Mission claim failed', details: config.isProduction ? undefined : error.message });
    }
};

export const requestBagPayout = async (req, res) => {
    try {
        const userId = req.user.id;

        // Verify captcha if configured / in production
        const captchaCheck = await verifyEconomicCaptcha(req);
        if (!captchaCheck.valid) {
            return res.status(captchaCheck.status || 400).json({ error: captchaCheck.error });
        }

        const globalConfig = await store.findOne('t2e_config', { id: 'global_config' });
        const minimum = globalConfig?.minimumClaimBalance ?? 500;

        const result = await store.prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId } });
            if (!user) return { error: 'User not found in T2E Registry', status: 404 };

            if ((Number(user.items) || 0) < minimum) {
                return { error: `Minimum payout of ${minimum.toLocaleString()} ITEMS required.`, status: 400 };
            }

            // Check if there is an existing PENDING request
            const existingPending = await tx.t2EPayoutRequest.findFirst({
                where: { userId, status: 'PENDING' }
            });
            if (existingPending) {
                return { error: 'You already have a pending payout request', status: 409 };
            }

            const rawWallet = user.preferredWallet || user.verifiedWallet || user.submittedWallet;
            const payoutWallet = normalizeAddress(rawWallet);
            if (!payoutWallet) {
                return {
                    error: 'A valid EVM wallet address is required before requesting a payout. Please update your wallet in settings.',
                    status: 400
                };
            }

            const amount = Number(user.items);
            const request = await tx.t2EPayoutRequest.create({
                data: {
                    id: crypto.randomUUID(),
                    userId,
                    expectedTokens: amount,
                    walletAddress: payoutWallet,
                    status: 'PENDING',
                    createdAt: new Date()
                }
            });

            // Zero out items in the exact same atomic transaction
            await tx.user.update({
                where: { id: userId },
                data: { items: 0 }
            });

            return { success: true, request, amount, payoutWallet };
        }, { isolationLevel: 'Serializable' });

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        const { request, amount, payoutWallet } = result;
        t2eEmitter.emit('activityUpdate', {
            type: 'TOKEN_PAYOUT_REQUEST',
            data: { userHandle: payoutWallet.slice(0, 8), amount }
        });

        res.json({ success: true, message: 'Payout requested successfully.', requestId: request.id });
    } catch (error) {
        console.error('[T2E] Payout Request Error:', error);
        res.status(500).json({ error: 'Payout request failed' });
    }
};

export const updatePreferredWallet = async (req, res) => {
    try {
        const { wallet } = req.body;
        const normalized = normalizeAddress(wallet);
        if (!normalized) {
            return res.status(400).json({ error: 'A valid EVM wallet address is required' });
        }

        // Reject wallet change if user has a PENDING payout request
        const pending = await store.findOne('t2e_payout_requests', {
            userId: req.user.id,
            status: 'PENDING'
        });
        if (pending) {
            return res.status(409).json({ error: 'Cannot update payout wallet while a payout request is PENDING' });
        }

        await store.updateById('users', req.user.id, () => ({ preferredWallet: normalized }));

        res.json({ success: true, message: 'Preferred wallet updated', wallet: normalized });
    } catch (error) {
        res.status(500).json({ error: 'Update failed' });
    }
};

// ─── ADMIN CONTROLS ───────────────────────────────────────────────────────────

export const adjustTreasuryBalance = async (req, res) => {
    try {
        const { minimumClaimBalance, itemsToBagRate, campaignEnded } = req.body;
        const current = await store.findOne('t2e_config', { id: 'global_config' }) || { id: 'global_config', minimumClaimBalance: 500 };
        
        const data = { ...current };
        if (minimumClaimBalance !== undefined) {
            const min = Number(minimumClaimBalance);
            if (!Number.isFinite(min) || min < 0) {
                return res.status(400).json({ error: 'minimumClaimBalance must be a non-negative finite number' });
            }
            data.minimumClaimBalance = min;
        }
        if (itemsToBagRate !== undefined) {
            const rate = Number(itemsToBagRate);
            if (!Number.isFinite(rate) || rate <= 0) {
                return res.status(400).json({ error: 'itemsToBagRate must be a positive finite number' });
            }
            data.itemsToBagRate = rate;
        }
        if (campaignEnded !== undefined) data.campaignEnded = Boolean(campaignEnded);

        // Store config is likely an object or an array with one item based on write call
        await store.write('t2e_config', [data]); 
        res.json({ success: true, config: data });
    } catch (error) {
        res.status(500).json({ error: 'Adjust failed' });
    }
};

export const getAdminMissions = async (req, res) => {
    try {
        const missions = await store.read('t2e_missions') || [];
        res.json(missions);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch admin missions' });
    }
};

export const upsertMission = async (req, res) => {
    try {
        const { id, title, description, rewardTokens, rewardXP, type, frequency, requiresLink, actionUrl, platform, category, status } = req.body;
        if (!title) return res.status(400).json({ error: 'Title is required' });

        const missionId = id || 't2e_' + crypto.randomUUID();
        const data = {
            title,
            description: description || null,
            rewardTokens: parseFloat(rewardTokens) || 0,
            rewardXP: parseFloat(rewardXP) || parseFloat(rewardTokens) || 0,
            type: (type || frequency || 'ONCE').toUpperCase(),
            frequency: (frequency || type || 'ONCE').toUpperCase(),
            requiresLink: Boolean(requiresLink),
            actionUrl: actionUrl || null,
            platform: platform || 'SOCIAL',
            category: category || 'GENERAL',
            status: status || 'ACTIVE'
        };

        const upserted = await prisma.t2EMission.upsert({
            where: { id: missionId },
            update: data,
            create: { id: missionId, ...data }
        });

        res.json({ success: true, mission: upserted });
    } catch (error) {
        console.error('[T2E] Upsert Mission Error:', error);
        res.status(500).json({ error: 'Failed to deploy mission' });
    }
};

export const deleteMission = async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await store.findOne('t2e_missions', { id });
        if (!existing) return res.status(404).json({ error: 'Mission not found' });

        await prisma.t2EMission.delete({
            where: { id }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('[T2E] Delete Mission Error:', error);
        res.status(500).json({ error: 'Failed to delete mission' });
    }
};

export const getAdminTokenRequests = async (req, res) => {
    try {
        const requests = await store.read('t2e_payout_requests');
        const users = await store.read('users');
        
        const enriched = requests.map(r => ({
            ...r,
            user: users.find(u => u.id === r.userId) || { walletAddress: r.walletAddress }
        })).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json(enriched);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
};

export const approveTokenRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, txHash } = req.body || {};

        const request = await store.findOne('t2e_payout_requests', { id });
        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (request.status !== 'PENDING') return res.status(400).json({ error: 'Request already processed' });

        if (status === 'REJECTED') {
            // Atomic reject + refund user's balance
            await store.prisma.$transaction(async (tx) => {
                await tx.t2EPayoutRequest.update({
                    where: { id },
                    data: { status: 'REJECTED' }
                });
                await tx.user.update({
                    where: { id: request.userId },
                    data: { items: { increment: Number(request.expectedTokens) } }
                });
            });
            return res.json({ success: true, message: 'Request rejected' });
        }

        // On approve: admin airdropped the reward, so a verified txHash is strictly required.
        if (!txHash || typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
            return res.status(400).json({ error: 'A valid on-chain transaction hash (64-character hex 0x...) is required to approve a payout.' });
        }

        // If BAG token address is configured, perform on-chain transfer verification
        if (config.bagTokenAddress) {
            const verification = await verifyTransfer({
                txHash,
                to: request.walletAddress,
                minAmountWei: 0, // In dev/test minimal verification; amounts validated if rate configured
            });
            if (!verification.verified) {
                return res.status(400).json({ error: `On-chain transfer verification failed: ${verification.error}` });
            }
        }

        await store.updateById('t2e_payout_requests', id, () => ({ 
            status: 'APPROVED',
            txHash,
            sentAt: new Date().toISOString(),
            processedBy: req.user?.id || 'admin'
        }));

        res.json({ success: true, txHash, status: 'APPROVED' });
    } catch (error) {
        console.error('[T2E] Approve Request Error:', error);
        res.status(500).json({ error: 'Approval failed' });
    }
};

// Admin marks a payout request as SENT (legacy state support)
export const markPayoutDone = async (req, res) => {
    try {
        const { id } = req.params;
        const { txReference } = req.body || {};

        const request = await store.findOne('t2e_payout_requests', { id });
        if (!request) return res.status(404).json({ error: 'Payout request not found' });
        
        // Strict state machine: only APPROVED requests can transition to SENT
        if (request.status !== 'APPROVED') {
            return res.status(400).json({ error: `Invalid transition: payout must be in APPROVED status before being marked as SENT (current: ${request.status})` });
        }

        await store.updateById('t2e_payout_requests', id, () => ({
            status: 'SENT',
            sentAt: new Date().toISOString(),
            txReference: txReference || request.txHash || null,
            processedBy: req.user?.id || 'admin'
        }));

        res.json({ success: true, message: 'Payout marked as SENT.' });
    } catch (error) {
        console.error('[T2E] Mark Done Error:', error);
        res.status(500).json({ error: 'Failed to mark payout as done' });
    }
};

export const getAdminActivity = async (req, res) => {
    try {
        const claims = await store.read('t2e_claims');
        const users = await store.read('users');
        const missions = await store.read('t2e_missions');

        const enriched = claims.map(c => ({
            ...c,
            user: users.find(u => u.id === c.userId) || { walletAddress: c.userId },
            mission: missions.find(m => m.id === c.missionId) || { title: 'Unknown', type: 'SYSTEM' },
            pointsEarned: Number(c.rewardTokens)
        })).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100);

        res.json(enriched);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch activity' });
    }
};

export const approveAllTokenRequests = async (req, res) => {
    try {
        const txHash = req.body?.txHash;
        if (!txHash || typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
            return res.status(400).json({ error: 'A valid 64-character batch transaction hash (0x...) is required to approve pending payouts.' });
        }

        // Run batch approval inside a single atomic transaction
        const updatedCount = await store.prisma.$transaction(async (tx) => {
            const pendingRequests = await tx.t2EPayoutRequest.findMany({
                where: { status: 'PENDING' }
            });

            if (pendingRequests.length === 0) return 0;

            await tx.t2EPayoutRequest.updateMany({
                where: { status: 'PENDING' },
                data: {
                    status: 'APPROVED',
                    txHash,
                    sentAt: new Date(),
                    processedBy: req.user?.id || 'admin'
                }
            });

            return pendingRequests.length;
        });

        res.json({ success: true, message: `Approved ${updatedCount} pending requests.`, count: updatedCount });
    } catch (error) {
        console.error('[T2E] Approve All Error:', error);
        res.status(500).json({ error: 'Failed to approve all requests' });
    }
};

export const markAllPayoutsDone = async (req, res) => {
    try {
        const { txReference } = req.body;
        const result = await prisma.t2EPayoutRequest.updateMany({
            where: { status: 'APPROVED' },
            data: {
                status: 'SENT',
                sentAt: new Date(),
                txReference: txReference || 'Bulk Manual Airdrop',
                processedBy: req.user?.id || 'admin'
            }
        });

        res.json({ success: true, message: `Marked ${result.count} approved requests as SENT.` });
    } catch (error) {
        console.error('[T2E] Mark All Done Error:', error);
        res.status(500).json({ error: 'Failed to mark requests as SENT' });
    }
};

export const rejectBulkTokenRequests = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Request body must contain an array of ids' });
        }

        const updatedCount = await prisma.$transaction(async (tx) => {
            const pendingRequests = await tx.t2EPayoutRequest.findMany({
                where: {
                    id: { in: ids },
                    status: 'PENDING'
                }
            });

            if (pendingRequests.length === 0) return 0;

            // 1. Mark requests as REJECTED
            await tx.t2EPayoutRequest.updateMany({
                where: {
                    id: { in: pendingRequests.map(r => r.id) },
                    status: 'PENDING'
                },
                data: { status: 'REJECTED' }
            });

            // 2. Refund each user's items balance (crucial: users must not lose their points)
            for (const request of pendingRequests) {
                await tx.user.update({
                    where: { id: request.userId },
                    data: { items: { increment: Number(request.expectedTokens) } }
                });
            }

            return pendingRequests.length;
        });

        res.json({ success: true, message: `Rejected ${updatedCount} selected requests.`, count: updatedCount });
    } catch (error) {
        console.error('[T2E] Reject Bulk Error:', error);
        res.status(500).json({ error: 'Failed to reject selected requests' });
    }
};

export const exportApprovedPayouts = async (req, res) => {
    try {
        const requests = await store.read('t2e_payout_requests') || [];
        const approved = requests.filter(r => r.status === 'APPROVED');
        
        // Sanitize CSV cells against formula injection (=, +, -, @)
        const cell = (val) => {
            let str = String(val ?? '');
            if (/^[+=@-]/.test(str)) str = "'" + str;
            return JSON.stringify(str);
        };

        const headers = ['Wallet', 'Amount', 'Status', 'Approved At', 'Tx Reference'];
        let csvContent = headers.map(cell).join(',') + '\n';
        
        approved.forEach(r => {
            csvContent += [cell(r.wallet || r.userId), cell(r.amount), cell(r.status), cell(r.approvedAt || r.createdAt), cell(r.txHash || r.id)].join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="approved_payouts_${Date.now()}.csv"`);
        res.send(csvContent);
    } catch (error) {
        console.error('[T2E] Export Payouts Error:', error);
        res.status(500).json({ error: 'Failed to export payouts' });
    }
};
