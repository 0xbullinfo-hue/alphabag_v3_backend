// SPDX-License-Identifier: MIT
import { store } from '../services/storeService.js';

// Default initial discussions seed (Reddit / Web3 style)
const DEFAULT_DISCUSSIONS = [
    {
        id: 'disc-bag-genesis',
        title: '$BAG Tokenomics Architecture & Genesis Pass Staking Yield',
        ticker: '$BAG',
        category: 'TOKENOMICS',
        sentiment: 'BULLISH',
        content: `Comprehensive breakdown of the AlphaBAG Protocol fee-switch model and liquidity lock.\n\n• Protocol Revenue Distribution: 60% of all premium analytics subscription fees are automatically routed into the $BAG open-market buyback & burn smart contract.\n• Genesis Pass Staking: Yield multipliers scale based on pass tier (Free: 1x, Premium: 2.5x, Ultimate: 5x). Current APR averaging 28.4% on native single-sided staking pool.\n• Vesting Schedule: Team tokens locked in a 36-month linear vesting smart contract with zero unlocks until Month 12.\n\nThe real-yield engine ensures deflationary pressure as trader onboarding accelerates.`,
        authorWallet: '0x71C...89A2',
        authorTier: 'ULTIMATE',
        isPro: true,
        upvotes: 84,
        downvotes: 3,
        userVoted: undefined,
        isInsightful: true,
        insightfulCount: 38,
        tokenMetrics: {
            marketCap: '$14.2M',
            fdv: '$32.0M',
            circulatingSupply: '44.3%',
            unlockDate: 'Month 12 Cliff (Safe)'
        },
        comments: [
            {
                id: 'comm-bag-1',
                authorWallet: '0x34A...B901',
                authorTier: 'PREMIUM',
                isPro: true,
                content: 'The buyback mechanism already burned over 2.4M $BAG in Q3. Very few DeFi tools actually distribute real revenue like this.',
                sentiment: 'BULLISH',
                upvotes: 19,
                createdAt: new Date(Date.now() - 3600000 * 4).toISOString(),
                replies: [
                    {
                        id: 'comm-bag-1-1',
                        authorWallet: '0x88F...4210',
                        authorTier: 'FREE',
                        isPro: false,
                        content: 'Are the buyback txs verifiable on Etherscan in real-time?',
                        sentiment: 'NEUTRAL',
                        upvotes: 6,
                        createdAt: new Date(Date.now() - 3600000 * 3).toISOString()
                    },
                    {
                        id: 'comm-bag-1-2',
                        authorWallet: '0x71C...89A2',
                        authorTier: 'ULTIMATE',
                        isPro: true,
                        content: 'Yes! All buyback hashes are emitted via the FeeDistributor contract event logs and visible on the Protocol Dashboard.',
                        sentiment: 'BULLISH',
                        upvotes: 12,
                        createdAt: new Date(Date.now() - 3600000 * 2).toISOString()
                    }
                ]
            },
            {
                id: 'comm-bag-2',
                authorWallet: '0x12E...77C3',
                authorTier: 'PREMIUM',
                isPro: true,
                content: 'Single-sided staking with zero impermanent loss is the major selling point compared to standard LP pools.',
                sentiment: 'BULLISH',
                upvotes: 11,
                createdAt: new Date(Date.now() - 3600000 * 1).toISOString(),
                replies: []
            }
        ],
        createdAt: new Date(Date.now() - 3600000 * 8).toISOString(),
        isPinned: true
    },
    {
        id: 'disc-sol-breakout',
        title: '$SOL DEX Volume Flipping Mainnet & Raydium Fee Dominance',
        ticker: '$SOL',
        category: 'ALPHA_CALL',
        sentiment: 'BULLISH',
        content: `Solana DEX 24H volume surpassed $3.8B today, driven by continuous memecoin rotations and Jupiter routing efficiency.\n\n• Whale Wallet Clustering: Three smart money clusters tracked via BubbleMaps accumulated over 120,000 SOL between $178 and $184.\n• On-chain TPS consistently above 2,600 without gas spikes.\n• Downside Risk: Watch for validator concentration and potential RPC node throttling during high-volatility trading spikes.`,
        authorWallet: '0x99B...E311',
        authorTier: 'PREMIUM',
        isPro: true,
        upvotes: 67,
        downvotes: 7,
        userVoted: undefined,
        isInsightful: true,
        insightfulCount: 24,
        tokenMetrics: {
            marketCap: '$92.4B',
            fdv: '$114.8B',
            circulatingSupply: '80.5%',
            unlockDate: 'Staking Inflows (+6.2%)'
        },
        comments: [
            {
                id: 'comm-sol-1',
                authorWallet: '0x45C...9081',
                authorTier: 'FREE',
                isPro: false,
                content: 'Raydium daily protocol fees crossed Uniswap on multiple days this week. Incredible liquidity flywheel.',
                sentiment: 'BULLISH',
                upvotes: 14,
                createdAt: new Date(Date.now() - 3600000 * 5).toISOString(),
                replies: []
            }
        ],
        createdAt: new Date(Date.now() - 3600000 * 12).toISOString()
    },
    {
        id: 'disc-render-depin',
        title: '$RENDER AI GPU Cluster Demand vs Cloud Hyperscalers',
        ticker: '$RENDER',
        category: 'PROJECT_REVIEW',
        sentiment: 'BULLISH',
        content: `Deep dive into Render Network’s transition from 3D VFX rendering to enterprise AI inference.\n\n• Key Takeaway: Decentralized compute cost for Llama-3 fine-tuning is currently ~58% lower on Render nodes compared to AWS p4d.24xlarge instances.\n• BME (Burn-and-Mint Equilibrium): 140,000 RNDR burned last month against compute client vouchers.\n• Thesis: Strong macro hedge for AI compute scarcity as frontier model providers expand training budgets.`,
        authorWallet: '0x52D...A1F0',
        authorTier: 'ULTIMATE',
        isPro: true,
        upvotes: 52,
        downvotes: 2,
        userVoted: undefined,
        isInsightful: true,
        insightfulCount: 31,
        tokenMetrics: {
            marketCap: '$2.8B',
            fdv: '$3.4B',
            circulatingSupply: '71.2%',
            unlockDate: 'Linear BME Mint'
        },
        comments: [],
        createdAt: new Date(Date.now() - 3600000 * 18).toISOString()
    },
    {
        id: 'disc-sui-move',
        title: '$SUI Move VM Parallel Execution Benchmarks & Ecosystem TVL Wave',
        ticker: '$SUI',
        category: 'UTILITY',
        sentiment: 'NEUTRAL',
        content: `Benchmarking Sui’s object-centric storage model against EVM state transitions.\n\n• Positives: Sub-second finality (390ms) on non-conflicting single-writer transactions.\n• Concerns: Heavy token unlocks scheduled throughout next quarter (~64M SUI/month). Even with high TVL growth in Navi and Scallop, supply dilution must be carefully monitored by spot holders.`,
        authorWallet: '0x21F...882E',
        authorTier: 'PREMIUM',
        isPro: true,
        upvotes: 41,
        downvotes: 8,
        userVoted: undefined,
        isInsightful: true,
        insightfulCount: 18,
        tokenMetrics: {
            marketCap: '$5.6B',
            fdv: '$18.2B',
            circulatingSupply: '28.1%',
            unlockDate: 'Monthly Cliff (+2.1%)'
        },
        comments: [],
        createdAt: new Date(Date.now() - 3600000 * 24).toISOString()
    }
];

