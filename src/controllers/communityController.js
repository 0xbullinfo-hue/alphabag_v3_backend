// SPDX-License-Identifier: MIT
// Community discussions and live audio space.
//
// Security model:
//  - Every route is authenticated and tier-gated in communityRoutes.js; identity (wallet, tier, pro flag)
//    is ALWAYS derived from the database user, never from the request body.
//  - Votes are one-per-user and reversible; writes are length-bounded and rate-limited.
//  - No fabricated content: stores start empty, counters are computed from real activity.
// State is process-local (single instance). Move to Prisma models before scaling horizontally.
import crypto from 'crypto';

const MAX_DISCUSSIONS = 500;
const MAX_COMMENTS_PER_POST = 300;
const MAX_CHAT_MESSAGES = 200;
const PRESENCE_WINDOW_MS = 60_000;

const CATEGORIES = ['TOKENOMICS', 'MACRO', 'DEFI', 'TECHNICAL', 'ONCHAIN', 'NEWS', 'GENERAL'];
const SENTIMENTS = ['BULLISH', 'BEARISH', 'NEUTRAL'];
const HOST_TIERS = ['ULTIMATE', 'ALPHA_VIP'];

const maskWallet = (wallet, fallback = 'anon') => {
    const w = String(wallet || '');
    return /^0x[a-fA-F0-9]{40}$/.test(w) ? `${w.slice(0, 6)}...${w.slice(-4)}` : fallback;
};

const identityOf = (req) => {
    const user = req.dbUser || {};
    const tier = String(user.tier || 'FREE').toUpperCase();
    return {
        userId: user.id || req.user?.id,
        authorWallet: maskWallet(user.verifiedWallet, String(user.id || 'anon').slice(0, 8)),
        authorTier: tier,
        isPro: tier !== 'FREE',
    };
};

const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '');

let discussionsStore = [];
const voteLedger = new Map();      // postId -> Map(userId -> 'UP' | 'DOWN')
const insightfulLedger = new Map(); // postId -> Set(userId)
const presence = new Map();        // userId -> lastSeenMs
let podcastVoters = new Set();

let livePodcastState = {
    isLive: false,
    title: '',
    topic: '',
    hostName: '',
    hostWallet: '',
    hostUserId: null,
    listenersCount: 0,
    isListening: false,
    stageSpeakers: [],
    liveChat: [],
    upvotes: 0,
    userUpvoted: false,
};

const viewForUser = (post, userId) => ({
    ...post,
    userVoted: voteLedger.get(post.id)?.get(userId) || null,
    isInsightful: Boolean(insightfulLedger.get(post.id)?.has(userId)),
    insightfulCount: insightfulLedger.get(post.id)?.size || 0,
});

export const getDiscussions = async (req, res) => {
    try {
        return res.json(discussionsStore.map((post) => viewForUser(post, req.user.id)));
    } catch (err) {
        console.error('[CommunityController] getDiscussions error:', err);
        return res.status(500).json({ error: 'Failed to retrieve discussions' });
    }
};

export const createDiscussion = async (req, res) => {
    try {
        const title = cleanText(req.body?.title, 140);
        const content = cleanText(req.body?.content, 5000);
        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required' });
        }

        const rawTicker = cleanText(req.body?.ticker, 13).replace(/^\$/, '').toUpperCase();
        if (rawTicker && !/^[A-Z0-9]{1,12}$/.test(rawTicker)) {
            return res.status(400).json({ error: 'Ticker must be 1-12 letters or digits' });
        }
        const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'GENERAL';
        const sentiment = SENTIMENTS.includes(req.body?.sentiment) ? req.body.sentiment : 'NEUTRAL';
        const who = identityOf(req);

        const newPost = {
            id: `disc-${crypto.randomUUID()}`,
            title,
            ticker: rawTicker ? `$${rawTicker}` : null,
            category,
            sentiment,
            content,
            authorWallet: who.authorWallet,
            authorTier: who.authorTier,
            authorId: who.userId,
            isPro: who.isPro,
            upvotes: 0,
            downvotes: 0,
            comments: [],
            createdAt: new Date().toISOString(),
        };

        discussionsStore = [newPost, ...discussionsStore].slice(0, MAX_DISCUSSIONS);
        return res.status(201).json(viewForUser(newPost, who.userId));
    } catch (err) {
        console.error('[CommunityController] createDiscussion error:', err);
        return res.status(500).json({ error: 'Failed to create discussion' });
    }
};

