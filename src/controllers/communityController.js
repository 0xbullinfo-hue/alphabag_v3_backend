import { randomUUID } from 'node:crypto';
import { prisma } from '../services/storeService.js';

export const DEFAULT_COMMUNITIES = [
  { slug: 'defi', name: 'DeFi & Liquidity', description: 'Decentralized exchanges, liquidity pools, lending, and yield mechanics.' },
  { slug: 'degen', name: 'Degen Plays & Scalping', description: 'High-volatility setups, sniper calls, launchpads, and momentum plays.' },
  { slug: 'memes', name: 'Memecoins & Culture', description: 'Viral memecoin trends, narrative rotations, and community takeovers.' },
  { slug: 'ai-depin', name: 'AI Agents & DePIN', description: 'Autonomous crypto AI agents, decentralized compute, and GPU networks.' },
  { slug: 'layer1-layer2', name: 'Layer 1 & Layer 2 Rollups', description: 'Ethereum L2s, Solana, Bitcoin layers, and alternative L1 ecosystems.' },
  { slug: 'rwa', name: 'Real World Assets (RWA)', description: 'Tokenized US Treasuries, institutional funds, credit, and commodities.' },
  { slug: 'security-audits', name: 'Security & Audits', description: 'Exploit forensic breakdowns, formal audits, and vulnerability alerts.' },
  { slug: 'tokenomics', name: 'Tokenomics & Vesting', description: 'Cliff unlocks, emission curves, FDV analysis, and buyback structures.' },
  { slug: 'airdrops', name: 'Airdrops & Testnets', description: 'Retroactive guides, testnet quests, node runners, and points systems.' },
  { slug: 'perp-leverage', name: 'Perps & Leverage', description: 'Funding rates, open interest, liquidations, and futures positioning.' },
  { slug: 'restaking-lst', name: 'Staking & Restaking', description: 'EigenLayer, Symbiotic, LRT yields, and shared security.' },
  { slug: 'cross-chain', name: 'Cross-Chain & Bridges', description: 'Interoperability, LayerZero, Wormhole, CCIP, and bridge security.' },
  { slug: 'macro', name: 'Crypto Macro & Policy', description: 'Central bank rates, spot ETF flows, global regulations, and liquidity cycles.' },
  { slug: 'general', name: 'General Discussion', description: 'Open market discussions, news reaction, and community questions.' },
];

// Fallback in-memory state when DB is in dev mode or offline
const inMemoryCommunities = new Map();
const inMemoryMemberships = new Map();
const inMemoryDiscussions = [
  {
    id: 'disc-genesis-1',
    title: 'AlphaBAG Genesis Staking & Fee-Share Activation Details',
    ticker: '$BAG',
    category: 'DEFI',
    sentiment: 'BULLISH',
    communitySlug: 'defi',
    communityName: 'DeFi & Liquidity',
    authorName: 'AlphaDesk Core',
    upvotes: 42,
    downvotes: 1,
    content: 'Full breakdown of the 60% protocol fee-share mechanism distributing automated buyback yields to staked $BAG wallets every epoch. Staking contracts have completed dual independent audits.',
    previewText: 'Full breakdown of the 60% protocol fee-share mechanism distributing automated buyback yields…',
    createdAt: new Date().toISOString(),
    isPinned: true,
    comments: [
      {
        id: 'comm-1',
        authorName: '0x71C...894B',
        displayMode: 'VISIBLE',
        content: 'Yield mechanics look solid. Are payouts distributed in USDC or auto-compounded in $BAG?',
        createdAt: new Date(Date.now() - 3600000).toISOString(),
      },
    ],
  },
  {
    id: 'disc-solana-rotations',
    title: 'Solana DEX Volume vs Ethereum L2 Blob Space: Capital Flow Analysis',
    ticker: '$SOL',
    category: 'LAYER1_LAYER2',
    sentiment: 'BULLISH',
    communitySlug: 'layer1-layer2',
    communityName: 'Layer 1 & Layer 2 Rollups',
    authorName: 'On-Chain Forensics',
    upvotes: 28,
    downvotes: 2,
    content: 'Raydium & Orca daily volume metrics continue outpacing EVM equivalents while Base rollup transactions hit all-time highs. Tracking whale wallets accumulating high-volume liquidity pairs.',
    previewText: 'Raydium & Orca daily volume metrics continue outpacing EVM equivalents…',
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    isPinned: false,
    comments: [],
  },
  {
    id: 'disc-ai-agents',
    title: 'Autonomous On-Chain AI Agents: Execution Sandboxes & Token Utility',
    ticker: '$VIRTUAL',
    category: 'AI_DEPIN',
    sentiment: 'BULLISH',
    communitySlug: 'ai-depin',
    communityName: 'AI Agents & DePIN',
    authorName: 'DePIN Scout',
    upvotes: 19,
    downvotes: 0,
    content: 'Observing smart contract execution capabilities for autonomous AI agents trading across Uniswap v3 and Raydium. Token-gated API endpoints provide immediate micro-billing.',
    previewText: 'Observing smart contract execution capabilities for autonomous AI agents…',
    createdAt: new Date(Date.now() - 14400000).toISOString(),
    isPinned: false,
    comments: [],
  },
];

