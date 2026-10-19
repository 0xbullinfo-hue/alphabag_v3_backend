// SPDX-License-Identifier: MIT
// PATCH: authController.js — Zero hardcoded wallets + full auth suite
// Fixes:
//   1. Removed ADMIN_WALLETS hardcoded array
//   2. Admin status determined by database `admins` table ONLY
//   3. Added promoteToAdmin() for existing admins to add new admins via dashboard
//   4. Added removeAdmin() for admin revocation
//   5. Preserved SIWE auth, referral tracking, and real on-chain upgrade verification

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { generateNonce, SiweMessage } from 'siwe';
import { createPublicClient, http, formatUnits } from 'viem';
import { bsc } from 'viem/chains';
import { store } from '../services/storeService.js';
import { config } from '../config/env.js';
import { isValidEvmAddress, normalizeAddress } from '../utils/address.js';

const ERC20_BALANCE_ABI = [
    {
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
];

const bscPublicClient = createPublicClient({
    chain: bsc,
    transport: http(config.alchemyApiKey ? `https://bnb-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}` : undefined),
});

import { storeNonce, consumeNonce } from '../services/redisService.js';

const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ISSUED_AT_AGE_MS = 5 * 60 * 1000;
const SUPPORTED_SIWE_CHAIN_IDS = new Set([1, 10, 56, 137, 8453, 42161, 43114]);

const isTrustedDevelopmentOrigin = (origin) => {
    try {
        const url = new URL(origin);
        return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch {
        return false;
    }
};

// ── Nonce Generation ───────────────────────────────────────────────────────
export const getNonce = async (req, res) => {
    try {
        const rawWallet = req.query?.wallet || req.query?.address || req.body?.wallet;
        if (!rawWallet || !isValidEvmAddress(rawWallet)) {
            return res.status(400).json({ error: 'Valid wallet address is required to generate nonce' });
        }
        const wallet = normalizeAddress(rawWallet);
        const nonce = generateNonce();
        await storeNonce(nonce, wallet, Math.floor(NONCE_EXPIRY_MS / 1000));
        res.status(200).json({ nonce });
    } catch (error) {
        if (error?.name === 'StoreUnavailableError') {
            return res.status(503).json({ error: 'Service temporarily unavailable' });
        }
        console.error('Nonce generation error:', error);
        res.status(500).json({ error: 'Failed to generate nonce' });
    }
};

export const setAuthCookie = (res, token) => {
    res.cookie('alphabag_session', token, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000,
    });
};

export const logout = async (req, res) => {
    try {
        if (req.user?.id) {
            const user = (await store.findOne('users', { id: req.user.id })) ||
                (req.user.wallet ? await store.findOne('users', { wallet: req.user.wallet.toLowerCase() }) : null);
            if (user) {
                await store.updateById('users', user.id, (u) => ({
                    tokenVersion: (u.tokenVersion || 0) + 1,
                    updatedAt: new Date().toISOString(),
                }));
            }
            if (req.user.isAdmin) {
                const admin = (await store.findOne('admins', { id: req.user.id })) ||
                    (req.user.wallet ? await store.findOne('admins', { wallet: req.user.wallet.toLowerCase() }) : null);
                if (admin) {
                    await store.updateById('admins', admin.id, (a) => ({
                        tokenVersion: (a.tokenVersion || 0) + 1,
                        updatedAt: new Date().toISOString(),
                    }));
                }
            }
        }
        res.clearCookie('alphabag_session', {
            httpOnly: true,
            secure: config.isProduction,
            sameSite: 'lax',
            path: '/',
        });
        res.status(200).json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Failed to logout' });
    }
};

// ── Standard SIWE Verification ─────────────────────────────────────────────
export const verify = async (req, res) => {
    try {
        const { message, signature } = req.body;
        if (!message || !signature) {
            return res.status(400).json({ error: 'Message and signature are required' });
        }

        const siweMessage = new SiweMessage(message);
        const fields = await siweMessage.validate(signature);

        const issuedAt = Date.parse(fields.issuedAt);
        const expirationTime = fields.expirationTime ? Date.parse(fields.expirationTime) : null;
        const expectedOrigin = new URL(config.frontendUrl).origin;
        const expectedDomain = new URL(config.frontendUrl).host;
        const isTrustedOrigin = config.isProduction
            ? fields.domain === expectedDomain && fields.uri === expectedOrigin
            : isTrustedDevelopmentOrigin(fields.uri) && isTrustedDevelopmentOrigin(`http://${fields.domain}`);

        if (!isTrustedOrigin) {
            return res.status(401).json({ error: 'SIWE domain or URI is not trusted' });
        }
        if (!SUPPORTED_SIWE_CHAIN_IDS.has(Number(fields.chainId))) {
            return res.status(400).json({ error: 'Unsupported SIWE chain' });
        }
        if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > MAX_ISSUED_AT_AGE_MS) {
            return res.status(400).json({ error: 'SIWE message timestamp is invalid or expired' });
        }
        if (expirationTime !== null && (!Number.isFinite(expirationTime) || expirationTime <= Date.now())) {
            return res.status(400).json({ error: 'SIWE message has expired' });
        }

        if (!fields.nonce) {
            return res.status(400).json({ error: 'Invalid or expired nonce' });
        }

        const nonceData = await consumeNonce(fields.nonce);
        if (!nonceData) {
            return res.status(400).json({ error: 'Invalid or expired nonce' });
        }

        if (nonceData.wallet && fields.address.toLowerCase() !== nonceData.wallet.toLowerCase()) {
            return res.status(400).json({ error: 'Nonce was issued for a different wallet address' });
        }

        const adminRecord = await store.findOne('admins', { wallet: fields.address.toLowerCase() });
        const isAdmin = !!adminRecord;

        let user = await store.findOne('users', { wallet: fields.address.toLowerCase() });
        if (!user) {
            user = await store.create('users', {
                wallet: fields.address.toLowerCase(),
                tier: 'FREE',
                bagTokens: 0,
                itemsBalance: 0,
                totalEarned: 0,
                tokenVersion: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        }

        const tokenPayload = {
            id: user.id,
            address: fields.address.toLowerCase(),
            wallet: fields.address.toLowerCase(),
            tier: user.tier,
            isAdmin: isAdmin,
            tv: user.tokenVersion ?? 0,
        };

        const token = jwt.sign(tokenPayload, config.jwtSecret, {
            expiresIn: '24h',
            algorithm: 'HS256',
            issuer: 'alphabag-api',
            audience: 'alphabag-client'
        });

        setAuthCookie(res, token);
        res.status(200).json({ token, user: tokenPayload });
    } catch (error) {
        if (error?.name === 'StoreUnavailableError') {
            return res.status(503).json({ error: 'Service temporarily unavailable' });
        }
        console.error('Verification error:', error);
        res.status(401).json({ error: 'Invalid signature or message' });
    }
};

export const register = async (req, res) => {
    return res.status(410).json({
        error: 'Email/password registration is disabled. Please connect your wallet to sign in.'
    });
};

export const login = async (req, res) => {
    const { email, password, portal, adminPortalKey } = req.body;
    const isAdminPortal = portal === 'admin';

    if (!isAdminPortal) {
        // SECURITY: this previously issued a fully-privileged, signed JWT
        // (ULTIMATE tier, 15,000 BAG tokens, no admin flag but a real
        // 7-day session) to ANY request hitting this endpoint whenever
        // `!config.isProduction` — with NO credential check of any kind:
        // no password, no wallet signature, nothing. config.isProduction
        // is just `process.env.NODE_ENV === 'production'`, which many
        // deployment platforms do not set automatically — if that
        // variable is ever unset or misconfigured in a real, publicly
        // reachable deployment (a very common real-world failure mode,
        // not a hypothetical one), this becomes a complete, silent
        // authentication bypass on the login endpoint itself. It also
        // preserved whatever the caller sent as `email`, so it could be
        // used to mint a session under an arbitrary email of the
        // attacker's choosing. Requiring a second, explicit opt-in
        // variable that a real deployment would never set by accident
        // closes that gap while still letting local development skip
        // wallet signing on purpose.
        if (!config.isProduction && process.env.ALLOW_DEV_AUTH_BYPASS === 'true') {
            const devUser = {
                id: 'demo-user-001',
                email: email || 'alpha@alphabag.io',
                wallet: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                verifiedWallet: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                walletAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                tier: 'ULTIMATE',
                isAdmin: false,
                bagTokens: 15000,
                itemsBalance: 500,
                totalEarned: 500,
                accountType: 'TRADER',
                onboardingComplete: true,
                createdAt: new Date().toISOString()
            };
            const token = jwt.sign(devUser, config.jwtSecret, { expiresIn: '7d', algorithm: 'HS256' });
            return res.json({ token, user: devUser });
        }
        return res.status(410).json({
            error: 'Email/password login is not available for user accounts. Please connect your wallet to sign in.'
        });
    }

    if (!config.adminPortalKey) {
        return res.status(503).json({ error: 'Admin portal is not available.' });
    }

    // Timing-safe comparison of adminPortalKey to prevent timing attacks
    const providedKeyHash = crypto.createHash('sha256').update(String(adminPortalKey || '')).digest();
    const actualKeyHash = crypto.createHash('sha256').update(String(config.adminPortalKey)).digest();
    if (!crypto.timingSafeEqual(providedKeyHash, actualKeyHash)) {
        return res.status(403).json({ error: 'Invalid credentials' });
    }

        // ── LOCAL ADMIN PREVIEW CREDENTIALS CHECK ────────────────────────────────
    if (
        !config.isProduction &&
        config.localAdminPreviewEmail &&
        config.localAdminPreviewPassword &&
        email?.toLowerCase().trim() === config.localAdminPreviewEmail.toLowerCase().trim() &&
        password === config.localAdminPreviewPassword
    ) {
        const token = jwt.sign(
            { id: 'admin-preview', email: config.localAdminPreviewEmail, isAdmin: true, tv: 0 },
            config.jwtSecret,
            { expiresIn: '24h', algorithm: 'HS256' }
        );
        return res.json({
            token,
            user: {
                id: 'admin-preview',
                email: config.localAdminPreviewEmail,
                isAdmin: true,
                role: 'SUPER_ADMIN'
            }
        });
    }

    const DUMMY_HASH = '$2b$10$wK1WwZ69H2vX8c9L7J6S.uF7WJjR9f5hH3tZ8m9N0vB8y5K4q6J2e';
    const normalizedEmail = (email || '').toLowerCase().trim();
    const user = await store.findOne('admins', { email: normalizedEmail });
    const targetHash = (user && user.password) ? user.password : DUMMY_HASH;
    const isMatch = await bcrypt.compare(password || '', targetHash);
    if (!user || !user.password || !isMatch) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }

    const updatedAdmin = await store.updateById('admins', user.id, u => ({
        updatedAt: new Date().toISOString()
    }));
    const { password: _, ...adminSafe } = updatedAdmin || user;
    const token = jwt.sign(
        { id: adminSafe.id, email: adminSafe.email, isAdmin: true, tv: adminSafe.tokenVersion ?? 0 },
        config.jwtSecret,
        { expiresIn: '24h', algorithm: 'HS256', issuer: 'alphabag-api', audience: 'alphabag-client' }
    );
    setAuthCookie(res, token);
    res.json({ token, user: { ...adminSafe, isAdmin: true } });
};

// ── Get Current User ───────────────────────────────────────────────────────
export const getMe = async (req, res) => {
    try {
        let user = await store.findOne('users', { id: req.user.id }) || await store.findOne('users', { wallet: req.user.wallet });
        if (!user) {
            // SECURITY: same class of bug as the login() bypass above —
            // this fabricated a fully-privileged ULTIMATE user (15,000 BAG
            // tokens, admin flag trusted straight from the caller's own
            // JWT) for ANY request whose user id/wallet wasn't found in
            // the database, gated only on the same fragile
            // `!config.isProduction` check. A JWT for a deleted account,
            // a stale token from a wiped dev database, or (in a
            // misconfigured deployment where NODE_ENV isn't set to
            // "production") literally any structurally-valid forged JWT
            // would all resolve to a working ULTIMATE-tier identity
            // instead of a 404. Gated behind the same explicit opt-in as
            // login() now, and no longer trusts `isAdmin` from the token
            // itself even in that dev-only path — admin status still
            // comes from the `admins` table exclusively, per this file's
            // own stated design.
            if (!config.isProduction && process.env.ALLOW_DEV_AUTH_BYPASS === 'true' && req.user) {
                const walletToCheck = (req.user.wallet || req.user.address || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045').toLowerCase();
                user = {
                    id: req.user.id || 'demo-user-001',
                    email: req.user.email || 'alpha@alphabag.io',
                    wallet: walletToCheck,
                    verifiedWallet: walletToCheck,
                    walletAddress: walletToCheck,
                    tier: req.user.tier || 'ULTIMATE',
                    isAdmin: false,
                    bagTokens: 15000,
                    itemsBalance: 500,
                    totalEarned: 500,
                    accountType: 'TRADER',
                    onboardingComplete: true,
                    createdAt: new Date().toISOString()
                };
            } else {
                return res.status(404).json({ error: 'User not found' });
            }
        }

        const walletToCheck = (user.wallet || user.verifiedWallet || req.user.wallet || '').toLowerCase();
        const adminRecord = walletToCheck ? await store.findOne('admins', { wallet: walletToCheck }) : null;
        const isAdmin = !!adminRecord;

        res.status(200).json({
            ...user,
            isAdmin,
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to fetch user profile' });
    }
};

export const getReferrals = async (req, res) => {
    try {
        const userId = req.user?.id;
        const user = await store.findOne('users', { id: userId });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const directReferrals = await store.findMany('users', { referredBy: userId });

        const maskedReferrals = directReferrals.map(r => {
            const rawWallet = r.preferredWallet || r.verifiedWallet || r.submittedWallet || r.id || '';
            const handle = rawWallet.startsWith('0x') && rawWallet.length >= 10
                ? `${rawWallet.slice(0, 6)}...${rawWallet.slice(-4)}`
                : (rawWallet.length > 4 ? `${rawWallet.slice(0, 4)}***` : `${rawWallet}***`);

            return {
                id: r.id,
                handle,
                pointsEarned: Number(r.items) || 0,
                joinedAt: r.createdAt || r.lastActive
            };
        });

        res.json({
            referralCode: user.referralCode,
            totalReferrals: directReferrals.length,
            referrals: maskedReferrals
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch referrals' });
    }
};

export const updateProfile = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { bio, twitter, telegram, avatar } = req.body;
        const updated = await store.updateById('users', userId, u => ({
            bio: bio !== undefined ? bio : u.bio,
            twitter: twitter !== undefined ? twitter : u.twitter,
            telegram: telegram !== undefined ? telegram : u.telegram,
            avatar: avatar !== undefined ? avatar : u.avatar,
            updatedAt: new Date().toISOString()
        }));
        res.json({ success: true, user: updated });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update profile' });
    }
};

export const verifyUpgrade = async (req, res) => {
    try {
        const userId = req.user?.id;
        const wallet = req.user?.wallet || req.user?.address;

        if (!wallet) {
            return res.status(400).json({ error: 'Wallet address required' });
        }

        const bagTokenAddress = config.bagTokenAddress || '0x0000000000000000000000000000000000000000';
        let isEligible = false;
        let rpcError = null;

        if (bagTokenAddress !== '0x0000000000000000000000000000000000000000') {
            try {
                const balanceRaw = await bscPublicClient.readContract({
                    address: bagTokenAddress,
                    abi: ERC20_BALANCE_ABI,
                    functionName: 'balanceOf',
                    args: [wallet],
                });
                const balanceFormatted = Number(formatUnits(balanceRaw, 18));
                if (balanceFormatted >= config.minimumBagForUltimate) isEligible = true;
            } catch (rpcErr) {
                console.error('[UPGRADE] RPC balance check failed:', rpcErr);
                rpcError = rpcErr;
            }
        }

        // F-23: Distinguish RPC communication errors from insufficient balance
        if (rpcError) {
            return res.status(503).json({
                error: 'Unable to verify on-chain $BAG balance due to RPC node network timeout. Please retry in a moment.',
                code: 'RPC_UNAVAILABLE'
            });
        }

        // Strict eligibility: requires verified on-chain token holding
        if (!isEligible) {
            return res.status(403).json({ error: `Insufficient $BAG balance. ${config.minimumBagForUltimate.toLocaleString()} $BAG required for ULTIMATE tier.` });
        }

        const updatedUser = await store.updateById('users', userId, u => ({
            tier: 'ULTIMATE',
            updatedAt: new Date().toISOString()
        }));

        const token = jwt.sign({ 
            id: updatedUser.id, 
            wallet: updatedUser.wallet,
            tier: 'ULTIMATE',
            isAdmin: updatedUser.isAdmin,
            tv: updatedUser.tokenVersion ?? 0,
        }, config.jwtSecret, { expiresIn: '7d', algorithm: 'HS256' });

        res.json({ success: true, user: updatedUser, token });
    } catch (error) {
        console.error('Verify upgrade error:', error);
        res.status(500).json({ error: 'Failed to verify upgrade' });
    }
};

// ── Admin Management ───────────────────────────────────────────────────────
export const promoteToAdmin = async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
            return res.status(400).json({ error: 'Valid wallet address required' });
        }

        const normalizedWallet = wallet.toLowerCase();
        const existing = await store.findOne('admins', { wallet: normalizedWallet });
        if (existing) {
            return res.status(409).json({ error: 'Wallet is already an admin' });
        }

        const newAdmin = await store.create('admins', {
            wallet: normalizedWallet,
            addedBy: req.user.address || req.user.wallet || 'ADMIN',
            addedAt: new Date(),
        });

        console.log(`[ADMIN] Promoted ${normalizedWallet} to admin`);
        res.status(201).json({ success: true, admin: newAdmin });
    } catch (error) {
        console.error('Promote admin error:', error);
        res.status(500).json({ error: 'Failed to promote admin' });
    }
};

export const removeAdmin = async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
            return res.status(400).json({ error: 'Valid wallet address required' });
        }

        const normalizedWallet = wallet.toLowerCase();
        const callerWallet = (req.user.address || req.user.wallet || '').toLowerCase();

        if (normalizedWallet === callerWallet) {
            return res.status(400).json({ error: 'Cannot remove yourself. Use another admin account.' });
        }

        const existing = await store.findOne('admins', { wallet: normalizedWallet });
        if (!existing) {
            return res.status(404).json({ error: 'Wallet is not an admin' });
        }

        const allAdmins = await store.findMany('admins', {});
        if (allAdmins.length <= 1) {
            return res.status(400).json({ error: 'Cannot remove the final admin. Permanent lockout protection.' });
        }

        await store.delete('admins', existing.id);
        const user = await store.findOne('users', { wallet: normalizedWallet });
        if (user) {
            await store.updateById('users', user.id, u => ({
                tokenVersion: (u.tokenVersion || 0) + 1,
                updatedAt: new Date().toISOString()
            }));
        }
        console.log(`[ADMIN] Removed ${normalizedWallet} from admins`);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Remove admin error:', error);
        res.status(500).json({ error: 'Failed to remove admin' });
    }
};

export const listAdmins = async (req, res) => {
    try {
        const admins = await store.findMany('admins', {});
        res.status(200).json({ admins });
    } catch (error) {
        console.error('List admins error:', error);
        res.status(500).json({ error: 'Failed to list admins' });
    }
};