export const voteDiscussion = async (req, res) => {
    try {
        const { id } = req.params;
        const type = req.body?.type;
        if (type !== 'UP' && type !== 'DOWN') {
            return res.status(400).json({ error: "type must be 'UP' or 'DOWN'" });
        }
        const post = discussionsStore.find((d) => d.id === id);
        if (!post) return res.status(404).json({ error: 'Discussion not found' });

        const ledger = voteLedger.get(id) || new Map();
        const previous = ledger.get(req.user.id);
        // Undo the previous vote, then apply the new one (same vote again = remove it).
        if (previous === 'UP') post.upvotes -= 1;
        if (previous === 'DOWN') post.downvotes -= 1;
        if (previous === type) {
            ledger.delete(req.user.id);
        } else {
            ledger.set(req.user.id, type);
            if (type === 'UP') post.upvotes += 1;
            else post.downvotes += 1;
        }
        voteLedger.set(id, ledger);

        return res.json({
            success: true,
            upvotes: post.upvotes,
            downvotes: post.downvotes,
            userVoted: ledger.get(req.user.id) || null,
        });
    } catch (err) {
        console.error('[CommunityController] voteDiscussion error:', err);
        return res.status(500).json({ error: 'Failed to vote' });
    }
};

export const toggleInsightful = async (req, res) => {
    try {
        const { id } = req.params;
        const post = discussionsStore.find((d) => d.id === id);
        if (!post) return res.status(404).json({ error: 'Discussion not found' });

        const set = insightfulLedger.get(id) || new Set();
        if (set.has(req.user.id)) set.delete(req.user.id);
        else set.add(req.user.id);
        insightfulLedger.set(id, set);

        return res.json({ success: true, isInsightful: set.has(req.user.id), insightfulCount: set.size });
    } catch (err) {
        console.error('[CommunityController] toggleInsightful error:', err);
        return res.status(500).json({ error: 'Failed to toggle insightful' });
    }
};

export const addComment = async (req, res) => {
    try {
        const { id } = req.params;
        const content = cleanText(req.body?.content, 1000);
        if (!content) return res.status(400).json({ error: 'Comment content is required' });

        const post = discussionsStore.find((d) => d.id === id);
        if (!post) return res.status(404).json({ error: 'Discussion not found' });
        if (post.comments.length >= MAX_COMMENTS_PER_POST) {
            return res.status(429).json({ error: 'This discussion has reached its comment limit' });
        }

        const who = identityOf(req);
        const newComment = {
            id: `comm-${crypto.randomUUID()}`,
            authorWallet: who.authorWallet,
            authorTier: who.authorTier,
            authorId: who.userId,
            isPro: who.isPro,
            content,
            sentiment: SENTIMENTS.includes(req.body?.sentiment) ? req.body.sentiment : 'NEUTRAL',
            upvotes: 0,
            createdAt: new Date().toISOString(),
            replies: [],
        };

        const replyToId = typeof req.body?.replyToId === 'string' ? req.body.replyToId : null;
        const parent = replyToId ? post.comments.find((c) => c.id === replyToId) : null;
        if (parent) parent.replies = [...(parent.replies || []), newComment];
        else post.comments = [newComment, ...post.comments];

        return res.status(201).json(newComment);
    } catch (err) {
        console.error('[CommunityController] addComment error:', err);
        return res.status(500).json({ error: 'Failed to add comment' });
    }
};

export const getPodcast = async (req, res) => {
    try {
        const now = Date.now();
        presence.set(req.user.id, now);
        for (const [userId, seen] of presence) {
            if (now - seen > PRESENCE_WINDOW_MS) presence.delete(userId);
        }
        return res.json({
            ...livePodcastState,
            listenersCount: livePodcastState.isLive ? presence.size : 0,
            isListening: livePodcastState.isLive,
            userUpvoted: podcastVoters.has(req.user.id),
        });
    } catch (err) {
        console.error('[CommunityController] getPodcast error:', err);
        return res.status(500).json({ error: 'Failed to retrieve podcast' });
    }
};

export const sendPodcastChat = async (req, res) => {
    try {
        if (!livePodcastState.isLive) {
            return res.status(409).json({ error: 'There is no live space right now' });
        }
        const message = cleanText(req.body?.message, 280);
        if (!message) return res.status(400).json({ error: 'Message is required' });

        const who = identityOf(req);
        const chatEntry = {
            id: `msg-${crypto.randomUUID()}`,
            authorWallet: who.authorWallet,
            tier: who.authorTier,
            isVip: who.authorTier === 'ULTIMATE' || who.authorTier === 'ALPHA_VIP',
            message,
            timestamp: new Date().toISOString(),
        };
        livePodcastState.liveChat = [chatEntry, ...livePodcastState.liveChat].slice(0, MAX_CHAT_MESSAGES);
        return res.status(201).json(chatEntry);
    } catch (err) {
        console.error('[CommunityController] sendPodcastChat error:', err);
        return res.status(500).json({ error: 'Failed to send chat' });
    }
};

