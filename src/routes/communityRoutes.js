import express from 'express';
import { verifyToken } from '../middleware/authMiddleware.js';
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
router.use(verifyToken);
router.get('/communities', listCommunities);
router.post('/communities', createCommunity);
router.post('/communities/:slug/join', joinCommunity);
router.delete('/communities/:slug/join', leaveCommunity);
router.get('/discussions', listDiscussions);
router.post('/discussions', createDiscussion);
router.get('/discussions/:id', getDiscussion);
router.post('/discussions/:id/comments', createComment);
router.post('/discussions/:id/vote', voteDiscussion);
router.get('/ads', getCommunityAds);
router.get('/trending', getTrendingTopics);
router.get('/analysts', getTopAnalysts);
router.get('/podcast', getLivePodcastState);
router.post('/podcast/mic', requestPodcastMic);

export default router;
