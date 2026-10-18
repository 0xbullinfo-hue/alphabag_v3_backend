import express from 'express';
import { optionalAuth, verifyToken } from '../middleware/authMiddleware.js';
import {
  createComment,
  createCommunity,
  createDiscussion,
  getCommunityAds,
  getDiscussion,
  getLivePodcastState,
  getTopAnalysts,
  getTrendingTopics,
  joinCommunity,
  leaveCommunity,
  listCommunities,
  listDiscussions,
  requestPodcastMic,
  voteDiscussion,
} from '../controllers/communityController.js';

const router = express.Router();

router.get('/communities', optionalAuth, listCommunities);
router.get('/discussions', optionalAuth, listDiscussions);
router.get('/discussions/:id', optionalAuth, getDiscussion);
router.get('/ads', optionalAuth, getCommunityAds);
router.get('/trending', optionalAuth, getTrendingTopics);
router.get('/analysts', optionalAuth, getTopAnalysts);
router.get('/podcast', optionalAuth, getLivePodcastState);

router.post('/communities', verifyToken, createCommunity);
router.post('/communities/:slug/join', verifyToken, joinCommunity);
router.delete('/communities/:slug/join', verifyToken, leaveCommunity);
router.post('/discussions', verifyToken, createDiscussion);
router.post('/discussions/:id/comments', verifyToken, createComment);
router.post('/discussions/:id/vote', verifyToken, voteDiscussion);
router.post('/podcast/mic', verifyToken, requestPodcastMic);

export default router;
