import express from 'express';
import { verifyToken } from '../middleware/authMiddleware.js';
import {
  createComment,
  createDiscussion,
  getDiscussion,
  joinCommunity,
  leaveCommunity,
  listCommunities,
  listDiscussions,
  voteDiscussion,
} from '../controllers/communityController.js';

const router = express.Router();
router.use(verifyToken);
router.get('/communities', listCommunities);
router.post('/communities/:slug/join', joinCommunity);
router.delete('/communities/:slug/join', leaveCommunity);
router.get('/discussions', listDiscussions);
router.post('/discussions', createDiscussion);
router.get('/discussions/:id', getDiscussion);
router.post('/discussions/:id/comments', createComment);
router.post('/discussions/:id/vote', voteDiscussion);

export default router;