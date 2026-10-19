// SPDX-License-Identifier: MIT
import express from 'express';
import {
    getDiscussions,
    createDiscussion,
    voteDiscussion,
    toggleInsightful,
    addComment,
    getPodcast,
    sendPodcastChat,
    startPodcastSpace,
    votePodcast,
    getSponsoredAd,
    getTrendingTopics,
    getTopAnalysts
} from '../controllers/communityController.js';

import rateLimit from 'express-rate-limit';
import { verifyToken } from '../middleware/authMiddleware.js';
import { requireTier, PREMIUM_TIERS } from '../middleware/tierMiddleware.js';

const router = express.Router();

// Every community route needs a valid session AND a premium tier read from the database.
router.use(verifyToken, requireTier(PREMIUM_TIERS));

// Per-user write limiter (runs after verifyToken, so the key is the user id, never the IP).
const communityWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => String(req.user?.id || 'anonymous'),
    message: { error: 'Too many community actions, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
});

// Discussions
router.get('/discussions', getDiscussions);
router.post('/discussions', communityWriteLimiter, createDiscussion);
router.post('/discussions/:id/vote', communityWriteLimiter, voteDiscussion);
router.post('/discussions/:id/insightful', communityWriteLimiter, toggleInsightful);
router.post('/discussions/:id/comments', communityWriteLimiter, addComment);

// Live Audio Podcast / Spaces
router.get('/podcast', getPodcast);
router.post('/podcast/chat', communityWriteLimiter, sendPodcastChat);
router.post('/podcast/start', communityWriteLimiter, startPodcastSpace);
router.post('/podcast/vote', communityWriteLimiter, votePodcast);

// Widgets & Metadata
router.get('/ads', getSponsoredAd);
router.get('/trending', getTrendingTopics);
router.get('/analysts', getTopAnalysts);

export default router;
