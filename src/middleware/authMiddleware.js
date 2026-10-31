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
    if (req.cookies && req.cookies['alphabag_session']) return req.cookies['alphabag_session'];
    return null;
}

const normalizedWallet = (decoded) => (decoded.wallet || decoded.address || '').toLowerCase().trim();
const devBypassAllowed = () => !config.isProduction && process.env.ALLOW_DEV_AUTH_BYPASS === 'true';

async function findAdmin(decoded, wallet) {
    if (decoded.id) {
        const record = await store.findOne('admins', { id: decoded.id });
        if (record) return record;
    }
    const email = decoded.email?.toLowerCase().trim();
    if (email) {
        const record = await store.findOne('admins', { email });
        if (record) return record;
    }
    return wallet ? store.findOne('admins', { wallet }) : null;
}

// Invalid credentials produce a non-valid session. Store errors deliberately
// escape so middleware can delegate outages to Express's error handler.
async function resolveSession(decoded, { allowDevBypass = false } = {}) {
    const wallet = normalizedWallet(decoded);
    const isAdminClaim = decoded.isAdmin === true;
    let record;
    let kind;

    if (isAdminClaim) {
        record = await findAdmin(decoded, wallet);
        kind = 'admin';
    } else {
        if (decoded.id) record = await store.findOne('users', { id: decoded.id });
        if (!record && wallet) record = await store.findOne('users', { wallet });
        kind = 'user';
    }

    if (!record) {
        if (allowDevBypass && devBypassAllowed()) {
            return { valid: true, principal: { ...decoded, kind, tier: kind === 'user' ? 'FREE' : decoded.tier, isAdmin: kind === 'admin', tokenVersion: 0 } };
        }
        return { valid: false, reason: 'not_found', principal: null };
    }
    if (kind === 'user' && record.isBanned) return { valid: false, reason: 'banned', principal: null };

    const tokenVersion = record.tokenVersion ?? 0;
    if ((decoded.tv ?? 0) !== tokenVersion) return { valid: false, reason: 'revoked', principal: null };

    let isAdmin = kind === 'admin';
    if (kind === 'user') {
        const currentWallet = (record.verifiedWallet || '').toLowerCase().trim();
        if (wallet && currentWallet && wallet === currentWallet) {
            isAdmin = !!(await store.findOne('admins', {
                wallet: { equals: currentWallet, mode: 'insensitive' },
            }));
        }
    }

    return {
        valid: true,
        principal: {
            ...decoded,
            id: record.id,
            email: record.email ?? decoded.email,
            wallet: record.wallet || record.verifiedWallet || wallet || undefined,
            tier: kind === 'user' ? (record.tier || 'FREE') : decoded.tier,
            kind,
            isAdmin,
            tokenVersion,
        },
    };
}

function verifyDecodedToken(tokenValue) {
    const decoded = jwt.verify(tokenValue, config.jwtSecret, { algorithms: ['HS256'] });
    if (decoded.iss && decoded.iss !== 'alphabag-api') {
        const error = new Error('Unauthorized: Invalid token issuer');
        error.authStatusCode = 401;
        throw error;
    }
    if (decoded.aud && decoded.aud !== 'alphabag-client') {
        const error = new Error('Unauthorized: Invalid token audience');
        error.authStatusCode = 401;
        throw error;
    }
    return decoded;
}

export const verifyToken = async (req, res, next) => {
    const tokenValue = extractToken(req);
    if (!tokenValue) return res.status(401).json({ error: 'No token provided' });

    let decoded;
    try {
        decoded = verifyDecodedToken(tokenValue);
    } catch (err) {
        return res.status(401).json({ error: err.authStatusCode ? err.message : 'Unauthorized: Invalid or expired token' });
    }
    try {
        const session = await resolveSession(decoded, { allowDevBypass: true });
        if (!session.valid) {
            if (session.reason === 'banned') return res.status(403).json({ error: 'Forbidden: Account has been suspended' });
            if (session.reason === 'revoked') return res.status(401).json({ error: 'Unauthorized: Session has been revoked or expired' });
            return res.status(401).json({ error: `Unauthorized: ${decoded.isAdmin ? 'Admin' : 'User'} record not found` });
        }
        req.user = session.principal;
        return next();
    } catch (err) {
        return next(err);
    }
};

export const optionalAuth = async (req, res, next) => {
    const tokenValue = extractToken(req);
    if (!tokenValue) {
        req.user = null;
        return next();
    }
    let decoded;
    try {
        decoded = verifyDecodedToken(tokenValue);
    } catch {
        req.user = null;
        return next();
    }
    try {
        const session = await resolveSession(decoded);
        req.user = session.valid ? session.principal : null;
        return next();
    } catch (err) {
        return next(err);
    }
};

export const requireAuth = verifyToken;

export const verifyAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Forbidden: Admin privileges required' });
    next();
};
