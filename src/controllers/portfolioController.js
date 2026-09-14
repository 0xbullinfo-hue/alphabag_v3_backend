// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Portfolio Controller (fixed)
// Fixes vs. previous version:
//   1. ERC-20 tokens are now PRICED (CoinGecko token_price + DexScreener
//      fallback via priceService). Previously only natives had prices.
//   2. streamPortfolio is a REAL SSE stream: emits priced DEX + CEX balances
//      immediately and every 25s. Previously it only sent heartbeats.
//   3. New: GET /api/portfolio/net-worth (auth) — unified DEX+CEX aggregation.

import axios from 'axios';
import jwt from 'jsonwebtoken';
import { blockchainService } from '../services/blockchainService.js';
import { getOrSetCache } from '../utils/cache.js';
import { config } from '../config/env.js';
import { getEvmTokenPrices, getNativePrices } from '../services/priceService.js';
import { fetchUserCexBalances } from './cexController.js';

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAIN_KEYS = {
    ETH: 'ethereum',
    BSC: 'bsc',
    POLYGON: 'polygon',
    BASE: 'base',
    ARB: 'arbitrum',
    AVAX: 'avalanche',
};

const NATIVE_GECKO_IDS = {
    ETH: 'ethereum',
    POLYGON: 'matic-network',
    BASE: 'ethereum',
    ARB: 'ethereum',
    BSC: 'binancecoin',
    AVAX: 'avalanche-2',
};

