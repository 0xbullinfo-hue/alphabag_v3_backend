import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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

export const register = async (req, res) => {
    // Regular users authenticate via wallet connect (SIWE) only — see
    // siweAuth below, which creates the user record automatically on
    // first successful wallet signature. This email/password path was
    // previously open to anyone, with no wallet-ownership check at all,
    // and claimMission/requestBagPayout don't check verifiedWallet either
    // — so it was a direct bot-farming vector: script account creation,
    // rack up the +100 item referral bonus per fake signup, and claim
    // T2E missions, all without ever proving control of a real wallet.
    return res.status(410).json({
        error: 'Email/password registration is not available. Please connect your wallet to sign in.'
    });
};

export const login = async (req, res) => {
    const { email, password, portal, adminPortalKey } = req.body; // portal: 'main' | 'admin'
    const isAdminPortal = portal === 'admin';

    if (!isAdminPortal) {
        // Regular users authenticate via wallet connect (SIWE) only —
        // see siweAuth. This path previously accepted email/password for
        // any 'main' portal caller with no wallet-ownership check, which
        // was a bot-farming vector (see the register() comment above for
        // the full explanation).
        return res.status(410).json({
            error: 'Email/password login is not available for user accounts. Please connect your wallet to sign in.'
        });
    }

    // Admin portal: requires a shared secret configured only in the
    // Backend-UI server environment (ADMIN_PORTAL_KEY), never exposed to
    // any browser bundle, in addition to real admin credentials. This
    // means even someone who finds this endpoint and correctly guesses
    // portal:'admin' still can't attempt a login without also knowing a
    // secret that isn't discoverable from client-side code. The proper
    // complement to this is restricting the admin portal to a known
    // host/IP range at the infrastructure level (reverse proxy / VPN) —
    // this check doesn't replace that, it's what's achievable in this
    // codebase alone.
    if (!config.adminPortalKey) {
        console.error('[LOGIN] ADMIN_PORTAL_KEY is not configured — admin login is disabled until it is set.');
        return res.status(503).json({ error: 'Admin portal is not available.' });
    }
    if (adminPortalKey !== config.adminPortalKey) {
        return res.status(403).json({ error: 'Invalid credentials' });
    }

    const targetCollection = 'admins';
    const user = await store.findOne(targetCollection, { email });

    if (!user) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }

    if (!user.password) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }

    let userSafe;
    if (isAdminPortal) {
        // Update admin record updatedAt
        const updatedAdmin = await store.updateById('admins', user.id, u => ({
            updatedAt: new Date().toISOString()
        }));
        if (!updatedAdmin) {
            return res.status(500).json({ error: 'Failed to update admin session' });
        }
        const { password: _, ...adminSafe } = updatedAdmin;
        userSafe = { ...adminSafe, isAdmin: true };
    } else {
        const updatedUser = await store.updateById('users', user.id, u => ({
            visits: (u.visits || 0) + 1,
            lastLoginIp: req.ip || req.connection.remoteAddress,
            lastActive: new Date().toISOString()
        }));

        if (!updatedUser) {
            return res.status(500).json({ error: 'Failed to update user stats' });
        }
        const { password: _, ...regSafe } = updatedUser;
        userSafe = regSafe;
    }

    const token = jwt.sign({ id: userSafe.id, email: userSafe.email, isAdmin: !!userSafe.isAdmin }, config.jwtSecret, { expiresIn: '24h' });
    res.json({ token, user: userSafe });
};

