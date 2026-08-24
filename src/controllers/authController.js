// SPDX-License-Identifier: MIT
// PATCH: authController.js — Zero hardcoded wallets + full auth suite
// Fixes:
//   1. Removed ADMIN_WALLETS hardcoded array
//   2. Admin status determined by database `admins` table ONLY
//   3. Added promoteToAdmin() for existing admins to add new admins via dashboard
//   4. Added removeAdmin() for admin revocation
//   5. Preserved SIWE auth, referral tracking, and real on-chain upgrade verification

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { generateNonce, SiweMessage } from 'siwe';
import { verifyMessage, getAddress, createPublicClient, http, formatUnits } from 'viem';
import { bsc } from 'viem/chains';
import { store } from '../services/storeService.js';
import { config } from '../config/env.js';

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

const nonces = new Map();
const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ── Nonce Generation ───────────────────────────────────────────────────────
export const getNonce = async (req, res) => {
    try {
        const nonce = generateNonce();
        const expiresAt = Date.now() + NONCE_EXPIRY_MS;
        nonces.set(nonce, { expiresAt, used: false });
        if (nonces.size > 1000) {
            const now = Date.now();
            for (const [key, val] of nonces.entries()) {
                if (val.expiresAt < now) nonces.delete(key);
            }
        }
        res.status(200).json({ nonce });
    } catch (error) {
        console.error('Nonce generation error:', error);
        res.status(500).json({ error: 'Failed to generate nonce' });
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

        if (!fields.nonce || !nonces.has(fields.nonce)) {
            return res.status(400).json({ error: 'Invalid or expired nonce' });
        }

        const nonceData = nonces.get(fields.nonce);
        if (nonceData.used || nonceData.expiresAt < Date.now()) {
            nonces.delete(fields.nonce);
            return res.status(400).json({ error: 'Nonce already used or expired' });
        }

        nonceData.used = true;
        nonces.delete(fields.nonce);

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
        };

        const token = jwt.sign(tokenPayload, config.jwtSecret, { expiresIn: '7d' });

        res.status(200).json({ token, user: tokenPayload });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(401).json({ error: 'Invalid signature or message' });
    }
};

// ── Legacy / Direct SIWE Auth Flow ──────────────────────────────────────────
export const siweAuth = async (req, res) => {
    const { address, signature, message, refCode } = req.body;

    try {
        if (!address || !signature || !message) {
            return res.status(400).json({ error: 'Missing authentication parameters' });
        }

        let checksummedAddress = address;
        try {
            if (address && address.startsWith('0x')) {
                checksummedAddress = getAddress(address);
            }
        } catch (addrErr) {
            checksummedAddress = address;
        }

        let isValid = false;
        try {
            isValid = await verifyMessage({
                address: checksummedAddress,
                message,
                signature,
            });
        } catch (vErr) {
            return res.status(401).json({ error: 'Invalid signature format' });
        }

        if (!isValid) {
            return res.status(401).json({ error: 'Signature verification failed' });
        }

        const normalizedId = address.toLowerCase();
        let userArr = await store.read('users');
        let user = userArr.find(u => u.id && typeof u.id === 'string' && u.id.toLowerCase() === normalizedId);
        let isNew = false;

        const adminRecord = await store.findOne('admins', { wallet: normalizedId });
        const isAdmin = !!adminRecord;

        if (!user) {
            isNew = true;
            const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            let referredBy = null;

            if (refCode && typeof refCode === 'string') {
                const referrer = userArr.find(u => u.referralCode === refCode.toUpperCase());
                // Self-referral blocked: referrer must be different from new user
                if (referrer && referrer.wallet?.toLowerCase() !== checksummedAddress?.toLowerCase() && referrer.address?.toLowerCase() !== checksummedAddress?.toLowerCase()) {
                    referredBy = referrer.id;
                    const referrerCount = referrer.referralCount || 0;
                    if (referrerCount < 1000) {
                        await store.updateById('users', referrer.id, r => ({
                            items: (r.items || 0) + 100,
                            referralCount: referrerCount + 1
                        }));
                    }
                }
            }

            user = {
                id: normalizedId,
                email: `${address.substring(0, 6)}...${address.substring(address.length - 4)}`,
                verifiedWallet: address,
                wallet: normalizedId,
                items: 5000,
                bagTokens: 0,
                referralCode,
                referredBy,
                referralCount: 0,
                tier: 'FREE',
                isAdmin,
                lastActive: new Date().toISOString()
            };
            await store.create('users', user);
        } else {
            user = await store.updateById('users', normalizedId, u => ({
                lastActive: new Date().toISOString(),
                isAdmin
            }));
        }

        const { password: _, ...userSafe } = user;
        const token = jwt.sign({ 
            id: user.id, 
            email: user.email, 
            isAdmin,
            wallet: user.verifiedWallet || normalizedId 
        }, config.jwtSecret, { expiresIn: '7d' });

        res.json({ token, user: userSafe, isNew });
    } catch (error) {
        console.error("SIWE Auth Error:", error);
        res.status(500).json({ error: error.message || 'Authentication protocol failure' });
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
        return res.status(410).json({
            error: 'Email/password login is not available for user accounts. Please connect your wallet to sign in.'
        });
    }

    if (!config.adminPortalKey) {
        return res.status(503).json({ error: 'Admin portal is not available.' });
    }
    if (adminPortalKey !== config.adminPortalKey) {
        return res.status(403).json({ error: 'Invalid credentials' });
    }

    const user = await store.findOne('admins', { email });
    if (!user || !user.password) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }

    const updatedAdmin = await store.updateById('admins', user.id, u => ({
        updatedAt: new Date().toISOString()
    }));
    const { password: _, ...adminSafe } = updatedAdmin || user;
    const token = jwt.sign({ id: adminSafe.id, email: adminSafe.email, isAdmin: true }, config.jwtSecret, { expiresIn: '24h' });
    res.json({ token, user: { ...adminSafe, isAdmin: true } });
};

