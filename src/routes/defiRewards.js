import { Router } from 'express';
import { getDefiRewards } from '../controllers/defiRewardsController.js';
import { verifyToken } from '../middleware/auth.js';

const router = Router();
router.get('/rewards', verifyToken, getDefiRewards);

export default router;
