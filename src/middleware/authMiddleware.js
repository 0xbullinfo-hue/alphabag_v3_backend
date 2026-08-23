// SPDX-License-Identifier: MIT
// PATCH: authMiddleware.js — Zero hardcoded wallets & database-driven admin check

import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { store } from '../services/storeService.js';

export const verifyToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const bearer = authHeader.split(' ');
    const tokenValue = bearer.length === 2 && bearer[0].toLowerCase() === 'bearer' ? bearer[1] : authHeader;

    try {
        const decoded = jwt.verify(tokenValue, config.jwtSecret);
        
        // Re-verify admin status from DB if wallet is present
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
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }
};

export const optionalAuth = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        req.user = null;
        return next();
    }

    const bearer = authHeader.split(' ');
    const tokenValue = bearer.length === 2 && bearer[0].toLowerCase() === 'bearer' ? bearer[1] : authHeader;

    try {
        const decoded = jwt.verify(tokenValue, config.jwtSecret);
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