const formatUnits = (value, decimals = 18) => {
    try {
        const raw = BigInt(value || 0);
        const divisor = 10n ** BigInt(decimals);
        const whole = raw / divisor;
        const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction.slice(0, 12)}` : whole.toString();
    } catch {
        return '0';
    }
};

const normalizeEvmBalances = (chains, prices = {}) => chains.flatMap((chain) => {
    const chainKey = CHAIN_KEYS[chain.chain];
    if (!chainKey) return [];

    const geckoId = NATIVE_GECKO_IDS[chain.chain];
    const priceUSD = prices[geckoId]?.usd || 0;
    const change24h = prices[geckoId]?.usd_24h_change || 0;
    const balanceNum = parseFloat(formatUnits(chain.nativeBalance)) || 0;

    const nativeToken = {
        contractAddress: NATIVE_TOKEN_ADDRESS,
        symbol: chain.chain === 'POLYGON' ? 'MATIC' : chain.chain === 'ARB' ? 'ETH' : chain.chain,
        name: chain.chainName,
        chain: chainKey,
        balance: formatUnits(chain.nativeBalance),
        priceUSD,
        valueUSD: balanceNum * priceUSD,
        change24h,
        isNative: true,
    };

    const tokens = (chain.tokens || [])
        .filter((token) => token.address && token.address !== NATIVE_TOKEN_ADDRESS)
        .map((token) => ({
            contractAddress: token.address.toLowerCase(),
            symbol: token.symbol || 'UNK',
            name: token.name || 'Unknown Token',
            chain: chainKey,
            balance: formatUnits(token.balance, token.decimals ?? 18),
            priceUSD: 0,
            valueUSD: 0,
            change24h: 0,
            logo: token.logo || undefined,
            isNative: false,
        }));

    return [nativeToken, ...tokens];
});

/** Price every ERC-20 in-place by chain (batched, cached). */
const priceErc20Tokens = async (tokens) => {
    const byChain = {};
    for (const t of tokens) {
        if (t.isNative || !t.contractAddress) continue;
        (byChain[t.chain] = byChain[t.chain] || []).push(t);
    }

    await Promise.all(Object.entries(byChain).map(async ([chain, chainTokens]) => {
        const priceMap = await getEvmTokenPrices(chain, chainTokens.map((t) => t.contractAddress));
        for (const t of chainTokens) {
            const p = priceMap[t.contractAddress.toLowerCase()];
            if (p) {
                t.priceUSD = p.usd;
                t.valueUSD = (parseFloat(t.balance) || 0) * p.usd;
                t.change24h = p.usd_24h_change;
            }
        }
    }));

    return tokens;
};

/** Full priced DEX portfolio for an EVM address. */
export const computeDexPortfolio = async (address) => {
    const [balances, nativePrices] = await Promise.all([
        blockchainService.getEvmBalances(address),
        getNativePrices(),
    ]);
    const tokens = await priceErc20Tokens(normalizeEvmBalances(balances, nativePrices));
    const totalUSD = Number(tokens.reduce((sum, t) => sum + (t.valueUSD || 0), 0).toFixed(2));
    return { tokens, totalUSD };
};

export const getBalances = async (req, res) => {
    const { address, chains } = req.query;

    if (typeof address !== 'string' || !EVM_ADDRESS_PATTERN.test(address)) {
        return res.status(400).json({ error: 'address must be a valid EVM address' });
    }

    const normalizedAddress = address.toLowerCase();
    const cacheKey = `portfolio_balances_${normalizedAddress}_${chains || 'all'}`;

    try {
        const result = await getOrSetCache(cacheKey, 30, async () => {
            const portfolio = await computeDexPortfolio(address);
            const requestedChains = typeof chains === 'string'
                ? new Set(chains.split(',').map((chain) => chain.trim()).filter(Boolean))
                : null;
            const tokens = portfolio.tokens.filter((token) => !requestedChains || requestedChains.has(token.chain));
            const totalUSD = Number(tokens.reduce((sum, t) => sum + (t.valueUSD || 0), 0).toFixed(2));
            return { tokens, totalUSD, updatedAt: new Date().toISOString() };
        });

        res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.json(result.data);
    } catch (err) {
        console.error('PortfolioController: Error fetching balances:', err.message);
        res.status(500).json({ error: 'Failed to fetch blockchain data' });
    }
};

export const getAggregatedPortfolio = async (req, res) => {
    const { address } = req.query;
    if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: 'address is required' });
    }

    const cacheKey = `portfolio_aggregated_${address.toLowerCase()}`;
    try {
        const result = await getOrSetCache(cacheKey, 30, async () => {
            const evmBalances = await blockchainService.getEvmBalances(address);
            return { success: true, data: evmBalances };
        });

        res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * GET /api/portfolio/net-worth (auth required)
 * Unified, priced aggregation of a user's DEX wallets + all CEX connections.
 */
export const getNetWorth = async (req, res) => {
    try {
        const queryAddress = typeof req.query.address === 'string' && req.query.address
            ? req.query.address
            : null;
        const userAddress = queryAddress
            || req.user.verifiedWallet
            || req.user.wallet
            || req.user.address
            || null;

        const isEvm = userAddress && EVM_ADDRESS_PATTERN.test(userAddress);
        const isSolana = userAddress && SOLANA_ADDRESS_PATTERN.test(userAddress) && !isEvm;

        const [dex, cex, solana] = await Promise.all([
            isEvm
                ? getOrSetCache(`nw_dex_${userAddress.toLowerCase()}`, 30, () => computeDexPortfolio(userAddress)).then((r) => r.data)
                : Promise.resolve({ tokens: [], totalUSD: 0 }),
            fetchUserCexBalances(req.user.id),
            isSolana
                ? getOrSetCache(`nw_sol_${userAddress}`, 60, async () => {
                    const sol = await blockchainService.getSolanaBalances(userAddress);
                    if (!sol) return { tokens: [], totalUSD: 0 };
                    const nativePrices = await getNativePrices();
                    const solPrice = nativePrices['solana']?.usd || 0;
                    const solAmount = (Number(sol.nativeBalance) || 0) / 1e9;
                    return {
                        tokens: [{
                            contractAddress: 'native',
                            symbol: 'SOL',
                            name: 'Solana',
                            chain: 'solana',
                            balance: String(solAmount),
                            priceUSD: solPrice,
                            valueUSD: solAmount * solPrice,
                            change24h: nativePrices['solana']?.usd_24h_change || 0,
                            isNative: true,
                        }],
                        totalUSD: Number((solAmount * solPrice).toFixed(2)),
                    };
                }).then((r) => r.data)
                : Promise.resolve(null),
        ]);

        const totalUSD = Number(((dex?.totalUSD || 0) + (cex?.totalUSD || 0) + (solana?.totalUSD || 0)).toFixed(2));
        res.json({
            success: true,
            dex,
            cex,
            solana,
            totalUSD,
            updatedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[NetWorth] Aggregation failed:', err.message);
        res.status(500).json({ error: 'Failed to compute net worth' });
    }
};

/**
 * REAL portfolio event stream.
 * Emits an immediate snapshot, then refreshes every 25 seconds:
 *   data: {"type":"portfolio","tokens":[...],"balances":{"tokens","totalUSD"},
 *          "cexBalances":[...],"totalUSD":..., "timestamp":...}
 * Falls back gracefully per-source so one failing CEX never kills the stream.
 */
export const streamPortfolio = async (req, res) => {
    const rawToken = req.query.token || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].split(' ')[1] : null);
    if (!rawToken) {
        return res.status(401).json({ error: 'Token required for SSE portfolio connection' });
    }

    let user;
    try {
        user = jwt.verify(rawToken, config.jwtSecret);
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const address = typeof req.query.address === 'string' && req.query.address
        ? req.query.address
        : (user.verifiedWallet || user.wallet || user.address || null);
    const isEvm = address && EVM_ADDRESS_PATTERN.test(address);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
    if (res.flushHeaders) res.flushHeaders();

    let closed = false;
    let interval = null;

    req.on('close', () => {
        closed = true;
        if (interval) clearInterval(interval);
        res.end();
    });

    const pushUpdate = async () => {
        if (closed) return;
        try {
            const payload = { type: 'portfolio', timestamp: Date.now() };

            if (isEvm) {
                try {
                    payload.balances = await computeDexPortfolio(address);
                    payload.tokens = payload.balances.tokens; // array alias for older clients
                } catch (e) {
                    console.warn('[SSE] DEX refresh failed:', e.message);
                }
            }

            try {
                const cexResult = await fetchUserCexBalances(user.id);
                payload.cexBalances = cexResult.balances;
                payload.cexTotalUSD = cexResult.totalUSD;
            } catch (e) {
                console.warn('[SSE] CEX refresh failed:', e.message);
                payload.cexBalances = payload.cexBalances || [];
            }

            payload.totalUSD = Number(((payload.balances?.totalUSD || 0) + (payload.cexTotalUSD || 0)).toFixed(2));
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (e) {
            if (!closed) res.write(`data: ${JSON.stringify({ type: 'error', message: 'Portfolio sync hiccup — retrying' })}\n\n`);
        }
    };

    await pushUpdate();
    if (!closed) interval = setInterval(pushUpdate, 25000);
};

export const getSolanaPortfolio = async (req, res) => {
    const { address } = req.query;
    if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: 'Solana address is required' });
    }
    try {
        const solBalances = await blockchainService.getSolanaBalances(address);
        if (!solBalances) {
            return res.status(500).json({ error: 'Failed to fetch Solana balances' });
        }

        // Price the SOL native balance (lamports → SOL)
        const nativePrices = await getNativePrices();
        const solPrice = nativePrices['solana']?.usd || 0;
        const solAmount = (Number(solBalances.nativeBalance) || 0) / 1e9;

        res.json({
            success: true,
            balances: {
                ...solBalances,
                tokens: [
                    {
                        contractAddress: 'native',
                        symbol: 'SOL',
                        name: 'Solana',
                        chain: 'solana',
                        balance: String(solAmount),
                        priceUSD: solPrice,
                        valueUSD: Number((solAmount * solPrice).toFixed(2)),
                        change24h: nativePrices['solana']?.usd_24h_change || 0,
                        isNative: true,
                    },
                    ...(solBalances.tokens || []).map((t) => ({
                        contractAddress: t.mint,
                        symbol: t.mint,
                        chain: 'solana',
                        balance: formatUnits(t.balance, t.decimals ?? 9),
                        priceUSD: 0,
                        valueUSD: 0,
                        isNative: false,
                    })),
                ],
                totalUSD: Number((solAmount * solPrice).toFixed(2)),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// fetchNativePrices re-exported for backwards compatibility with any older imports
export const fetchNativePrices = getNativePrices;


export const getCanonicalPortfolio = async (req, res) => {
    try {
        const wallets = Array.isArray(req.user?.portfolioWallets) ? req.user.portfolioWallets : [];
        const dexResults = await Promise.all(wallets
            .filter(w => /^0x[a-fA-F0-9]{40}$/.test(w.address || ''))
            .map(w => computeDexPortfolio(w.address)));

        const cex = await fetchUserCexBalances(req.user?.id || '');
        const dexTokens = dexResults.flatMap(r => r.tokens || []);
        const dexUsd = dexResults.reduce((n, r) => n + (r.totalUSD || 0), 0);
        const totalUSD = Number((dexUsd + (cex?.totalUSD || 0)).toFixed(2));

        res.json({
            success: true,
            dex: { tokens: dexTokens, totalUSD: Number(dexUsd.toFixed(2)) },
            defi: { positions: [], totalUSD: 0, debtUSD: 0 },
            cex: { balances: cex?.balances || [], totalUSD: cex?.totalUSD || 0 },
            totalUSD,
            freshness: {
                dex: Date.now(),
                cex: Date.now(),
                defi: null,
            },
            updatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[CanonicalPortfolio] failed:', error.message);
        res.status(502).json({ error: 'Portfolio snapshot unavailable' });
    }
};
