
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root (supports both standalone backend root and monorepo root)
const backendRoot = path.join(__dirname, '../../');
const monorepoRoot = path.join(__dirname, '../../../');

dotenv.config({ path: path.join(backendRoot, '.env') });
dotenv.config({ path: path.join(backendRoot, '.env.local') });
dotenv.config({ path: path.join(monorepoRoot, '.env') });
dotenv.config({ path: path.join(monorepoRoot, '.env.local') });

export const config = {
    port: process.env.PORT && isNaN(Number(process.env.PORT)) ? process.env.PORT : (parseInt(process.env.PORT) || 3003),
    jwtSecret: process.env.JWT_SECRET || 'alphabag-secret-key-change-in-prod-urgent',
    adminEmail: 'admin@alphabagpro.com', // Primary Test Admin
    databaseUrl: process.env.DATABASE_URL,
    alchemyApiKey: process.env.ALCHEMY_API_KEY,
    apiKey: process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.OPENAI_API_KEY || null,
    // Used by verifyUpgrade (authController) — must match the frontend's
    // TOKEN_GATING_CONFIG values, or the frontend's balance display and
    // the backend's actual grant decision can disagree.
    bagTokenAddress: process.env.BAG_TOKEN_ADDRESS || null,
    minBagRequired: Number(process.env.MIN_BAG_REQUIRED || 0),
    // Shared secret Backend-UI's server environment must send with every
    // admin login attempt, in addition to real credentials — see login()
    // in authController.js. Never set this to a fallback/default value;
    // if it's unset, admin login is disabled entirely rather than
    // silently accepting a guessable default.
    adminPortalKey: process.env.ADMIN_PORTAL_KEY || null,
    localAdminPreviewEmail: process.env.LOCAL_ADMIN_PREVIEW_EMAIL || null,
    localAdminPreviewPassword: process.env.LOCAL_ADMIN_PREVIEW_PASSWORD || null,
};