// Live audio space / podcast state
let livePodcastState = {
    isLive: true,
    title: "Alpha Roundtable: Whale Inflows, Tokenomics Audits & Q4 Breakouts",
    topic: "Live Smart Money Tracking & On-Chain Liquidity Migration",
    hostName: "AlphaDesk Lead Analyst",
    hostWallet: "0x71C...89A2",
    listenersCount: 142,
    isListening: false,
    stageSpeakers: [
        { wallet: "0x71C...89A2", name: "AlphaDesk Lead", isHost: true, isSpeaking: true, tier: "ULTIMATE" },
        { wallet: "0x34A...B901", name: "MacroDeFi_Whale", isHost: false, isSpeaking: false, tier: "PREMIUM" },
        { wallet: "0x99B...E311", name: "SolanaScreener", isHost: false, isSpeaking: true, tier: "ULTIMATE" }
    ],
    liveChat: [
        { id: "c1", authorWallet: "0x44D...88F1", tier: "PREMIUM", isVip: true, message: "What are your thoughts on the $BAG buyback rate this week?", timestamp: "1m ago" },
        { id: "c2", authorWallet: "0x12E...77C3", tier: "FREE", isVip: false, message: "Listening in from Singapore. Great alpha on the DEX volume shift.", timestamp: "3m ago" },
        { id: "c3", authorWallet: "0x88F...4210", tier: "ULTIMATE", isVip: true, message: "Whale wallet 0x3a9 just swept 40 ETH into liquidity pool.", timestamp: "5m ago" }
    ],
    upvotes: 96,
    userUpvoted: false
};

