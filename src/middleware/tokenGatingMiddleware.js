/**
 * TOKEN GATING MIDDLEWARE
 * Protects premium routes by verifying on-chain BAG token balance.
 *
 * Usage:
 * router.get('/api/premium-feature', verifyToken, tokenGatingMiddleware, (req, res) => { ... })
 *
 * NOTE: this must run after verifyToken/optionalAuth (see authMiddleware.js)
 * so req.user is populated.
 */

import { createPublicClient, http, formatUnits } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { TOKEN_GATING_CONFIG } from '../config/tokenGatingConfig.js';

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }]
  }
];

const publicClient = createPublicClient({
  chain: TOKEN_GATING_CONFIG.IS_PRODUCTION ? bsc : bscTestnet,
  transport: http(process.env.RPC_URL || undefined),
});

/**
 * Middleware to check if user holds sufficient BAG tokens.
 * Expects req.user.wallet (or req.user.address) to be set by auth middleware.
 */
export const tokenGatingMiddleware = async (req, res, next) => {
  try {
    // Skip if token gating is disabled
    if (!TOKEN_GATING_CONFIG.ENABLE_TOKEN_GATING) {
      return next();
    }

    // User must be authenticated
    const userWallet = (req.user && (req.user.wallet || req.user.address) || '').toLowerCase();
    if (!userWallet) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tokenAddress = TOKEN_GATING_CONFIG.IS_PRODUCTION
      ? TOKEN_GATING_CONFIG.BAG_TOKEN_ADDRESS_MAINNET
      : TOKEN_GATING_CONFIG.BAG_TOKEN_ADDRESS_TESTNET;

    if (!tokenAddress) {
      // Gating is enabled but no token is deployed yet — fail closed
      // rather than silently letting everyone through.
      console.error('[tokenGating] Token gating enabled but no BAG token address configured');
      return res.status(503).json({ error: 'Token gating is misconfigured' });
    }

    const [rawBalance, decimals] = await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [userWallet],
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'decimals',
      }),
    ]);

    const balance = Number(formatUnits(rawBalance, decimals));

    if (balance < TOKEN_GATING_CONFIG.MIN_BAG_REQUIRED) {
      return res.status(403).json({
        error: 'Insufficient $BAG balance for this feature',
        required: TOKEN_GATING_CONFIG.MIN_BAG_REQUIRED,
        balance,
      });
    }

    req.bagBalance = balance;
    next();
  } catch (error) {
    console.error('Token gating middleware error:', error);
    // Fail closed: a chain-read failure should not silently grant access.
    res.status(503).json({ error: 'Token verification failed, please try again' });
  }
};

/**
 * Middleware to check if user is an admin.
 *
 * Delegates to req.user.isAdmin, which authMiddleware.js's verifyToken /
 * optionalAuth already derives from the `admins` DB table. This file used
 * to keep its own copy of the check against a static wallet allow-list
 * (TOKEN_GATING_CONFIG.ADMIN_WALLETS, previously with a hardcoded default
 * wallet) — that duplicated, drifted from, and could bypass the real
 * DB-backed admin check. Run verifyToken before this middleware.
 */
export const adminMiddleware = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
