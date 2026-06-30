import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const { Pool } = pg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '../../data');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function readJson(filename) {
    const filePath = path.join(dataDir, filename);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8').trim();
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error(`Error reading/parsing ${filename}:`, e);
        return null;
    }
}

async function main() {
    console.log('Starting migration from JSON store to PostgreSQL database...');

    // 1. Clean existing records in the database (order respects foreign keys)
    console.log('Cleaning existing records...');
    await prisma.userSubmittedPair.deleteMany({});
    await prisma.t2EClaim.deleteMany({});
    await prisma.t2EPayoutRequest.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.news.deleteMany({});
    await prisma.signal.deleteMany({});
    await prisma.airdropCampaign.deleteMany({});
    await prisma.t2EMission.deleteMany({});
    await prisma.t2EActivity.deleteMany({});
    await prisma.task.deleteMany({});
    await prisma.systemConfig.deleteMany({});
    console.log('Database cleaned.');

    // 2. Migrate Users
    const usersData = await readJson('users.json') || [];
    console.log(`Migrating ${usersData.length} users...`);
    const validUserIds = new Set();
    for (const u of usersData) {
        if (!u.id) continue;
        validUserIds.add(u.id);

        await prisma.user.create({
            data: {
                id: u.id,
                email: u.email || null,
                password: u.password || null,
                username: u.username || null,
                tier: u.tier || 'FREE',
                isAdmin: !!u.isAdmin,
                isBanned: !!u.isBanned,
                strikes: parseInt(u.strikes) || 0,
                items: parseFloat(u.items) || 0,
                bagTokens: parseFloat(u.bagTokens) || 0,
                lifetimeEarned: parseFloat(u.lifetimeEarned) || 0,
                aipoints: parseInt(u.aipoints) || 0,
                verifiedWallet: u.verifiedWallet || null,
                submittedWallet: u.submittedWallet || null,
                preferredWallet: u.preferredWallet || null,
                airdropSubmitted: !!u.airdropSubmitted,
                airdropSubmittedAt: u.airdropSubmittedAt ? new Date(u.airdropSubmittedAt) : null,
                xLink: u.xLink || null,
                reviewComment: u.reviewComment || null,
                isFounderAirdrop: !!u.isFounderAirdrop,
                founderStatus: u.founderStatus || 'PENDING',
                projectName: u.projectName || null,
                projectTicker: u.projectTicker || null,
                projectManifesto: u.projectManifesto || null,
                projectSocial: u.projectSocial || null,
                projectWebsite: u.projectWebsite || null,
                projectContract: u.projectContract || null,
                projectGoals: u.projectGoals || null,
                founderSocial: u.founderSocial || null,
                projectLogo: u.projectLogo || null,
                projectBanner: u.projectBanner || null,
                referralCode: u.referralCode || null,
                referredBy: u.referredBy || null,
                referralCount: parseInt(u.referralCount) || 0,
                completedTasks: Array.isArray(u.completedTasks) ? u.completedTasks : [],
                claimsHistory: u.claimsHistory || [],
                submittedLinks: u.submittedLinks || [],
                weeklyTasks: u.weeklyTasks || {},
                visits: parseInt(u.visits) || 0,
                lastLoginIp: u.lastLoginIp || null,
                lastActive: u.lastActive ? new Date(u.lastActive) : null,
                lastDailyTaskAt: u.lastDailyTaskAt ? new Date(u.lastDailyTaskAt) : null,
                lastWeeklyTaskAt: u.lastWeeklyTaskAt ? new Date(u.lastWeeklyTaskAt) : null,
                syndicateRank: u.syndicateRank || 'RECRUIT',
                createdAt: u.createdAt ? new Date(u.createdAt) : new Date(),
            }
        });
    }

    // 3. Migrate News
    const newsData = await readJson('news.json') || [];
    console.log(`Migrating ${newsData.length} news items...`);
    for (const n of newsData) {
        if (!n.id) continue;
        await prisma.news.create({
            data: {
                id: n.id,
                title: n.title,
                summary: n.summary || null,
                content: n.content || null,
                category: n.category || null,
                tier: n.tier || 'FREE',
                imageUrl: n.imageUrl || null,
                source: n.source || null,
                isPremium: !!n.isPremium,
                isPublished: n.isPublished !== undefined ? !!n.isPublished : true,
                createdAt: n.createdAt ? new Date(n.createdAt) : new Date(),
            }
        });
    }

    // 4. Migrate Signals
    const signalsData = await readJson('signals.json') || [];
    console.log(`Migrating ${signalsData.length} signals...`);
    for (const s of signalsData) {
        if (!s.id) continue;
        await prisma.signal.create({
            data: {
                id: s.id,
                pair: s.pair,
                type: s.type || 'BUY',
                entry: s.entry || null,
                stopLoss: s.stopLoss || null,
                targets: Array.isArray(s.targets) ? s.targets : [],
                narrative: s.narrative || null,
                category: s.category || null,
                risk: s.risk || null,
                status: s.status || 'ACTIVE',
                timestamp: s.timestamp || null,
                createdAt: s.createdAt ? new Date(s.createdAt) : new Date(),
            }
        });
    }

    // 5. Migrate Airdrop Campaigns
    const airdropCampaigns = await readJson('airdrop.json') || [];
    console.log(`Migrating ${airdropCampaigns.length} airdrop campaigns...`);
    for (const c of airdropCampaigns) {
        if (!c.id) continue;
        await prisma.airdropCampaign.create({
            data: {
                id: c.id,
                tokenTicker: c.tokenTicker || '🔒',
                pointsPerClaim: parseInt(c.pointsPerClaim) || 50,
                durationDays: parseInt(c.durationDays) || 7,
                startDate: c.startDate ? new Date(c.startDate) : new Date(),
                status: c.status || 'ACTIVE',
                isSubmissionActive: c.isSubmissionActive !== undefined ? !!c.isSubmissionActive : true,
                createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
            }
        });
    }

    // 6. Migrate T2E Missions
    const t2eMissions = await readJson('t2e_missions.json') || [];
    console.log(`Migrating ${t2eMissions.length} T2E missions...`);
    const validMissionIds = new Set();
    for (const m of t2eMissions) {
        if (!m.id) continue;
        validMissionIds.add(m.id);
        await prisma.t2EMission.create({
            data: {
                id: m.id,
                title: m.title,
                description: m.description || null,
                rewardTokens: parseFloat(m.rewardTokens) || 0,
                rewardXP: parseFloat(m.rewardXP) || parseFloat(m.rewardTokens) || 0,
                type: m.type || 'SOCIAL',
                frequency: m.frequency || 'ONCE',
                requiresLink: !!m.requiresLink,
                actionUrl: m.actionUrl || null,
                platform: m.platform || 'SOCIAL',
                category: m.category || 'GENERAL',
                status: m.status || 'ACTIVE',
                createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
            }
        });
    }

    // 7. Migrate T2E Claims
    const t2eClaims = await readJson('t2e_claims.json') || [];
    console.log(`Migrating ${t2eClaims.length} T2E claims...`);
    for (const c of t2eClaims) {
        if (!c.id) continue;
        // Verify User and Mission exist (avoid foreign key failures)
        if (!validUserIds.has(c.userId)) {
            console.warn(`Skipping claim ${c.id}: User ${c.userId} does not exist`);
            continue;
        }
        if (!validMissionIds.has(c.missionId)) {
            console.warn(`Skipping claim ${c.id}: Mission ${c.missionId} does not exist`);
            continue;
        }
        await prisma.t2EClaim.create({
            data: {
                id: c.id,
                userId: c.userId,
                missionId: c.missionId,
                proofLink: c.proofLink || null,
                feedback: c.feedback || null,
                rewardTokens: parseFloat(c.rewardTokens) || 0,
                rewardXP: parseFloat(c.rewardXP) || parseFloat(c.rewardTokens) || 0,
                createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
            }
        });
    }

    // 8. Migrate T2E Activity Feed Events
    const t2eActivity = await readJson('t2e_activity.json') || [];
    console.log(`Migrating ${t2eActivity.length} T2E activity events...`);
    for (const a of t2eActivity) {
        if (!a.id) continue;
        await prisma.t2EActivity.create({
            data: {
                id: a.id,
                userHandle: a.userHandle,
                taskType: a.taskType || 'SOCIAL',
                pointsEarned: parseFloat(a.pointsEarned) || 0,
                createdAt: a.createdAt ? new Date(a.createdAt) : new Date(),
            }
        });
    }

    // 9. Migrate T2E Payout Requests
    const payoutRequests = await readJson('t2e_payout_requests.json') || [];
    console.log(`Migrating ${payoutRequests.length} payout requests...`);
    for (const r of payoutRequests) {
        if (!r.id) continue;
        if (!validUserIds.has(r.userId)) {
            console.warn(`Skipping payout request ${r.id}: User ${r.userId} does not exist`);
            continue;
        }
        await prisma.t2EPayoutRequest.create({
            data: {
                id: r.id,
                userId: r.userId,
                expectedTokens: parseFloat(r.expectedTokens) || 0,
                walletAddress: r.walletAddress,
                status: r.status || 'PENDING',
                txHash: r.txHash || null,
                txReference: r.txReference || null,
                sentAt: r.sentAt ? new Date(r.sentAt) : null,
                processedBy: r.processedBy || null,
                createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
            }
        });
    }

    // 10. Migrate Legacy Tasks
    const tasks = await readJson('tasks.json') || [];
    console.log(`Migrating ${tasks.length} legacy tasks...`);
    for (const t of tasks) {
        if (!t.id) continue;
        await prisma.task.create({
            data: {
                id: t.id,
                title: t.title || null,
                description: t.description || null,
                type: t.type || 'once',
                rewardTokens: parseFloat(t.rewardTokens) || 0,
                requiresLink: !!t.requiresLink,
                actionUrl: t.actionUrl || null,
                status: t.status || 'ACTIVE',
                createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
            }
        });
    }

    // 11. Migrate User Submitted Pairs
    const submittedPairs = await readJson('user_submitted_pairs.json') || [];
    console.log(`Migrating ${submittedPairs.length} user submitted pairs...`);
    for (const p of submittedPairs) {
        if (!p.id) continue;
        if (!validUserIds.has(p.userId)) {
            console.warn(`Skipping submitted pair ${p.id}: User ${p.userId} does not exist`);
            continue;
        }
        await prisma.userSubmittedPair.create({
            data: {
                id: p.id,
                userId: p.userId,
                contractAddress: p.contractAddress,
                chainId: p.chainId || null,
                symbol: p.symbol || null,
                name: p.name || null,
                priceUsd: p.priceUsd ? String(p.priceUsd) : null,
                liquidity: p.liquidity ? parseFloat(p.liquidity) : null,
                dexUrl: p.dexUrl || null,
                isBoosted: !!p.isBoosted,
                boostExpiry: p.boostExpiry ? new Date(p.boostExpiry) : null,
                createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
            }
        });
    }

    // 12. Migrate Singletons into SystemConfig
    console.log('Migrating system configuration singletons...');
    const singletons = [
        { key: 'reveal', file: 'reveal.json' },
        { key: 'missionSettings', file: 'missionSettings.json' },
        { key: 't2e_config', file: 't2e_config.json' },
        { key: 'activity', file: 'activity.json' }
    ];

    for (const s of singletons) {
        const val = await readJson(s.file);
        if (val !== null) {
            console.log(`Saving system config singleton for ${s.key}...`);
            await prisma.systemConfig.create({
                data: {
                    key: s.key,
                    value: val
                }
            });
        }
    }

    console.log('Migration successfully completed!');
}

main()
    .catch((e) => {
        console.error('Fatal migration error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