export const startPodcastSpace = async (req, res) => {
    try {
        const who = identityOf(req);
        if (!req.user?.isAdmin && !HOST_TIERS.includes(who.authorTier)) {
            return res.status(403).json({ error: 'Only ULTIMATE or ALPHA_VIP members can host a space' });
        }
        if (livePodcastState.isLive && livePodcastState.hostUserId !== who.userId && !req.user?.isAdmin) {
            return res.status(409).json({ error: 'A space is already live' });
        }
        const title = cleanText(req.body?.title, 120);
        const topic = cleanText(req.body?.topic, 240);
        if (!title || !topic) return res.status(400).json({ error: 'Title and topic are required' });

        const hostName = cleanText(req.body?.hostName, 40) || 'Community Host';
        podcastVoters = new Set();
        presence.clear();
        presence.set(who.userId, Date.now());
        livePodcastState = {
            isLive: true,
            title,
            topic,
            hostName,
            hostWallet: who.authorWallet,
            hostUserId: who.userId,
            listenersCount: 1,
            isListening: true,
            stageSpeakers: [{ wallet: who.authorWallet, name: hostName, isHost: true, isSpeaking: true, tier: who.authorTier }],
            liveChat: [],
            upvotes: 0,
            userUpvoted: false,
        };
        return res.status(201).json(livePodcastState);
    } catch (err) {
        console.error('[CommunityController] startPodcastSpace error:', err);
        return res.status(500).json({ error: 'Failed to start podcast space' });
    }
};

export const votePodcast = async (req, res) => {
    try {
        if (!livePodcastState.isLive) return res.status(409).json({ error: 'There is no live space right now' });
        if (podcastVoters.has(req.user.id)) {
            podcastVoters.delete(req.user.id);
            livePodcastState.upvotes = Math.max(0, livePodcastState.upvotes - 1);
        } else {
            podcastVoters.add(req.user.id);
            livePodcastState.upvotes += 1;
        }
        return res.json({ success: true, upvotes: livePodcastState.upvotes, userUpvoted: podcastVoters.has(req.user.id) });
    } catch (err) {
        console.error('[CommunityController] votePodcast error:', err);
        return res.status(500).json({ error: 'Failed to vote on podcast' });
    }
};

// First-party promo card for the platform's own pass (not third-party advertising).
const SPONSORED_AD = {
    id: 'ad-bag-genesis',
    partnerName: 'AlphaBAG Genesis Pass',
    tagline: 'Unlock institutional on-chain trade alerts, whale cluster detection & fee share yield.',
    description: 'Pass holders receive access to the premium screener tools and daily smart money flow reports.',
    badge: 'FIRST-PARTY',
    ctaText: 'Explore Pass Utility',
    ctaUrl: '#/airdrop',
    logoUrl: '/favicon.svg',
};

export const getSponsoredAd = async (req, res) => res.json(SPONSORED_AD);

// Trending topics are computed from real discussions of the last 24 hours.
export const getTrendingTopics = async (req, res) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const byTicker = new Map();
    for (const post of discussionsStore) {
        if (!post.ticker || Date.parse(post.createdAt) < since) continue;
        const entry = byTicker.get(post.ticker) || { ticker: post.ticker, topic: post.title, posts: 0, tally: { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 } };
        entry.posts += 1;
        entry.tally[post.sentiment] = (entry.tally[post.sentiment] || 0) + 1;
        byTicker.set(post.ticker, entry);
    }
    const trending = [...byTicker.values()]
        .sort((a, b) => b.posts - a.posts)
        .slice(0, 5)
        .map(({ ticker, topic, posts, tally }) => ({
            ticker,
            topic,
            posts,
            sentiment: Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0],
        }));
    return res.json(trending);
};

// Top analysts are ranked by net upvotes on their real posts.
export const getTopAnalysts = async (req, res) => {
    const byAuthor = new Map();
    for (const post of discussionsStore) {
        const entry = byAuthor.get(post.authorId) || { wallet: post.authorWallet, tier: post.authorTier, net: 0, categories: new Map() };
        entry.net += post.upvotes - post.downvotes;
        entry.categories.set(post.category, (entry.categories.get(post.category) || 0) + 1);
        byAuthor.set(post.authorId, entry);
    }
    const ranked = [...byAuthor.values()]
        .sort((a, b) => b.net - a.net)
        .slice(0, 10)
        .map((entry, index) => ({
            rank: String(index + 1),
            wallet: entry.wallet,
            tier: entry.tier,
            score: `${entry.net} net votes`,
            focus: [...entry.categories.entries()].sort((a, b) => b[1] - a[1])[0][0],
        }));
    return res.json(ranked);
};
