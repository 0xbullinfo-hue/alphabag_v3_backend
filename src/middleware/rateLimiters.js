import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many auth attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const nonceLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: 'Too many nonce requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many verification attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const leaderboardLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many leaderboard requests, please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const proxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many proxy requests, please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const rpcLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Too many RPC requests, please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const publicBalanceLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many public balance requests. Please try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { error: 'Too many admin requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const seedLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many seed attempts. This endpoint is heavily rate-limited.' },
    standardHeaders: true,
    legacyHeaders: false,
});
