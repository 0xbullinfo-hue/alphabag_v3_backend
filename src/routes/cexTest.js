import { Router } from 'express';
import { testConnection } from '../controllers/cexTestController.js';
import { verifyToken } from '../middleware/auth.js';

const router = Router();
router.post('/test', verifyToken, testConnection);

export default router;