const getUserId = (req) => !req.user?.isAdmin && typeof req.user?.id === 'string' ? req.user.id : null;

function formatComment(comment) {
  const anonymous = comment.displayMode === 'ANONYMOUS';
  return {
    id: comment.id,
    parentId: comment.parentId || undefined,
    authorName: anonymous ? 'Anonymous member' : (comment.author?.username || 'Community member'),
    displayMode: comment.displayMode,
    content: comment.content,
    createdAt: comment.createdAt,
  };
}

export function serializeDiscussion(discussion, { userId, isMember }) {
  const visibleComments = (discussion.comments || [])
    .filter((comment) => isMember || comment.authorId === userId)
    .map(formatComment);
  const content = discussion.content || '';
  const previewText = content.length > 180
    ? `${content.slice(0, 180).trimEnd()}…`
    : (content ? 'Join this community to read the full thread.' : 'Join this community to read the thread.');
  const votes = discussion.votes || [];
  const userVote = votes.find((vote) => vote.userId === userId)?.type;

  const result = {
    id: discussion.id,
    title: discussion.title,
    ticker: discussion.ticker || '',
    category: discussion.category || 'GENERAL',
    sentiment: discussion.sentiment || undefined,
    communitySlug: discussion.community?.slug,
    communityName: discussion.community?.name,
    communityMember: Boolean(isMember),
    previewOnly: !isMember,
    previewText: isMember ? undefined : previewText,
    content: isMember ? content : undefined,
    authorName: discussion.author?.username || 'Community member',
    upvotes: votes.filter((vote) => vote.type === 'UP').length,
    downvotes: votes.filter((vote) => vote.type === 'DOWN').length,
    userVoted: userVote || undefined,
    comments: visibleComments,
    commentCount: isMember ? (discussion.comments || []).length : visibleComments.length,
    isPinned: Boolean(discussion.isPinned),
    createdAt: discussion.createdAt,
  };
  return result;
}

const discussionInclude = {
  community: { select: { slug: true, name: true } },
  author: { select: { username: true } },
  comments: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { username: true } } },
  },
  votes: { select: { userId: true, type: true } },
};

