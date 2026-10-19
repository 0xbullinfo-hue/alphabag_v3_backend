// SPDX-License-Identifier: MIT
// PATCH: app.js — Hardened CORS & security headers + secure admin seed wiring
// Fixes:
//   1. Removed wildcard CORS fallback
//   2. Added CSP, HSTS, body limits
//   3. Wired /api/admin-seed for one-time bootstrap (remove after first admin)

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/env.js';
import authRoutes from './routes/authRoutes.js';
import t2eRoutes from './routes/t2eRoutes.js';
import airdropRoutes from './routes/airdropRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import adminSeedRoutes from './routes/adminSeedRoutes.js';
import { aiRouter, cexRouter, dexRouter, marketRouter, portfolioRouter, streamRouter, whaleRouter } from './routes/serviceRoutes.js';
import { configRouter, rpcRouter, securityRouter } from './routes/integrationRoutes.js';
import proxyRoutes from './routes/proxyRoutes.js';
import bubblemapsProxyRouter from './routes/bubblemapsProxy.js';
import publicRoutes from './routes/publicRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import communityRoutes from './routes/communityRoutes.js';
import { verifyToken, verifyAdmin } from './middleware/authMiddleware.js';
import { errorHandler } from './middleware/errorHandler.js';
import providerHealthRoutes from './routes/providerHealthRoutes.js';
import cookieParser from 'cookie-parser';
import { csrfProtection, toOrigin } from './middleware/csrfMiddleware.js';

const app = express();

app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

// ── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", config.frontendUrl],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

// ── CORS ───────────────────────────────────────────────────────────────────
const allowedFrontendOrigin = toOrigin(config.frontendUrl);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (config.isProduction) {
      if (toOrigin(origin) === allowedFrontendOrigin) return callback(null, true);
      console.warn(`[CORS] Blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
    if (
      origin.startsWith('http://localhost:') || 
      origin.startsWith('https://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('https://127.0.0.1:') ||
      origin.startsWith('http://[::1]:')
    ) {
      return callback(null, true);
    }
    console.warn(`[CORS] Blocked origin in dev: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-ID', 'X-Client-Timestamp'],
  maxAge: 86400,
};

app.use(cors(corsOptions));

// ── Body Parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());
app.use(csrfProtection);

import {
  leaderboardLimiter,
  proxyLimiter,
  rpcLimiter,
  publicBalanceLimiter,
  adminLimiter,
  seedLimiter,
  apiLimiter
} from './middleware/rateLimiters.js';

// Dedicated route limiters (auth limiters are mounted per-endpoint in authRoutes.js to prevent double counting)
app.use('/api/t2e/leaderboard', leaderboardLimiter);
app.use('/api/proxy', proxyLimiter);
app.use('/api/rpc', rpcLimiter);
app.use('/api/portfolio/public-balances', publicBalanceLimiter);
app.use('/api/admin', adminLimiter);
app.use('/api/admin-seed', seedLimiter);
app.use('/api', apiLimiter);

// ── Health Check & Service Root ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  if (req.accepts('html')) {
    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>AlphaBAG Backend · Operational</title>
          <style>
            body { background: #0B0E11; color: #EAECEF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #181A20; border: 1px solid #2B313A; padding: 36px 44px; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); text-align: center; max-width: 460px; }
            .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(14, 203, 129, 0.1); border: 1px solid rgba(14, 203, 129, 0.25); color: #0ECB81; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }
            .dot { width: 8px; height: 8px; background: #0ECB81; border-radius: 50%; box-shadow: 0 0 8px #0ECB81; }
            h1 { font-size: 24px; margin: 0 0 8px 0; font-weight: 700; color: #EAECEF; letter-spacing: -0.5px; }
            p { font-size: 13px; color: #848E9C; margin: 0 0 24px 0; line-height: 1.5; }
            .links { display: flex; gap: 12px; justify-content: center; font-size: 12px; font-weight: 600; }
            a { color: #F0B90B; text-decoration: none; padding: 8px 16px; border-radius: 4px; background: rgba(240, 185, 11, 0.08); border: 1px solid rgba(240, 185, 11, 0.25); transition: all 0.15s ease; }
            a:hover { background: rgba(240, 185, 11, 0.2); }
            a.secondary { color: #EAECEF; background: rgba(255, 255, 255, 0.05); border-color: #2B313A; }
            a.secondary:hover { background: rgba(255, 255, 255, 0.1); }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge"><div class="dot"></div> Systems Operational</div>
            <h1>AlphaBAG V3 API Server</h1>
            <p>The backend microservice is active on port 3003 with live Web3 feeds, pricing streams, and database connectivity.</p>
            <div class="links">
              <a href="/health">Health API</a>
              <a href="${config.frontendUrl}" class="secondary" target="_blank">Open App UI &rarr;</a>
            </div>
          </div>
        </body>
      </html>
    `);
  } else {
    res.status(200).json({ status: 'ok', service: 'alphabag-backend', version: '3.0.0', timestamp: new Date().toISOString() });
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/t2e', t2eRoutes);
app.use('/api/airdrop', airdropRoutes);
app.use('/api/admin', verifyToken, verifyAdmin, adminRoutes);
app.use('/api/market', marketRouter);
app.use('/api/config', configRouter);
app.use('/api/security', securityRouter);
app.use('/api/rpc', rpcRouter);
app.use('/api/dex', dexRouter);
app.use('/api/whales', whaleRouter);
app.use('/api/ai', aiRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/stream', streamRouter);
app.use('/api/cex', cexRouter);
app.use('/api/proxy/bubblemaps', proxyLimiter, bubblemapsProxyRouter);
app.use('/api/proxy', proxyRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/community', communityRoutes);
app.use('/api', publicRoutes);
app.use('/api/system/health', providerHealthRoutes);

if (!config.isProduction) {
  app.use('/api/admin-seed', adminSeedRoutes);
}

// ── 404 Handler ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global Error Handler ───────────────────────────────────────────────────
app.use(errorHandler);

// ── Production Startup Guards ────────────────────────────────────────────────
if (config.isProduction) {
  if (config.frontendUrl === '*') {
    console.error('[FATAL] FRONTEND_URL cannot be wildcard (*) in production');
    process.exit(1);
  }
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    console.error('[FATAL] JWT_SECRET must be at least 32 characters in production');
    process.exit(1);
  }
  if (config.dbUrl && config.dbUrl.includes('localhost')) {
    console.warn('[WARN] Production is using a localhost database URL');
  }
  if (config.adminSetupSecret) {
    console.warn('[WARN] ADMIN_SETUP_SECRET is set. The /api/admin-seed route is active. Remove it after first admin creation.');
  }
}

export default app;