export const siweAuth = async (req, res) => {
    const { address, signature, message, refCode } = req.body;

    try {
        if (!address || !signature || !message) {
            console.warn(`[SIWE DEBUG] Missing parameters:`, { address, signature: !!signature, message: !!message });
            return res.status(400).json({ error: 'Missing authentication parameters' });
        }

        console.log(`[SIWE DEBUG] Attempting Auth for: ${address}`);
        
        // Normalize and Checksum Address
        let checksummedAddress = address;
        try {
            if (address && address.startsWith('0x')) {
                checksummedAddress = getAddress(address);
            }
        } catch (addrErr) {
            console.warn(`[SIWE DEBUG] Address Checksum Failure (Proceeding with raw): ${address}`);
            checksummedAddress = address;
        }

        // 1. Verify Signature
        let isValid = false;
        try {
            isValid = await verifyMessage({
                address: checksummedAddress,
                message,
                signature,
            });
        } catch (vErr) {
            console.error("[SIWE DEBUG] Cryptographic Verification Crash:", vErr.stack);
            return res.status(401).json({ error: 'Invalid signature format or protocol mismatch' });
        }

        console.log(`[SIWE DEBUG] Signature Valid: ${isValid}`);

        if (!isValid) {
            console.warn(`[SIWE] Unauthorized signature for: ${address}`);
            return res.status(401).json({ error: 'Signature verification failed' });
        }

        // 2. Find or Create User (Normalize to Lowercase)
        const normalizedId = address.toLowerCase();
        let userArr = await store.read('users');
        let user = userArr.find(u => u.id && typeof u.id === 'string' && u.id.toLowerCase() === normalizedId);
        let isNew = false;

        if (!user) {
            isNew = true;
            console.log(`[SYNDICATE] Initializing new Node: ${normalizedId}`);
            
            const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            let referredBy = null;

            if (refCode && typeof refCode === 'string') {
                const referrer = userArr.find(u => u.referralCode === refCode.toUpperCase());
                if (referrer) {
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
                items: 5000,
                bagTokens: 0,
                referralCode,
                referredBy,
                referralCount: 0,
                // FIX: every new signup was previously granted 'ULTIMATE'
                // unconditionally here, with no BAG token balance check at
                // all. New users must start on 'FREE' and only move to
                // 'ULTIMATE' via verifyUpgrade below, which reads the real
                // on-chain balance.
                tier: 'FREE',
                isAdmin: false,
                lastActive: new Date().toISOString()
            };
            await store.create('users', user);
        } else {
            user = await store.updateById('users', normalizedId, u => ({
                lastActive: new Date().toISOString()
            }));
        }

        if (!user) {
            throw new Error(`Critical: User object lost during synchronization for ${address}`);
        }

        const { password: _, ...userSafe } = user;
        const token = jwt.sign({ 
            id: user.id, 
            email: user.email, 
            isAdmin: user.isAdmin,
            wallet: user.verifiedWallet 
        }, config.jwtSecret, { expiresIn: '24h' });

        res.json({ token, user: userSafe, isNew });

    } catch (error) {
        console.error("SIWE Auth Error Stack:", error.stack);
        res.status(500).json({ error: error.message || 'Authentication protocol failure' });
    }
};

/**
 * Verifies a wallet's real on-chain BAG token balance before granting
 * ULTIMATE tier. This is the actual enforcement point for the token-gated
 * premium model — the frontend's UpgradeModal shows a balance for UX
 * purposes only and must never be trusted for the real grant decision.
 * Requires the caller to already be authenticated (verifyToken middleware).
 */
export const verifyUpgrade = async (req, res) => {
    try {
        const { walletAddress } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ verified: false, message: 'Not authenticated.' });
        }
        if (!walletAddress || typeof walletAddress !== 'string') {
            return res.status(400).json({ verified: false, message: 'walletAddress is required.' });
        }

        let normalizedAddress;
        try {
            normalizedAddress = getAddress(walletAddress);
        } catch {
            return res.status(400).json({ verified: false, message: 'Invalid wallet address.' });
        }

        if (!config.bagTokenAddress) {
            console.error('[verifyUpgrade] BAG_TOKEN_ADDRESS is not configured on the server.');
            return res.status(503).json({ verified: false, message: 'Upgrade verification is temporarily unavailable.' });
        }

        const rawBalance = await bscPublicClient.readContract({
            address: config.bagTokenAddress,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [normalizedAddress],
        });
        const balance = Number(formatUnits(rawBalance, 18));

        if (config.minBagRequired > 0 && balance < config.minBagRequired) {
            return res.status(403).json({
                verified: false,
                message: `Wallet holds ${balance.toFixed(2)} BAG, needs ${config.minBagRequired}.`,
            });
        }

        const updatedUser = await store.updateById(
            'users',
            userId,
            u => ({ tier: 'ULTIMATE', verifiedWallet: normalizedAddress })
        );

        if (!updatedUser) {
            return res.status(404).json({ verified: false, message: 'User not found.' });
        }

        const { password: _, ...userSafe } = updatedUser;
        const token = jwt.sign({
            id: updatedUser.id,
            email: updatedUser.email,
            isAdmin: !!updatedUser.isAdmin,
            wallet: updatedUser.verifiedWallet,
        }, config.jwtSecret, { expiresIn: '24h' });

        res.json({ verified: true, user: userSafe, token });
    } catch (error) {
        console.error('[verifyUpgrade] On-chain balance check failed:', error.message);
        res.status(500).json({ verified: false, message: 'Could not verify BAG balance right now. Please try again.' });
    }
};

export const getReferrals = async (req, res) => {
    try {
        if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
        
        const users = await store.read('users');
        const referrals = users
            .filter(u => u.referredBy === req.user.id)
            .map(u => ({
                id: u.id,
                email: u.email,
                pointsEarned: 100,
                joinedAt: u.createdAt || u.lastActive
            }));

        res.json(referrals);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch network' });
    }
};

export const getMe = async (req, res) => {
    try {
        const userId = req.user.id;
        const users = await store.read('users');
        const user = users.find(u => u.id && typeof u.id === 'string' && userId && typeof userId === 'string' && u.id.toLowerCase() === userId.toLowerCase());
        
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        // Remove sensitive data
        const { password, salt, ...safeUser } = user;
        res.json(safeUser);
    } catch (error) {
        console.error('[AUTH] getMe Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const updateProfile = async (req, res) => {
    const { bio, website, location, logoUrl, bannerUrl } = req.body;
    const userId = req.user.id;

    try {
        const updatedUser = await store.updateById('users', userId,
            u => ({
                bio: bio !== undefined ? bio : u.bio,
                website: website !== undefined ? website : u.website,
                location: location !== undefined ? location : u.location,
                logoUrl: logoUrl !== undefined ? logoUrl : u.logoUrl,
                bannerUrl: bannerUrl !== undefined ? bannerUrl : u.bannerUrl,
                updatedAt: new Date().toISOString()
            })
        );

        if (!updatedUser) return res.status(404).json({ error: 'User not found' });

        const { password, salt, ...safeUser } = updatedUser;
        res.json({ success: true, user: safeUser });
    } catch (error) {
        console.error('[AUTH] updateProfile Error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
};