export async function listCommunities(req, res) {
  const userId = getUserId(req);
  try {
    if (prisma?.community) {
      const dbCommunities = await prisma.community.findMany({
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { memberships: true } },
          memberships: userId ? { where: { userId }, select: { id: true }, take: 1 } : false,
        },
      });
      if (dbCommunities.length > 0) {
        return res.json(dbCommunities.map((community) => ({
          slug: community.slug,
          name: community.name,
          description: community.description,
          memberCount: community._count?.memberships || 0,
          isMember: userId ? (community.memberships && community.memberships.length > 0) : false,
        })));
      }
    }
  } catch (error) {
    console.warn('[Community] list communities DB notice:', error.message);
  }

  // Fallback: DEFAULT_COMMUNITIES + any user-created communities in inMemoryCommunities
  const allList = [
    ...DEFAULT_COMMUNITIES,
    ...Array.from(inMemoryCommunities.values()),
  ];
  return res.json(allList.map((community) => ({
    slug: community.slug,
    name: community.name,
    description: community.description,
    memberCount: community.memberCount || 142,
    isMember: userId ? (inMemoryMemberships.get(`${community.slug}_${userId}`) ?? true) : false,
  })));
}

export async function joinCommunity(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    if (prisma?.community) {
      const community = await prisma.community.findUnique({ where: { slug: req.params.slug } });
      if (community) {
        await prisma.communityMembership.upsert({
          where: { communityId_userId: { communityId: community.id, userId } },
          update: {},
          create: { communityId: community.id, userId },
        });
        return res.json({ success: true, slug: community.slug, isMember: true });
      }
    }
  } catch (error) {
    console.warn('[Community] join DB notice:', error.message);
  }

  inMemoryMemberships.set(`${req.params.slug}_${userId}`, true);
  return res.json({ success: true, slug: req.params.slug, isMember: true });
}

export async function leaveCommunity(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    if (prisma?.community) {
      const community = await prisma.community.findUnique({ where: { slug: req.params.slug } });
      if (community) {
        await prisma.communityMembership.deleteMany({ where: { communityId: community.id, userId } });
        return res.json({ success: true, slug: community.slug, isMember: false });
      }
    }
  } catch (error) {
    console.warn('[Community] leave DB notice:', error.message);
  }

  inMemoryMemberships.set(`${req.params.slug}_${userId}`, false);
  return res.json({ success: true, slug: req.params.slug, isMember: false });
}

export async function listDiscussions(req, res) {
  const userId = getUserId(req);
  try {
    if (prisma?.communityDiscussion) {
      const memberships = userId
        ? await prisma.communityMembership.findMany({ where: { userId }, select: { communityId: true } })
        : [];
      const joinedIds = new Set(memberships.map((item) => item.communityId));
      const where = req.query.communitySlug
        ? { community: { slug: req.query.communitySlug } }
        : {};
      const discussions = await prisma.communityDiscussion.findMany({
        where,
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        take: 100,
        include: discussionInclude,
      });
      if (discussions.length > 0) {
        return res.json(discussions.map((discussion) => serializeDiscussion(discussion, {
          userId,
          isMember: joinedIds.has(discussion.communityId),
        })));
      }
    }
  } catch (error) {
    console.warn('[Community] list discussions DB notice:', error.message);
  }

  // In-memory fallback
  const filtered = req.query.communitySlug
    ? inMemoryDiscussions.filter((d) => d.communitySlug === req.query.communitySlug)
    : inMemoryDiscussions;
  return res.json(filtered.map((d) => ({
    ...d,
    communityMember: Boolean(userId),
    previewOnly: false,
    comments: d.comments || [],
    commentCount: (d.comments || []).length,
  })));
}

export async function getDiscussion(req, res) {
  const userId = getUserId(req);
  try {
    if (prisma?.communityDiscussion) {
      const discussion = await prisma.communityDiscussion.findUnique({
        where: { id: req.params.id },
        include: discussionInclude,
      });
      if (discussion) {
        const membership = userId
          ? await prisma.communityMembership.findUnique({
              where: { communityId_userId: { communityId: discussion.communityId, userId } },
              select: { id: true },
            })
          : null;
        return res.json(serializeDiscussion(discussion, { userId, isMember: Boolean(membership) }));
      }
    }
  } catch (error) {
    console.warn('[Community] get discussion DB notice:', error.message);
  }

  const found = inMemoryDiscussions.find((d) => d.id === req.params.id);
  if (!found) return res.status(404).json({ error: 'Thread not found.' });
  return res.json({
    ...found,
    communityMember: Boolean(userId),
    previewOnly: false,
  });
}

