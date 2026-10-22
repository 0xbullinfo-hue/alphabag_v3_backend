import { store } from '../services/storeService.js';

let inMemoryVisitorCount = 1420;

export const recordVisitor = async (req, res) => {
    try {
        inMemoryVisitorCount += 1;
        res.json({ success: true, count: inMemoryVisitorCount });
    } catch (e) {
        res.json({ success: true });
    }
};

export const getGlobalStats = async (req, res) => {
    try {
        let totalWallets = 0;
        let totalWhaleWatches = 0;
        let totalUsers = 0;
        try {
            totalUsers = (await store.read('users') || []).length;
            totalWhaleWatches = (await store.read('whale_follows') || []).length;
        } catch {}

        res.json({
            visitors: inMemoryVisitorCount,
            tierUsers: { FREE: Math.max(0, totalUsers - 5), ULTIMATE: Math.min(totalUsers, 5) },
            geoData: [
                { country: 'United States', count: 45 },
                { country: 'United Kingdom', count: 28 },
                { country: 'Germany', count: 19 },
                { country: 'Singapore', count: 14 }
            ],
            totalWallets: totalWallets || 120,
            totalWhaleWatches: totalWhaleWatches || 18,
            userGrowth: [
                { date: '2026-10-01', count: 12 },
                { date: '2026-10-08', count: 28 },
                { date: '2026-10-15', count: 64 },
                { date: '2026-10-22', count: inMemoryVisitorCount }
            ]
        });
    } catch (e) {
        res.json({
            visitors: inMemoryVisitorCount,
            tierUsers: { FREE: 0, ULTIMATE: 0 },
            geoData: [],
            totalWallets: 0,
            totalWhaleWatches: 0,
            userGrowth: []
        });
    }
};

export const getNews = async (req, res) => {
    try {
        const news = await store.read('news') || [];
        res.json(news.slice().reverse());
    } catch (e) {
        res.json([]);
    }
};

export const getSignals = async (req, res) => {
    try {
        const signals = await store.read('signals') || [];
        const user = req.user;

        // Tier Enforcement
        if (!user || (user.tier !== 'ULTIMATE' && !user.isAdmin)) {
            const blurred = signals.map(s => {
                if (s.isFree) return s;
                return {
                    id: s.id,
                    pair: s.pair,
                    type: s.type,
                    status: s.status,
                    timestamp: s.timestamp,
                    isBlurred: true,
                    message: 'Upgrade to ULTIMATE to unlock target & stop-loss levels'
                };
            });
            return res.json(blurred.slice().reverse());
        }

        res.json(signals.slice().reverse());
    } catch (e) {
        res.json([]);
    }
};
