import express from 'express';
import { optionalAuth } from '../middleware/authMiddleware.js';
import { getNews, getSignals, streamSignals, recordVisitor, getGlobalStats } from '../controllers/publicController.js';

const router = express.Router();

router.get('/news', getNews);
router.get('/signals/stream', optionalAuth, streamSignals);
router.get('/signals', optionalAuth, getSignals);
router.post('/stats/visit', recordVisitor);
router.get('/stats', getGlobalStats);

export default router;
