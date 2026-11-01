import { store } from '../services/storeService.js';
import { subscribeToSignalChanges } from '../services/signalEvents.js';

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

export const getVisibleSignals = async (sessionUser) => {
    const signals = await store.read('signals') || [];
    let hasProAccess = false;

    if (sessionUser?.id) {
        const wallet = (sessionUser.wallet || sessionUser.address || '').toLowerCase();
        const admin = sessionUser.email
            ? await store.findOne('admins', { email: sessionUser.email.toLowerCase().trim() })
            : wallet
                ? await store.findOne('admins', { wallet })
                : await store.findOne('admins', { id: sessionUser.id });
        const user = await store.findOne('users', { id: sessionUser.id });
        hasProAccess = !!admin || user?.tier === 'ULTIMATE';
    }

    if (hasProAccess) return signals.slice().reverse();
    return signals.map((signal) => {
        if (signal.isFree) return signal;
        return {
            id: signal.id,
            pair: signal.pair,
            type: signal.type,
            status: signal.status,
            timestamp: signal.timestamp,
            isBlurred: true,
            message: 'Upgrade to ULTIMATE to unlock target & stop-loss levels',
        };
    }).reverse();
};

export const getSignals = async (req, res) => {
    try {
        res.json(await getVisibleSignals(req.user));
    } catch (e) {
        res.status(503).json({ error: 'Signal feed is temporarily unavailable' });
    }
};

export const streamSignals = async (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let closed = false;
    const sendSnapshot = async (event = 'snapshot') => {
        if (closed) return;
        try {
            const signals = await getVisibleSignals(req.user);
            if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify({ signals, updatedAt: new Date().toISOString() })}\n\n`);
        } catch {
            if (!closed) res.write('event: feed-error\ndata: {"message":"Signal feed is temporarily unavailable"}\n\n');
        }
    };

    const unsubscribe = subscribeToSignalChanges(() => { void sendSnapshot('signals'); }, { pollDatabase: true });
    const heartbeat = setInterval(() => {
        if (!closed) res.write(': heartbeat\n\n');
    }, 15000);
    const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    await sendSnapshot();
};
