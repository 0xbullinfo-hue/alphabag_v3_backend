// SPDX-License-Identifier: MIT
// PATCH: authMiddleware.js — Zero hardcoded wallets, pinned HS256 algorithm, HttpOnly cookie support, session tokenVersion check

import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { store } from '../services/storeService.js';

function extractToken(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
        const bearer = authHeader.split(' ');
        return bearer.length === 2 && bearer[0].toLowerCase() === 'bearer' ? bearer[1] : authHeader;
    }
    if (req.cookies && req.cookies['alphabag_session']) {
        return req.cookies['alphabag_session'];
    }
    return null;
}

export const verifyToken = async (req, res, next) => {
    const tokenValue = extractToken(req);

    if (!tokenValue) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(tokenValue, config.jwtSecret, { algorithms: ['HS256'] });

        if (decoded.iss && decoded.iss !== 'alphabag-api') {
            return res.status(401).json({ error: 'Unauthorized: Invalid token issuer' });
        }
        if (decoded.aud && decoded.aud !== 'alphabag-client') {
            return res.status(401).json({ error: 'Unauthorized: Invalid token audience' });
        }
        
        // Re-verify admin status and tokenVersion from DB (F-11 / R6)
        const wallet = (decoded.wallet || decoded.address || '').toLowerCase();
        let isAdmin = false;
        let dbRecord = null;

        if (decoded.isAdmin) {
            if (wallet) {
                dbRecord = await store.findOne('admins', { wallet });
            } else if (decoded.email) {
                dbRecord = await store.findOne('admins', { email: decoded.email.toLowerCase().trim() });
            } else if (decoded.id) {
                dbRecord = await store.findOne('admins', { id: decoded.id });
            }
            if (!dbRecord && !(!config.isProduction && process.env.ALLOW_DEV_AUTH_BYPASS === 'true')) {
                return res.status(401).json({ error: 'Unauthorized: Admin record not found' });
            }
            isAdmin = true;
        } else {
            if (decoded.id) {
                dbRecord = await store.findOne('users', { id: decoded.id });
            }
            if (!dbRecord && wallet) {
                dbRecord = await store.findOne('users', { wallet });
            }
            if (!dbRecord && !(!config.isProduction && process.env.ALLOW_DEV_AUTH_BYPASS === 'true')) {
                return res.status(401).json({ error: 'Unauthorized: User record not found' });
            }
            if (dbRecord?.isBanned) {
                return res.status(403).json({ error: 'Forbidden: Account has been suspended' });
            }
            // Check if user is actually in admins table
            if (wallet) {
                const adminRecord = await store.findOne('admins', { wallet });
                if (adminRecord) isAdmin = true;
            }
        }

        // Validate tokenVersion (session invalidation)
        if (dbRecord) {
            const tokenTv = decoded.tv !== undefined ? decoded.tv : 0;
            const currentTv = dbRecord.tokenVersion !== undefined ? dbRecord.tokenVersion : 0;
            if (tokenTv !== currentTv) {
                return res.status(401).json({ error: 'Unauthorized: Session has been revoked or expired' });
            }
        }

        req.user = {
            ...decoded,
            isAdmin
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }
};

export const optionalAuth = async (req, res, next) => {
    const tokenValue = extractToken(req);
    if (!tokenValue) {
        req.user = null;
        return next();
    }

    try {
        const decoded = jwt.verify(tokenValue, config.jwtSecret, { algorithms: ['HS256'] });
        const wallet = (decoded.wallet || decoded.address || '').toLowerCase();
        let isAdmin = !!decoded.isAdmin;
        if (wallet) {
            const adminRecord = await store.findOne('admins', { wallet });
            isAdmin = !!adminRecord;
        }

        req.user = {
            ...decoded,
            isAdmin
        };
        next();
    } catch (err) {
        req.user = null;
        next();
    }
};

export const requireAuth = verifyToken;

export const verifyAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    if (!req.user.isAdmin) {
        return res.status(403).json({ error: 'Forbidden: Admin privileges required' });
    }
    next();
};
