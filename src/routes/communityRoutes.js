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

const router = express.Router();

// Discussions
router.get('/discussions', getDiscussions);
router.post('/discussions', createDiscussion);
router.post('/discussions/:id/vote', voteDiscussion);
router.post('/discussions/:id/insightful', toggleInsightful);
router.post('/discussions/:id/comments', addComment);

// Live Audio Podcast / Spaces
router.get('/podcast', getPodcast);
router.post('/podcast/chat', sendPodcastChat);
router.post('/podcast/start', startPodcastSpace);
router.post('/podcast/vote', votePodcast);

// Widgets & Metadata
router.get('/ads', getSponsoredAd);
router.get('/trending', getTrendingTopics);
router.get('/analysts', getTopAnalysts);

export default router;
