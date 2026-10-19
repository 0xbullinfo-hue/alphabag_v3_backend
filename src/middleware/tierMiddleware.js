// SPDX-License-Identifier: MIT
// Server-side tier enforcement. The tier is always read from the database (never from the JWT
// or from the request body), so a stale token or a spoofed client cannot grant access.
import { store } from '../services/storeService.js';

export const PREMIUM_TIERS = ['PREMIUM', 'ALPHA_VIP', 'ULTIMATE'];

/**
 * requireTier(['PREMIUM', 'ALPHA_VIP', 'ULTIMATE'])
 * Must run after verifyToken. Admins always pass. Attaches req.dbUser for handlers.
 */
export const requireTier = (allowedTiers = PREMIUM_TIERS) => async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const dbUser = await store.findOne('users', { id: req.user.id });
    if (!dbUser) {
      return res.status(401).json({ error: 'Account not found' });
    }
    if (dbUser.isBanned) {
      return res.status(403).json({ error: 'Your account is suspended' });
    }
    req.dbUser = dbUser;
    if (req.user.isAdmin || allowedTiers.includes(String(dbUser.tier || 'FREE').toUpperCase())) {
      return next();
    }
    return res.status(403).json({ error: 'A premium tier is required for this feature', requiredTiers: allowedTiers });
  } catch (error) {
    if (error?.name === 'StoreUnavailableError') {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
    console.error('[tierMiddleware] error:', error);
    return res.status(500).json({ error: 'Tier verification failed' });
  }
};
