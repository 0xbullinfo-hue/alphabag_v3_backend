import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Fail closed: ONLY an explicit development/test NODE_ENV enables dev shortcuts.
// A missing or misspelled NODE_ENV is treated as production.
export const isDevEnv = (env = process.env) =>
  env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
export const isDev = isDevEnv();
export const isProduction = !isDev;

const WEAK_SECRETS = [
  'your_jwt_secret_key_here',
  'alphabag-secret-key-change-in-prod-urgent',
  'alphabag-dev-secret-key-32chars-min!!',
  'change-me-in-production',
  'default',
  'secret',
];

/**
 * Pure check used by validateEnv and tests. Returns a list of fatal problems.
 * Outside development/test every item is fatal.
 */
export function collectEnvErrors(env = process.env) {
  const errors = [];
  const missing = ['DATABASE_URL', 'JWT_SECRET'].filter((key) => !env[key]);
  if (missing.length > 0) errors.push(`Missing required variables: ${missing.join(', ')}`);

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || WEAK_SECRETS.includes(env.JWT_SECRET)) {
    errors.push('JWT_SECRET must be at least 32 characters and not a default value');
  }
  if (!env.CEX_ENCRYPTION_KEY || !/^[a-fA-F0-9]{64}$/.test(env.CEX_ENCRYPTION_KEY)) {
    errors.push('CEX_ENCRYPTION_KEY must be a 64-character hexadecimal key (32 bytes AES-256)');
  }
  if (!env.FRONTEND_URL || !/^https:\/\/[^*\s]+$/.test(env.FRONTEND_URL)) {
    errors.push('FRONTEND_URL must be an explicit https origin (no wildcard)');
  }
  if (!env.ADMIN_PORTAL_KEY) errors.push('ADMIN_PORTAL_KEY is required');
  if (!env.BAG_TOKEN_ADDRESS || !/^0x[a-fA-F0-9]{40}$/.test(env.BAG_TOKEN_ADDRESS) || env.BAG_TOKEN_ADDRESS.toLowerCase() === ZERO_ADDRESS) {
    errors.push('BAG_TOKEN_ADDRESS must be a valid non-zero EVM contract address');
  }
  const treasury = env.TREASURY_WALLET || env.TREASURY_ADDRESS;
  if (!treasury || !/^0x[a-fA-F0-9]{40}$/.test(treasury) || treasury.toLowerCase() === ZERO_ADDRESS) {
    errors.push('TREASURY_WALLET (or TREASURY_ADDRESS) must be a valid non-zero EVM address');
  }
  return errors;
}

export function validateEnv(env = process.env, exit = process.exit) {
  const dev = isDevEnv(env);
  const errors = collectEnvErrors(env);

  if (errors.length > 0) {
    for (const e of errors) console.error(`[ENV] ${dev ? 'WARN' : 'FATAL'}: ${e}`);
    if (!dev) {
      console.error('[ENV] NODE_ENV is not "development"/"test", so production rules apply. Refusing to start.');
      exit(1);
      return errors;
    }
  }

  if (!dev) {
    if (!env.COVALENT_API_KEY) {
      console.warn('[ENV] COVALENT_API_KEY not set — Security Scanner will use fallback mock data');
    }
    if (!env.ALCHEMY_API_KEY) {
      console.warn('[ENV] ALCHEMY_API_KEY not set — RPC proxy may fail');
    }
  }
  return errors;
}

// Dev-only secrets: random per process, never a fixed public string.
const devRandom = (bytes) => crypto.randomBytes(bytes).toString('hex');

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  nodeEnv: process.env.NODE_ENV || 'production',
  isDev,
  isProduction,
  jwtSecret: process.env.JWT_SECRET || (isDev ? devRandom(32) : ''),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3005',
  dbUrl: process.env.DATABASE_URL || '',
  adminSetupSecret: process.env.ADMIN_SETUP_SECRET || null,
  adminPortalKey: process.env.ADMIN_PORTAL_KEY || '',
  localAdminPreviewEmail: process.env.LOCAL_ADMIN_PREVIEW_EMAIL || '',
  localAdminPreviewPassword: process.env.LOCAL_ADMIN_PREVIEW_PASSWORD || '',
  alchemyApiKey: process.env.ALCHEMY_API_KEY || '',
  rpcUrls: {
    ethereum: process.env.ETHEREUM_RPC_URL || (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : 'https://eth.llamarpc.com'),
    bsc:      process.env.BSC_RPC_URL      || (process.env.ALCHEMY_API_KEY ? `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : 'https://binance.llamarpc.com'),
    polygon:  process.env.POLYGON_RPC_URL  || (process.env.ALCHEMY_API_KEY ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : 'https://polygon.llamarpc.com'),
    arbitrum: process.env.ARBITRUM_RPC_URL || (process.env.ALCHEMY_API_KEY ? `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : 'https://arbitrum.llamarpc.com'),
    base:     process.env.BASE_RPC_URL     || (process.env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : 'https://base.llamarpc.com'),
    avalanche: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
  },
  covalentApiKey: process.env.COVALENT_API_KEY || '',
  coingeckoApiKey: process.env.COINGECKO_API_KEY || '',
  moralisApiKey: process.env.MORALIS_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  bagTokenAddress: process.env.BAG_TOKEN_ADDRESS || '',
  treasuryAddress: process.env.TREASURY_WALLET || process.env.TREASURY_ADDRESS || '',
  minimumBagForUltimate: Number(process.env.MIN_BAG_REQUIRED || '10000'),
  cexEncryptionKey: process.env.CEX_ENCRYPTION_KEY || (isDev ? devRandom(32) : ''),
  providerHealthTimeoutMs: Number(process.env.PROVIDER_HEALTH_TIMEOUT_MS || '5000'),
  providerHealthCacheMs: Number(process.env.PROVIDER_HEALTH_CACHE_MS || '15000'),
  outboundServerIp: process.env.OUTBOUND_SERVER_IP || null,
  redisUrl: process.env.REDIS_URL || '',
  bubblemapsApiKey: process.env.BUBBLEMAPS_API_KEY || '',
};

export default config;
