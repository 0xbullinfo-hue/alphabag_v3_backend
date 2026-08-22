
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/env.js';
import { store } from './services/storeService.js';
import bcrypt from 'bcryptjs';
import { connectDB } from './utils/db.js';
import { verifyToken, verifyAdmin } from './middleware/authMiddleware.js';

// Connect to MongoDB if configured
connectDB();

// ===== STARTUP SECURITY VALIDATIONS =====
if (process.env.NODE_ENV === 'production' || process.env.VITE_ENVIRONMENT === 'production') {
    if (process.env.FRONTEND_URL === '*') {
        console.error('CRITICAL SECURITY ERROR: FRONTEND_URL cannot be "*" in production. This exposes the API to any origin.');
        process.exit(1);
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'your_jwt_secret_key_here' || process.env.JWT_SECRET.length < 32) {
        console.error('CRITICAL SECURITY ERROR: Weak or default JWT_SECRET detected in production. Must be at least 32 characters.');
        process.exit(1);
    }
}

// Routes
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import airdropRoutes from './routes/airdropRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import livePairRoutes from './routes/livePairRoutes.js';
import t2eRoutes from './routes/t2eRoutes.js';
import proxyRoutes from './routes/proxyRoutes.js';
import { marketRouter, whaleRouter, aiRouter, portfolioRouter, cexRouter, streamRouter } from './routes/serviceRoutes.js';
import { configRouter, rpcRouter, securityRouter } from './routes/integrationRoutes.js';
import { schemaValidationMiddleware } from './utils/schemaValidator.js';

const app = express();

// Request Debugger (single instance)
app.use((req, res, next) => {
    console.log(`[DEBUG] ${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Initialize Store
store.init().catch(err => console.error('Store Init Failed:', err));

// Middleware
app.use(helmet({
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    contentSecurityPolicy: false,
}));
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc)
        if (!origin) return callback(null, true);
        const allowed = [
            process.env.FRONTEND_URL,
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:3002',
            'http://localhost:3003',
            'http://localhost:3004',
            'http://localhost:3005',
            'http://localhost:5173',
            'http://localhost:5174',
            'http://localhost:5175',
            'http://127.0.0.1:3000',
            'http://127.0.0.1:3001',
            'http://127.0.0.1:3002',
            'http://127.0.0.1:3003',
            'http://127.0.0.1:3004',
            'http://127.0.0.1:3005',
            'http://127.0.0.1:5173',
            'http://127.0.0.1:5174',
            'http://127.0.0.1:5175',
        ].filter(Boolean);
        if (allowed.includes(origin) || process.env.FRONTEND_URL === '*') {
            return callback(null, true);
        }
        callback(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Client-Timestamp'],
    credentials: true
}));
app.use(express.json({ limit: '64kb' }));

// OpenAPI Schema Validation — validates responses against contract (development mode)
// Set SCHEMA_VALIDATION_STRICT=true to enforce strict validation
app.use(schemaValidationMiddleware);

// Rate Limiting — tiered by route sensitivity
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // Strict: 20 login/register attempts per 15min per IP
    message: { error: 'Too many authentication attempts. Please wait 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300, // Dashboard loads 10+ endpoints simultaneously — allow headroom
    message: { error: 'Rate limit exceeded. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/api/admin'), // admin has own limiter
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500, // Admin panel polls every 30s across multiple tabs
    message: { error: 'Admin rate limit exceeded.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/admin', adminLimiter);
app.use('/api', apiLimiter);

// App Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/airdrop', airdropRoutes);
app.use('/api', publicRoutes); // /api/news, /api/signals
app.use('/api/projects', projectRoutes);
app.use('/api/live-pairs', livePairRoutes);
app.use('/api/v1/t2e', t2eRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/config', configRouter);
app.use('/api/security', securityRouter);
app.use('/api/rpc', rpcRouter);
app.use('/api/stream', streamRouter);

// Service Routes (Legacy Migration)
app.use('/api/portfolio', portfolioRouter); // Moved up to ensure precedence
app.use('/api/whale', whaleRouter); 
app.use('/api/ai', aiRouter);
app.use('/api/cex', cexRouter);
app.use('/api', marketRouter);
// NOTE: publicRoutes already mounted above at /api — do NOT mount again here

app.get('/api/db-diagnostics', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const admins = await store.read('admins');
        res.json({
            status: 'success',
            adminsCount: admins.length,
            message: 'Database connection check passed'
        });
    } catch (err) {
        console.error('[db-diagnostics]', err);
        res.status(500).json({
            status: 'error',
            message: 'Database check failed. See server logs for details.'
        });
    }
});

// SECURITY: /api/db-seed-admin has been removed. It accepted email/
// password/key as URL query parameters (logged in plaintext by proxies,
// CDNs, and browser history), checked against a secret hardcoded
// directly in this file ('figment-secure-seed-777' — visible to anyone
// who ever viewed this source), and would OVERWRITE an existing admin's
// password if one matched the given email. Anyone with repo access (or
// anyone who found the URL) could take over the real admin account.
// Admin seeding must never be reachable over HTTP. Use
// `node src/scripts/seed-admin.js <email> <password>` locally instead.

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ONLINE', 
        port: config.port,
        timestamp: new Date().toISOString() 
    });
});

app.get('/api', (req, res) => {
    res.json({ message: 'AlphaBAG API Root', status: 'ACTIVE' });
});

app.get('/', (req, res) => {
    res.json({ message: 'AlphaBAG Infrastructure Active', version: '2.0.0' });
});

export default app;
