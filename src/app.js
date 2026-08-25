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
import adminRoutes from './routes/adminRoutes.js';
import adminSeedRoutes from './routes/adminSeedRoutes.js';
import { verifyToken, verifyAdmin } from './middleware/authMiddleware.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

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
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (config.isProduction) {
      if (origin === config.frontendUrl) return callback(null, true);
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400,
};

app.use(cors(corsOptions));

// ── Body Parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── Rate Limiting ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many auth attempts, please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 500,
  message: { error: 'Too many admin requests, please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const seedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many seed attempts. This endpoint is heavily rate-limited.' },
  standardHeaders: true, legacyHeaders: false,
});

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);
app.use('/api/admin', adminLimiter);
app.use('/api/admin-seed', seedLimiter);

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/t2e', t2eRoutes);
app.use('/api/admin', verifyToken, verifyAdmin, adminRoutes);

// SECURE BOOTSTRAP: One-time admin seed route.
// Remove this line after creating your first admin and redeploy.
app.use('/api/admin-seed', adminSeedRoutes);

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