export async function createDiscussion(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  const { title, content, communitySlug = 'general', ticker, category, sentiment } = req.body || {};
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 160) {
    return res.status(400).json({ error: 'Title must be between 3 and 160 characters.' });
  }
  if (typeof content !== 'string' || content.trim().length < 3 || content.trim().length > 12000) {
    return res.status(400).json({ error: 'Post body must be between 3 and 12,000 characters.' });
  }

  try {
    if (prisma?.community && prisma?.communityDiscussion) {
      const community = await prisma.community.findUnique({ where: { slug: communitySlug } });
      if (community) {
        const membership = await prisma.communityMembership.findUnique({
          where: { communityId_userId: { communityId: community.id, userId } },
          select: { id: true },
        });
        if (!membership) return res.status(403).json({ error: 'Join this community before starting a thread.' });

        const discussion = await prisma.communityDiscussion.create({
          data: {
            id: randomUUID(),
            communityId: community.id,
            authorId: userId,
            title: title.trim(),
            content: content.trim(),
            ticker: (ticker && typeof ticker === 'string') ? ticker.trim().toUpperCase() : null,
            category: (category && typeof category === 'string') ? category.trim() : 'GENERAL',
            sentiment: (sentiment && typeof sentiment === 'string') ? sentiment.trim() : null,
          },
          include: discussionInclude,
        });

        return res.status(201).json(serializeDiscussion(discussion, { userId, isMember: true }));
      }
    }
  } catch (error) {
    console.warn('[Community] create discussion DB notice:', error.message);
  }

  // Fallback in-memory creation
  const newDisc = {
    id: `disc-${Date.now()}`,
    title: title.trim(),
    ticker: ticker ? ticker.trim().toUpperCase() : '',
    category: category || communitySlug.toUpperCase().replace(/-/g, '_'),
    sentiment: sentiment || 'BULLISH',
    communitySlug,
    communityName: DEFAULT_COMMUNITIES.find((c) => c.slug === communitySlug)?.name || communitySlug,
    authorName: 'Community member',
    upvotes: 1,
    downvotes: 0,
    userVoted: 'UP',
    content: content.trim(),
    previewText: content.trim().slice(0, 180),
    previewOnly: false,
    communityMember: true,
    createdAt: new Date().toISOString(),
    isPinned: false,
    comments: [],
    commentCount: 0,
  };
  inMemoryDiscussions.unshift(newDisc);
  return res.status(201).json(newDisc);
}

export async function createComment(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  const { content, parentId, displayMode = 'VISIBLE' } = req.body || {};
  if (typeof content !== 'string' || content.trim().length < 1 || content.trim().length > 2000) {
    return res.status(400).json({ error: 'Comment must be between 1 and 2,000 characters.' });
  }
  if (!['VISIBLE', 'ANONYMOUS'].includes(displayMode)) {
    return res.status(400).json({ error: 'displayMode must be VISIBLE or ANONYMOUS.' });
  }

  try {
    if (prisma?.communityComment) {
      const discussion = await prisma.communityDiscussion.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (discussion) {
        if (parentId) {
          const parent = await prisma.communityComment.findFirst({ where: { id: parentId, discussionId: discussion.id }, select: { id: true } });
          if (!parent) return res.status(400).json({ error: 'Reply target is not in this thread.' });
        }
        const comment = await prisma.communityComment.create({
          data: { id: randomUUID(), discussionId: discussion.id, authorId: userId, parentId: parentId || null, content: content.trim(), displayMode },
          include: { author: { select: { username: true } } },
        });
        return res.status(201).json({ comment: formatComment(comment) });
      }
    }
  } catch (error) {
    console.warn('[Community] create comment DB notice:', error.message);
  }

  const commentObj = {
    id: `c-${Date.now()}`,
    parentId: parentId || undefined,
    authorName: displayMode === 'ANONYMOUS' ? 'Anonymous member' : 'Community member',
    displayMode,
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };
  const targetDisc = inMemoryDiscussions.find((d) => d.id === req.params.id);
  if (targetDisc) {
    targetDisc.comments = targetDisc.comments || [];
    targetDisc.comments.push(commentObj);
    targetDisc.commentCount = targetDisc.comments.length;
  }
  return res.status(201).json({ comment: commentObj });
}

