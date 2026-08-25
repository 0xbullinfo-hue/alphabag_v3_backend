/**
 * TOKEN GATING CONFIGURATION - BACKEND
 * Centralized config for premium feature access
 *
 * Mirrors frontend config but for backend use
 * All values loaded from environment variables
 */

export const TOKEN_GATING_CONFIG = {
  // ===== TOKEN CONTRACT ADDRESSES =====
  // Empty until BAG token is deployed
  BAG_TOKEN_ADDRESS_MAINNET: process.env.BAG_TOKEN_ADDRESS_MAINNET || '',
  BAG_TOKEN_ADDRESS_TESTNET: process.env.BAG_TOKEN_ADDRESS_TESTNET || '',

  // ===== PREMIUM ACCESS REQUIREMENTS =====
  MIN_BAG_REQUIRED: Number(process.env.MIN_BAG_REQUIRED) || 0,

  // ===== ADMIN WALLET CONFIGURATION =====
  // Comma-separated list of admin wallet addresses.
  // NOTE: this file is a legacy/duplicate path. Real admin verification is
  // DB-driven (see storeService's `admins` collection, checked in
  // authMiddleware.js's verifyToken/optionalAuth). There is intentionally
  // no hardcoded fallback wallet here — an empty ADMIN_WALLETS means
  // "no admins configured via this legacy path", not "use the default
  // wallet", since a baked-in default address is exactly the hardcoded-
  // admin-wallet vulnerability class this codebase already remediated
  // elsewhere.
  ADMIN_WALLETS: (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map(w => w.trim())
    .filter(Boolean),

  // ===== FEATURE FLAGS =====
  ENABLE_TOKEN_GATING: process.env.ENABLE_TOKEN_GATING === 'true',
  IS_PRODUCTION: process.env.NODE_ENV === 'production',
};

// ===== VALIDATION =====
export function validateBackendConfig() {
  const errors = [];

  if (TOKEN_GATING_CONFIG.ENABLE_TOKEN_GATING) {
    if (!TOKEN_GATING_CONFIG.BAG_TOKEN_ADDRESS_MAINNET) {
      errors.push('Token gating enabled but BAG_TOKEN_ADDRESS_MAINNET not set');
    }
    if (!TOKEN_GATING_CONFIG.MIN_BAG_REQUIRED || TOKEN_GATING_CONFIG.MIN_BAG_REQUIRED <= 0) {
      errors.push('Token gating enabled but MIN_BAG_REQUIRED not configured');
    }
  }

  if (TOKEN_GATING_CONFIG.ADMIN_WALLETS.length === 0) {
    console.warn('No admin wallets configured. Admin features will be unavailable.');
  }

  if (errors.length > 0) {
    console.error('Backend configuration errors:', errors);
  }

  return errors.length === 0;
}

// Validate on startup
validateBackendConfig();

console.log('✅ Backend token gating config loaded');
console.log(`   Token gating: ${TOKEN_GATING_CONFIG.ENABLE_TOKEN_GATING ? 'ENABLED' : 'DISABLED'}`);
console.log(`   Admin wallets: ${TOKEN_GATING_CONFIG.ADMIN_WALLETS.length}`);
console.log(`   Min BAG required: ${TOKEN_GATING_CONFIG.MIN_BAG_REQUIRED}`);
