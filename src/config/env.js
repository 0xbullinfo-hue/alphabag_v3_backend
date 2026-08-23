import dotenv from 'dotenv';
dotenv.config();

export function validateEnv() {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`[ENV] Missing required variables: ${missing.join(', ')}`);
    if (process.env.NODE_ENV === 'production' || process.env.VITE_ENVIRONMENT === 'production') {
      process.exit(1);
    }
  }

  // Production security checks
  if (process.env.NODE_ENV === 'production' || process.env.VITE_ENVIRONMENT === 'production') {
    const weakSecrets = [
      'your_jwt_secret_key_here',
      'alphabag-secret-key-change-in-prod-urgent',
      'change-me-in-production',
      'default',
      'secret',
    ];

    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || weakSecrets.includes(process.env.JWT_SECRET)) {
      console.error('[ENV] FATAL: JWT_SECRET must be at least 32 characters and not a default value');
      process.exit(1);
    }

    if (!process.env.CEX_ENCRYPTION_KEY || process.env.CEX_ENCRYPTION_KEY.length < 16) {
      console.error('[ENV] FATAL: CEX_ENCRYPTION_KEY must be at least 16 characters');
      process.exit(1);
    }

    if (process.env.FRONTEND_URL === '*') {
      console.error('[ENV] FATAL: FRONTEND_URL cannot be wildcard (*) in production');
      process.exit(1);
    }

    if (!process.env.COVALENT_API_KEY) {
      console.warn('[ENV] COVALENT_API_KEY not set — Security Scanner will use fallback mock data');
    }

    if (!process.env.ALCHEMY_API_KEY) {
      console.warn('[ENV] ALCHEMY_API_KEY not set — RPC proxy may fail');
    }
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production' || process.env.VITE_ENVIRONMENT === 'production',
  jwtSecret: process.env.JWT_SECRET || 'alphabag-dev-secret-key-32chars-min!!',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3005',
  dbUrl: process.env.DATABASE_URL || '',
  adminSetupSecret: process.env.ADMIN_SETUP_SECRET || null,
  adminPortalKey: process.env.ADMIN_PORTAL_KEY || '',
  localAdminPreviewEmail: process.env.LOCAL_ADMIN_PREVIEW_EMAIL || '',
  localAdminPreviewPassword: process.env.LOCAL_ADMIN_PREVIEW_PASSWORD || '',
  alchemyApiKey: process.env.ALCHEMY_API_KEY || '',
  covalentApiKey: process.env.COVALENT_API_KEY || '',
  coingeckoApiKey: process.env.COINGECKO_API_KEY || '',
  moralisApiKey: process.env.MORALIS_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  cexEncryptionKey: process.env.CEX_ENCRYPTION_KEY || 'alphabag-cex-encryption-key-32ch',
};

export default config;
