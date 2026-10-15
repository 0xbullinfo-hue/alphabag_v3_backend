// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Portfolio Controller (Unified with CanonicalPortfolioService)

import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { getOrSetCache } from '../utils/cache.js';
import { CanonicalPortfolioService } from '../services/canonicalPortfolioService.js';
import { blockchainService } from '../services/blockchainService.js';
import { getNativePrices } from '../services/priceService.js';

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/i;

export const computeDexPortfolio = async (address) => {
  return CanonicalPortfolioService.computeSingleDexPortfolio(address);
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
      const portfolio = await CanonicalPortfolioService.computeSingleDexPortfolio(address);
      const requestedChains = typeof chains === 'string'
        ? new Set(chains.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean))
        : null;
      const tokens = portfolio.tokens.filter((t) => !requestedChains || requestedChains.has(t.chain));
      const valuedTokens = tokens.filter(t => Number.isFinite(t.valueUSD));
      const totalUSD = Number(valuedTokens.reduce((sum, t) => sum + t.valueUSD, 0).toFixed(2));
      return { tokens, totalUSD, updatedAt: new Date().toISOString() };
    });

    res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
    res.json(result.data);
  } catch (err) {
    console.error('PortfolioController: Error fetching balances:', err.message);
    res.status(500).json({ error: 'Failed to fetch blockchain data' });
  }
};

export const getCanonicalPortfolio = async (req, res) => {
  try {
    const snapshot = await CanonicalPortfolioService.getSnapshot(req.user, {
      force: req.query.fresh === 'true',
    });
    res.json({
      success: true,
      ...snapshot,
    });
  } catch (error) {
    console.error('[CanonicalPortfolio] failed:', error.message);
    res.status(502).json({ error: 'Portfolio snapshot unavailable' });
  }
};

export const getNetWorth = async (req, res) => {
  try {
    const snapshot = await CanonicalPortfolioService.getSnapshot(req.user);
    res.json({
      success: true,
      dex: snapshot.dex,
      cex: snapshot.cex,
      solana: snapshot.solana,
      totalUSD: snapshot.totalUSD,
      valuationStatus: snapshot.valuationStatus,
      complete: snapshot.complete,
      updatedAt: snapshot.updatedAt,
    });
  } catch (err) {
    console.error('[NetWorth] Aggregation failed:', err.message);
    res.status(500).json({ error: 'Failed to compute net worth' });
  }
};

export const streamPortfolio = async (req, res) => {
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const rawToken = bearerToken || req.query.token;

  if (!rawToken) {
    return res.status(401).json({ error: 'Token required for SSE portfolio connection' });
  }

  if (req.query.token && !bearerToken) {
    console.warn('[Security] SSE token passed via URL query parameter is deprecated. Pass via Authorization header instead.');
  }

  let user;
  try {
    user = jwt.verify(rawToken, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  let closed = false;
  let interval = null;
  let heartbeat = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    if (heartbeat) clearInterval(heartbeat);
    try { res.end(); } catch (_) {}
  };

  req.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  // Send periodic SSE comment ping every 15s to keep proxy connections alive
  heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch (_) { cleanup(); }
  }, 15000);

  const pushUpdate = async () => {
    if (closed) return;
    try {
      const snapshot = await CanonicalPortfolioService.getSnapshot(user);
      if (closed) return;
      const payload = {
        type: 'portfolio',
        timestamp: Date.now(),
        totalUSD: snapshot.totalUSD,
        valuationStatus: snapshot.valuationStatus,
        complete: snapshot.complete,
        balances: snapshot.dex,
        tokens: snapshot.dex?.tokens || [],
        solana: snapshot.solana,
        cexBalances: snapshot.cex?.balances || [],
        cexTotalUSD: snapshot.cex?.totalUSD || 0,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      if (!closed) {
        try { res.write(`data: ${JSON.stringify({ type: 'error', message: 'Portfolio sync hiccup' })}\n\n`); } catch (_) {}
      }
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

    const nativePrices = await getNativePrices();
    const solPrice = nativePrices['solana']?.usd ?? null;
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
            valueUSD: solPrice == null ? null : Number((solAmount * solPrice).toFixed(2)),
            valuationStatus: solPrice == null ? 'UNAVAILABLE' : 'VALUED',
            change24h: nativePrices['solana']?.usd_24h_change ?? null,
            isNative: true,
          },
          ...(solBalances.tokens || []).map((t) => ({
            contractAddress: t.mint,
            symbol: t.mint,
            chain: 'solana',
            balance: String(t.balance || '0'),
            priceUSD: null,
            valueUSD: null,
            valuationStatus: 'UNAVAILABLE',
            isNative: false,
          })),
        ],
        totalUSD: solPrice == null ? null : Number((solAmount * solPrice).toFixed(2)),
        valuationStatus: solPrice == null ? 'UNAVAILABLE' : 'VALUED',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const fetchNativePrices = getNativePrices;
