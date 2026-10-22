import { Router } from 'express';
import { verifyToken, requireAdmin } from '../middleware/auth.js';
import { store } from '../services/storeService.js';

const router = Router();

router.get('/audit-log', verifyToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    
    const raw = await store.read('audit_logs');
    const logs = Array.isArray(raw)
      ? [...raw].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      : [];
    const entries = logs.slice(offset, offset + limit);
    return res.json({ entries, total: logs.length, limit, offset });
  } catch (error) {
    console.error('Error fetching admin audit log:', error);
    return res.json({ entries: [], total: 0, limit: 100, offset: 0 });
  }
});

export default router;
