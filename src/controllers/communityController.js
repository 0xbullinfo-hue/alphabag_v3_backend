import { randomUUID } from 'node:crypto';
import { prisma } from '../services/storeService.js';

export const DEFAULT_COMMUNITIES = [
  { slug: 'general', name: 'General', description: 'Open crypto conversations and community questions.' },
  { slug: 'tokenomics', name: 'Tokenomics', description: 'Supply, vesting, emissions, and token design.' },
  { slug: 'utility-yield', name: 'Utility & Yield', description: 'Protocols, use cases, and yield opportunities.' },
  { slug: 'project-reviews', name: 'Project Reviews', description: 'Community-led project research and reviews.' },
  { slug: 'alpha-calls', name: 'Alpha Calls', description: 'Trade ideas and due diligence.' },
  { slug: 'security-audits', name: 'Security & Audits', description: 'Contract safety, audits, and risk discussion.' },
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
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const communities = await prisma.community.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { memberships: true } },
        memberships: { where: { userId }, select: { id: true }, take: 1 },
      },
    });
    res.json(communities.map((community) => ({
      slug: community.slug,
      name: community.name,
      description: community.description,
      memberCount: community._count.memberships,
      isMember: community.memberships.length > 0,
    })));
  } catch (error) {
    console.error('[Community] list communities failed:', error);
    res.status(500).json({ error: 'Could not load communities.' });
  }
}

export async function joinCommunity(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const community = await prisma.community.findUnique({ where: { slug: req.params.slug } });
    if (!community) return res.status(404).json({ error: 'Community not found.' });
    await prisma.communityMembership.upsert({
      where: { communityId_userId: { communityId: community.id, userId } },
      update: {},
      create: { communityId: community.id, userId },
    });
    res.json({ success: true, slug: community.slug, isMember: true });
  } catch (error) {
    console.error('[Community] join failed:', error);
    res.status(500).json({ error: 'Could not join community.' });
  }
}

export async function leaveCommunity(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const community = await prisma.community.findUnique({ where: { slug: req.params.slug } });
    if (!community) return res.status(404).json({ error: 'Community not found.' });
    await prisma.communityMembership.deleteMany({ where: { communityId: community.id, userId } });
    res.json({ success: true, slug: community.slug, isMember: false });
  } catch (error) {
    console.error('[Community] leave failed:', error);
    res.status(500).json({ error: 'Could not leave community.' });
  }
}

export async function listDiscussions(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const memberships = await prisma.communityMembership.findMany({ where: { userId }, select: { communityId: true } });
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
    res.json(discussions.map((discussion) => serializeDiscussion(discussion, {
      userId,
      isMember: joinedIds.has(discussion.communityId),
    })));
  } catch (error) {
    console.error('[Community] list discussions failed:', error);
    res.status(500).json({ error: 'Could not load discussions.' });
  }
}

export async function getDiscussion(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const discussion = await prisma.communityDiscussion.findUnique({
      where: { id: req.params.id },
      include: discussionInclude,
    });
    if (!discussion) return res.status(404).json({ error: 'Thread not found.' });
    const membership = await prisma.communityMembership.findUnique({
      where: { communityId_userId: { communityId: discussion.communityId, userId } },
      select: { id: true },
    });
    res.json(serializeDiscussion(discussion, { userId, isMember: Boolean(membership) }));
  } catch (error) {
    console.error('[Community] get discussion failed:', error);
    res.status(500).json({ error: 'Could not load the thread.' });
  }
}

export async function createDiscussion(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  const { title, content, communitySlug = 'general', ticker, category, sentiment } = req.body || {};
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 160) {
    return res.status(400).json({ error: 'Title must be between 3 and 160 characters.' });
  }
  if (typeof content !== 'string' || content.trim().length < 1 || content.trim().length > 12000) {
    return res.status(400).json({ error: 'Post text must be between 1 and 12,000 characters.' });
  }
  if (ticker !== undefined && (typeof ticker !== 'string' || ticker.length > 24)) {
    return res.status(400).json({ error: 'Ticker must be 24 characters or fewer.' });
  }
  try {
    const community = await prisma.community.findUnique({ where: { slug: communitySlug } });
    if (!community) return res.status(404).json({ error: 'Community not found.' });
    const membership = await prisma.communityMembership.findUnique({
      where: { communityId_userId: { communityId: community.id, userId } },
      select: { id: true },
    });
    if (!membership) return res.status(403).json({ error: 'Join this community before creating a thread.' });
    const created = await prisma.communityDiscussion.create({
      data: {
        id: randomUUID(), communityId: community.id, authorId: userId,
        title: title.trim(), content: content.trim(), ticker: ticker?.trim() || null,
        category: category || null, sentiment: ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(sentiment) ? sentiment : null,
      },
      include: discussionInclude,
    });
    res.status(201).json(serializeDiscussion(created, { userId, isMember: true }));
  } catch (error) {
    console.error('[Community] create discussion failed:', error);
    res.status(500).json({ error: 'Could not publish the thread.' });
  }
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
    const discussion = await prisma.communityDiscussion.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!discussion) return res.status(404).json({ error: 'Thread not found.' });
    if (parentId) {
      const parent = await prisma.communityComment.findFirst({ where: { id: parentId, discussionId: discussion.id }, select: { id: true } });
      if (!parent) return res.status(400).json({ error: 'Reply target is not in this thread.' });
    }
    const comment = await prisma.communityComment.create({
      data: { id: randomUUID(), discussionId: discussion.id, authorId: userId, parentId: parentId || null, content: content.trim(), displayMode },
      include: { author: { select: { username: true } } },
    });
    res.status(201).json({ comment: formatComment(comment) });
  } catch (error) {
    console.error('[Community] create comment failed:', error);
    res.status(500).json({ error: 'Could not post the comment.' });
  }
}

export async function voteDiscussion(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  const { type } = req.body || {};
  if (!['UP', 'DOWN'].includes(type)) return res.status(400).json({ error: 'Vote type must be UP or DOWN.' });
  try {
    const discussion = await prisma.communityDiscussion.findUnique({ where: { id: req.params.id }, select: { id: true, communityId: true } });
    if (!discussion) return res.status(404).json({ error: 'Thread not found.' });
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
    res.json({ success: true, userVoted: existing?.type === type ? null : type, upvotes: votes.UP || 0, downvotes: votes.DOWN || 0 });
  } catch (error) {
    console.error('[Community] vote failed:', error);
    res.status(500).json({ error: 'Could not record your reaction.' });
  }
}