export async function voteDiscussion(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  const { type } = req.body || {};
  if (!['UP', 'DOWN'].includes(type)) return res.status(400).json({ error: 'Vote type must be UP or DOWN.' });

  try {
    if (prisma?.communityVote) {
      const discussion = await prisma.communityDiscussion.findUnique({ where: { id: req.params.id }, select: { id: true, communityId: true } });
      if (discussion) {
        const membership = await prisma.communityMembership.findUnique({ where: { communityId_userId: { communityId: discussion.communityId, userId } }, select: { id: true } });
        if (!membership) return res.status(403).json({ error: 'Join this community to react to the thread.' });
        const existing = await prisma.communityVote.findUnique({ where: { discussionId_userId: { discussionId: discussion.id, userId } } });
        if (existing?.type === type) {
          await prisma.communityVote.delete({ where: { id: existing.id } });
        } else {
          await prisma.communityVote.upsert({
            where: { discussionId_userId: { discussionId: discussion.id, userId } },
            update: { type },
            create: { id: randomUUID(), discussionId: discussion.id, userId, type },
          });
        }
        const counts = await prisma.communityVote.groupBy({ by: ['type'], where: { discussionId: discussion.id }, _count: { _all: true } });
        const votes = Object.fromEntries(counts.map((item) => [item.type, item._count._all]));
        return res.json({ success: true, userVoted: existing?.type === type ? null : type, upvotes: votes.UP || 0, downvotes: votes.DOWN || 0 });
      }
    }
  } catch (error) {
    console.warn('[Community] vote DB notice:', error.message);
  }

  return res.json({ success: true, userVoted: type, upvotes: 1, downvotes: 0 });
}

export async function createCommunity(req, res, next) {
  try {
    const userId = getUserId(req);
    const { name, slug, description } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Community name is required (min 2 characters).' });
    }
    const cleanName = name.trim();
    const cleanSlug = (slug && typeof slug === 'string' && slug.trim())
      ? slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      : cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || randomUUID().slice(0, 8);
    const cleanDescription = (description && typeof description === 'string') ? description.trim() : '';

    try {
      if (prisma?.community) {
        const existing = await prisma.community.findUnique({ where: { slug: cleanSlug } });
        if (existing) {
          return res.status(409).json({ error: 'A community with this identifier already exists.' });
        }

        const community = await prisma.community.create({
          data: {
            slug: cleanSlug,
            name: cleanName,
            description: cleanDescription,
            ...(userId ? {
              memberships: {
                create: { userId }
              }
            } : {})
          },
          include: {
            _count: { select: { memberships: true } },
            memberships: userId ? { where: { userId } } : false
          }
        });

        return res.status(201).json({
          slug: community.slug,
          name: community.name,
          description: community.description,
          memberCount: community._count?.memberships ?? 1,
          isMember: Boolean(userId),
        });
      }
    } catch (dbErr) {
      console.warn('[Community] DB createCommunity notice:', dbErr.message);
    }

    // In-memory fallback
    if (inMemoryCommunities.has(cleanSlug)) {
      return res.status(409).json({ error: 'A community with this identifier already exists.' });
    }
    const createdCommunity = {
      slug: cleanSlug,
      name: cleanName,
      description: cleanDescription,
      memberCount: 1,
      isMember: true,
    };
    inMemoryCommunities.set(cleanSlug, createdCommunity);
    if (userId) {
      inMemoryMemberships.set(`${cleanSlug}_${userId}`, true);
    }
    return res.status(201).json(createdCommunity);
  } catch (error) {
    console.error('[Community] create community failed:', error);
    res.status(500).json({ error: 'Could not create community.' });
  }
}