// ── Get Current User ───────────────────────────────────────────────────────
export const getMe = async (req, res) => {
    try {
        const user = await store.findOne('users', { id: req.user.id }) || await store.findOne('users', { wallet: req.user.wallet });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
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
        const allUsers = await store.read('users');
        const user = allUsers.find(u => u.id === userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const directReferrals = allUsers.filter(u => u.referredBy === userId);
        res.json({
            referralCode: user.referralCode,
            totalReferrals: directReferrals.length,
            referrals: directReferrals.map(r => ({
                id: r.id,
                email: r.email,
                joinedAt: r.createdAt || r.lastActive
            }))
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
        const { walletAddress } = req.body;
        const userId = req.user?.id;
        const wallet = walletAddress || req.user?.wallet || req.user?.address;

        if (!wallet) {
            return res.status(400).json({ error: 'Wallet address required' });
        }

        const bagTokenAddress = process.env.BAG_TOKEN_ADDRESS || '0x0000000000000000000000000000000000000000';
        let isEligible = false;

        if (bagTokenAddress !== '0x0000000000000000000000000000000000000000') {
            try {
                const balanceRaw = await bscPublicClient.readContract({
                    address: bagTokenAddress,
                    abi: ERC20_BALANCE_ABI,
                    functionName: 'balanceOf',
                    args: [wallet],
                });
                const balanceFormatted = Number(formatUnits(balanceRaw, 18));
                if (balanceFormatted >= 10000) isEligible = true;
            } catch (rpcErr) {
                console.error('[UPGRADE] RPC balance check failed:', rpcErr);
            }
        }

        // Strict eligibility: requires verified on-chain token holding

        if (!isEligible) {
            return res.status(403).json({ error: 'Insufficient $BAG balance. 10,000 $BAG required for ULTIMATE tier.' });
        }

        const updatedUser = await store.updateById('users', userId, u => ({
            tier: 'ULTIMATE',
            updatedAt: new Date().toISOString()
        }));

        const token = jwt.sign({ 
            id: updatedUser.id, 
            wallet: updatedUser.wallet,
            tier: 'ULTIMATE',
            isAdmin: updatedUser.isAdmin 
        }, config.jwtSecret, { expiresIn: '7d' });

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

        await store.delete('admins', existing.id);
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
