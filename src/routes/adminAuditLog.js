import { Router } from 'express';
import { verifyToken, requireAdmin } from '../middleware/auth.js';
import { store } from '../services/storeService.js';

const router = Router();

router.get('/audit-log', verifyToken, requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  
  const logs = (await store.read('audit_logs')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const entries = logs.slice(offset, offset + limit);
  res.json({ entries, total: logs.length, limit, offset });
});

export default router;