const SPONSORED_AD = {
    id: 'ad-bag-genesis',
    partnerName: 'AlphaBAG Genesis Pass',
    tagline: 'Unlock institutional on-chain trade alerts, whale cluster detection & fee share yield.',
    description: 'Lifetime pass holders receive 100% access to all VIP screener tools, private Discord stages, and daily smart money flow reports.',
    badge: 'VERIFIED ECOSYSTEM',
    ctaText: 'Explore Pass Utility',
    ctaUrl: '#/airdrop',
    logoUrl: '/favicon.svg'
};

const TRENDING_TOPICS = [
    { ticker: '$BAG', topic: 'Genesis Staking & Deflationary Buyback Engine', posts: 148, sentiment: 'BULLISH' },
    { ticker: '$SOL', topic: 'DEX Volume Surpasses Ethereum Mainnet', posts: 124, sentiment: 'BULLISH' },
    { ticker: '$RENDER', topic: 'Decentralized AI Compute Cluster Expansion', posts: 89, sentiment: 'BULLISH' },
    { ticker: '$SUI', topic: 'Ecosystem TVL Benchmark & Lockup Analysis', posts: 72, sentiment: 'NEUTRAL' },
    { ticker: '$PEPE', topic: 'Whale Accumulation Signals on BubbleMaps', posts: 64, sentiment: 'BULLISH' }
];

const TOP_ANALYSTS = [
    { rank: '1', wallet: '0x71C...89A2', tier: 'ULTIMATE', score: '98.4%', focus: 'Tokenomics & Vesting' },
    { rank: '2', wallet: '0x99B...E311', tier: 'ULTIMATE', score: '94.1%', focus: 'DEX Liquidity & Momentum' },
    { rank: '3', wallet: '0x52D...A1F0', tier: 'PREMIUM', score: '91.8%', focus: 'DePIN & AI Compute' },
    { rank: '4', wallet: '0x34A...B901', tier: 'PREMIUM', score: '88.5%', focus: 'On-Chain Smart Money' }
];

// In-memory discussions store initialized with defaults
let discussionsStore = [...DEFAULT_DISCUSSIONS];

export const getDiscussions = async (req, res) => {
    try {
        return res.json(discussionsStore);
    } catch (err) {
        console.error('[CommunityController] getDiscussions error:', err);
        return res.status(500).json({ error: 'Failed to retrieve discussions' });
    }
};

export const createDiscussion = async (req, res) => {
    try {
        const { title, ticker, category, sentiment, content, authorWallet, authorTier, isPro, tokenMetrics } = req.body;
        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required' });
        }

        const newPost = {
            id: `disc-${Date.now()}`,
            title: title.trim(),
            ticker: ticker ? (ticker.startsWith('$') ? ticker.toUpperCase() : `$${ticker.toUpperCase()}`) : '$ALPHA',
            category: category || 'TOKENOMICS',
            sentiment: sentiment || 'BULLISH',
            content: content.trim(),
            authorWallet: authorWallet || '0x000...0000',
            authorTier: authorTier || 'FREE',
            isPro: Boolean(isPro),
            upvotes: 1,
            downvotes: 0,
            userVoted: 'UP',
            isInsightful: false,
            insightfulCount: 0,
            tokenMetrics: tokenMetrics || undefined,
            comments: [],
            createdAt: new Date().toISOString()
        };

        discussionsStore = [newPost, ...discussionsStore];
        return res.status(201).json(newPost);
    } catch (err) {
        console.error('[CommunityController] createDiscussion error:', err);
        return res.status(500).json({ error: 'Failed to create discussion' });
    }
};

export const voteDiscussion = async (req, res) => {
    try {
        const { id } = req.params;
        const { type } = req.body; // 'UP' | 'DOWN'

        const post = discussionsStore.find(d => d.id === id);
        if (!post) {
            return res.status(404).json({ error: 'Discussion not found' });
        }

        if (type === 'UP') {
            post.upvotes += 1;
        } else if (type === 'DOWN') {
            post.downvotes += 1;
        }

        return res.json({ success: true, upvotes: post.upvotes, downvotes: post.downvotes });
    } catch (err) {
        console.error('[CommunityController] voteDiscussion error:', err);
        return res.status(500).json({ error: 'Failed to vote' });
    }
};

