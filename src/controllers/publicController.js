import { store } from '../services/storeService.js';

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