export async function getCommunityAds(req, res) {
  return res.json({
    partnerName: 'AlphaBAG Genesis Pass',
    badge: 'ECOSYSTEM',
    tagline: 'Stake $BAG to earn 60% protocol fee share and unlock Alpha Desk VIP.',
    description: 'AlphaBAG Genesis Pass holders receive perpetual fee rebates, exclusive access to Alpha Desk, and early allocations in partner project pools.',
    ctaText: 'MINT PASS / LEARN MORE',
    ctaUrl: '#/airdrop',
    logoUrl: '/logo.png'
  });
}

export async function getTrendingTopics(req, res) {
  return res.json([
    { ticker: '$BAG', topic: 'Genesis Staking & Fee Switch Activation', posts: 184, sentiment: 'BULLISH' },
    { ticker: '$SOL', topic: 'Solana Breakpoint DEX Rotations', posts: 142, sentiment: 'BULLISH' },
    { ticker: '$BTC', topic: 'Macro Liquidity & Spot ETF Inflows', posts: 98, sentiment: 'BULLISH' },
    { ticker: '$ETH', topic: 'L2 Blob Gas & Restaking Dynamics', posts: 76, sentiment: 'NEUTRAL' },
    { ticker: '$DEGEN', topic: 'Base Launchpad Sniper Volume Surge', posts: 64, sentiment: 'BULLISH' }
  ]);
}

export async function getTopAnalysts(req, res) {
  return res.json([
    { rank: '1', wallet: '0x71C...894B', tier: 'ALPHA_VIP', score: '99.4%', focus: 'Tokenomics & Vesting' },
    { rank: '2', wallet: '0x3F2...1A90', tier: 'ULTIMATE', score: '97.8%', focus: 'DeFi Yield & Perps' },
    { rank: '3', wallet: '0x99A...E431', tier: 'PREMIUM', score: '95.2%', focus: 'Smart Contract Audits' },
    { rank: '4', wallet: '0x18B...55C2', tier: 'ALPHA_VIP', score: '94.0%', focus: 'Memecoin Orderflow' },
    { rank: '5', wallet: '0x4D1...77F8', tier: 'PREMIUM', score: '92.6%', focus: 'Airdrop Metas' }
  ]);
}

export async function getLivePodcastState(req, res) {
  return res.json({
    isLive: true,
    title: 'Alpha Stage: DEX Liquidity Rotations, Whale Inflows & Market Metas',
    topic: '$SOL & Base Microcap Rotations • Real-Time Order Flow',
    hostName: 'AlphaDesk Core',
    hostWallet: '0x884...219A',
    listenersCount: 148,
    isListening: false,
    stageSpeakers: [
      { wallet: '0x884...219A', name: 'AlphaDesk Core', isHost: true, isSpeaking: true, tier: 'ALPHA_VIP' },
      { wallet: '0x71C...894B', name: 'DeFi Researcher', isSpeaking: false, tier: 'ULTIMATE' },
      { wallet: '0x3F2...1A90', name: 'On-Chain Forensics', isSpeaking: false, tier: 'ALPHA_VIP' }
    ],
    liveChat: [
      { id: 'msg-1', authorWallet: '0x123...4567', tier: 'ALPHA_VIP', isVip: true, message: 'Massive accumulation seen on DEX aggregator volume.', timestamp: '1m ago' },
      { id: 'msg-2', authorWallet: '0x999...1111', tier: 'PREMIUM', isVip: false, message: 'Are the token unlocks on schedule for Q4?', timestamp: 'Just now' }
    ],
    upvotes: 46,
    userUpvoted: false
  });
}

export async function requestPodcastMic(req, res) {
  return res.json({
    success: true,
    queued: true,
    message: 'Added to speaker queue. Host will open your mic shortly.'
  });
}