export const toggleInsightful = async (req, res) => {
    try {
        const { id } = req.params;
        const post = discussionsStore.find(d => d.id === id);
        if (!post) {
            return res.status(404).json({ error: 'Discussion not found' });
        }

        post.isInsightful = !post.isInsightful;
        post.insightfulCount += post.isInsightful ? 1 : -1;

        return res.json({ success: true, isInsightful: post.isInsightful, insightfulCount: post.insightfulCount });
    } catch (err) {
        console.error('[CommunityController] toggleInsightful error:', err);
        return res.status(500).json({ error: 'Failed to toggle insightful' });
    }
};

export const addComment = async (req, res) => {
    try {
        const { id } = req.params;
        const { content, sentiment, replyToId, authorWallet, authorTier, isPro } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Comment content is required' });
        }

        const post = discussionsStore.find(d => d.id === id);
        if (!post) {
            return res.status(404).json({ error: 'Discussion not found' });
        }

        const newComment = {
            id: `comm-${Date.now()}`,
            authorWallet: authorWallet || '0x000...0000',
            authorTier: authorTier || 'FREE',
            isPro: Boolean(isPro),
            content: content.trim(),
            sentiment: sentiment || 'NEUTRAL',
            upvotes: 1,
            createdAt: new Date().toISOString(),
            replies: []
        };

        if (replyToId) {
            const parent = post.comments.find(c => c.id === replyToId);
            if (parent) {
                parent.replies = [...(parent.replies || []), newComment];
            } else {
                post.comments = [newComment, ...post.comments];
            }
        } else {
            post.comments = [newComment, ...post.comments];
        }

        return res.status(201).json(newComment);
    } catch (err) {
        console.error('[CommunityController] addComment error:', err);
        return res.status(500).json({ error: 'Failed to add comment' });
    }
};

export const getPodcast = async (req, res) => {
    try {
        return res.json(livePodcastState);
    } catch (err) {
        console.error('[CommunityController] getPodcast error:', err);
        return res.status(500).json({ error: 'Failed to retrieve podcast' });
    }
};

export const sendPodcastChat = async (req, res) => {
    try {
        const { message, authorWallet, tier, isVip } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const chatEntry = {
            id: `msg-${Date.now()}`,
            authorWallet: authorWallet || '0x000...0000',
            tier: tier || 'FREE',
            isVip: Boolean(isVip),
            message: message.trim().slice(0, 280),
            timestamp: 'Just now'
        };

        livePodcastState.liveChat = [chatEntry, ...livePodcastState.liveChat].slice(0, 200);
        return res.status(201).json(chatEntry);
    } catch (err) {
        console.error('[CommunityController] sendPodcastChat error:', err);
        return res.status(500).json({ error: 'Failed to send chat' });
    }
};

export const startPodcastSpace = async (req, res) => {
    try {
        const { title, topic, hostName, hostWallet, tier } = req.body;
        if (!title || !topic) {
            return res.status(400).json({ error: 'Title and topic are required' });
        }

        livePodcastState = {
            isLive: true,
            title: title.trim(),
            topic: topic.trim(),
            hostName: hostName || 'Community Host',
            hostWallet: hostWallet || '0x000...0000',
            listenersCount: 1,
            isListening: true,
            stageSpeakers: [
                {
                    wallet: hostWallet || '0x000...0000',
                    name: hostName || 'Community Host',
                    isHost: true,
                    isSpeaking: true,
                    tier: tier || 'PREMIUM'
                }
            ],
            liveChat: [
                {
                    id: `msg-${Date.now()}`,
                    authorWallet: hostWallet || '0x000...0000',
                    tier: tier || 'PREMIUM',
                    isVip: true,
                    message: `Welcome to "${title.trim()}". Live audio space is now open for community questions!`,
                    timestamp: 'Just now'
                }
            ],
            upvotes: 1,
            userUpvoted: true
        };

        return res.status(201).json(livePodcastState);
    } catch (err) {
        console.error('[CommunityController] startPodcastSpace error:', err);
        return res.status(500).json({ error: 'Failed to start podcast space' });
    }
};

export const votePodcast = async (req, res) => {
    try {
        livePodcastState.upvotes += 1;
        return res.json({ success: true, upvotes: livePodcastState.upvotes });
    } catch (err) {
        console.error('[CommunityController] votePodcast error:', err);
        return res.status(500).json({ error: 'Failed to vote on podcast' });
    }
};

export const getSponsoredAd = async (req, res) => {
    return res.json(SPONSORED_AD);
};

export const getTrendingTopics = async (req, res) => {
    return res.json(TRENDING_TOPICS);
};

export const getTopAnalysts = async (req, res) => {
    return res.json(TOP_ANALYSTS);
};
