import express from 'express';
import { providerHealth, providerHealthByName } from '../controllers/providerHealthController.js';
import { verifyToken, verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/providers', verifyToken, verifyAdmin, providerHealth);
router.get('/providers/:provider', verifyToken, verifyAdmin, providerHealthByName);

export default router;
