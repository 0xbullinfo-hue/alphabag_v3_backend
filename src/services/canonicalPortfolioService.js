// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Canonical Portfolio Service
// Single source of truth for portfolio valuations across REST, SSE, and AI.

import NodeCache from 'node-cache';
import { blockchainService } from './blockchainService.js';
import { getEvmTokenPrices, getNativePrices } from './priceService.js';
import { fetchUserCexBalances } from '../controllers/cexController.js';
import { store } from './storeService.js';

const portfolioCache = new NodeCache({ stdTTL: 20, checkperiod: 60, useClones: false });

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/i;
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

export class CanonicalPortfolioService {
  /**
   * Get canonical portfolio snapshot for an authenticated user.
   */
  static async getSnapshot(user, options = {}) {
    const userId = typeof user === 'string' ? user : (user?.id || 'anonymous');
    const cacheKey = `canonical_${userId}`;

    if (!options.force) {
      const cached = portfolioCache.get(cacheKey);
      if (cached) return { ...cached, fromCache: true };
    }

    const now = Date.now();
    const wallets = this.resolveUserWallets(user);
    const evmWallets = wallets.filter(w => EVM_ADDRESS_PATTERN.test(w.address));
    const solanaWallets = wallets.filter(w => SOLANA_ADDRESS_PATTERN.test(w.address));

    // Parallel fetch across providers
    const [dexResult, solanaResult, cexResult] = await Promise.allSettled([
      this.fetchDexPortfolio(evmWallets),
      this.fetchSolanaPortfolio(solanaWallets),
      fetchUserCexBalances(userId),
    ]);

    const dex = dexResult.status === 'fulfilled' ? dexResult.value : { tokens: [], totalUSD: 0, status: 'ERROR', error: dexResult.reason?.message };
    const solana = solanaResult.status === 'fulfilled' ? solanaResult.value : { tokens: [], totalUSD: 0, status: 'ERROR', error: solanaResult.reason?.message };
    const cex = cexResult.status === 'fulfilled' ? cexResult.value : { balances: [], totalUSD: 0, status: 'ERROR' };

    const dexUsd = Number(dex.totalUSD || 0);
    const solanaUsd = Number(solana.totalUSD || 0);
    const cexUsd = Number(cex.totalUSD || 0);
    const totalUSD = Number((dexUsd + solanaUsd + cexUsd).toFixed(2));

    const allTokens = [...(dex.tokens || []), ...(solana.tokens || [])];
    const unvaluedCount = allTokens.filter(t => t.valuationStatus === 'UNAVAILABLE').length;
    const totalCount = allTokens.length;

    let valuationStatus = 'VALUED';
    if (totalCount > 0 && unvaluedCount === totalCount) {
      valuationStatus = 'UNAVAILABLE';
    } else if (unvaluedCount > 0) {
      valuationStatus = 'PARTIAL';
    }

    const complete = dexResult.status === 'fulfilled' && solanaResult.status === 'fulfilled' && cexResult.status === 'fulfilled';

    const snapshot = {
      userId,
      totalUSD,
      valuationStatus,
      complete,
      completeness: {
        evmWallets: evmWallets.length,
        solanaWallets: solanaWallets.length,
        dexStatus: dexResult.status === 'fulfilled' ? 'OK' : 'ERROR',
        solanaStatus: solanaResult.status === 'fulfilled' ? 'OK' : 'ERROR',
        cexStatus: cexResult.status === 'fulfilled' ? 'OK' : 'ERROR',
        unvaluedTokensCount: unvaluedCount,
      },
      dex: {
        tokens: dex.tokens || [],
        totalUSD: dexUsd,
        status: dexResult.status === 'fulfilled' ? 'OK' : 'ERROR',
      },
      solana: {
        tokens: solana.tokens || [],
        totalUSD: solanaUsd,
        status: solanaResult.status === 'fulfilled' ? 'OK' : 'ERROR',
      },
      cex: {
        balances: cex.balances || [],
        totalUSD: cexUsd,
        status: cexResult.status === 'fulfilled' ? 'OK' : 'ERROR',
      },
      defi: {
        positions: [],
        totalUSD: 0,
        debtUSD: 0,
      },
      freshness: {
        dex: now,
        solana: now,
        cex: now,
      },
      timestamp: now,
      updatedAt: new Date(now).toISOString(),
    };

    portfolioCache.set(cacheKey, snapshot);
    return snapshot;
  }

  static resolveUserWallets(user) {
    if (!user) return [];
    const set = new Map();

    const addWallet = (address, chain = 'unknown', type = 'manual') => {
      if (typeof address === 'string' && address.trim()) {
        const clean = address.trim();
        const key = clean.toLowerCase();
        if (!set.has(key)) {
          set.set(key, { address: clean, chain, type });
        }
      }
    };

    if (Array.isArray(user.portfolioWallets)) {
      user.portfolioWallets.forEach(w => addWallet(w.address, w.chain, w.type));
    }
    if (user.verifiedWallet) addWallet(user.verifiedWallet, 'evm', 'verified');
    if (user.wallet) addWallet(user.wallet, 'evm', 'primary');
    if (user.address) addWallet(user.address, 'evm', 'primary');

    return Array.from(set.values());
  }

  static async fetchDexPortfolio(wallets) {
    if (!wallets.length) return { tokens: [], totalUSD: 0 };
    const results = await Promise.all(
      wallets.map(w => this.computeSingleDexPortfolio(w.address))
    );
    const tokens = results.flatMap(r => r.tokens);
    const valuedTokens = tokens.filter(t => Number.isFinite(t.valueUSD));
    const totalUSD = Number(valuedTokens.reduce((sum, t) => sum + t.valueUSD, 0).toFixed(2));
    return { tokens, totalUSD };
  }

  static async computeSingleDexPortfolio(address) {
    const [balances, nativePrices] = await Promise.all([
      blockchainService.getEvmBalances(address),
      getNativePrices(),
    ]);

    const normalized = balances.flatMap((chain) => {
      const chainKey = CHAIN_KEYS[chain.chain];
      if (!chainKey) return [];

      const geckoId = NATIVE_GECKO_IDS[chain.chain];
      const priceUSD = nativePrices[geckoId]?.usd ?? null;
      const change24h = nativePrices[geckoId]?.usd_24h_change ?? null;
      const balanceNum = parseFloat(formatUnits(chain.nativeBalance)) || 0;

      const nativeToken = {
        contractAddress: NATIVE_TOKEN_ADDRESS,
        symbol: chain.chain === 'POLYGON' ? 'MATIC' : chain.chain === 'ARB' ? 'ETH' : chain.chain,
        name: chain.chainName,
        chain: chainKey,
        balance: formatUnits(chain.nativeBalance),
        priceUSD,
        valueUSD: priceUSD == null ? null : balanceNum * priceUSD,
        valuationStatus: priceUSD == null ? 'UNAVAILABLE' : 'VALUED',
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
          priceUSD: null,
          valueUSD: null,
          valuationStatus: 'UNAVAILABLE',
          change24h: null,
          logo: token.logo || undefined,
          isNative: false,
        }));

      return [nativeToken, ...tokens];
    });

    // Price ERC20 tokens
    const byChain = {};
    for (const t of normalized) {
      if (t.isNative || !t.contractAddress) continue;
      (byChain[t.chain] = byChain[t.chain] || []).push(t);
    }

    await Promise.all(Object.entries(byChain).map(async ([chain, chainTokens]) => {
      try {
        const priceMap = await getEvmTokenPrices(chain, chainTokens.map(t => t.contractAddress));
        for (const t of chainTokens) {
          const p = priceMap[t.contractAddress.toLowerCase()];
          if (p && p.usd != null) {
            t.priceUSD = p.usd;
            t.valueUSD = (parseFloat(t.balance) || 0) * p.usd;
            t.change24h = p.usd_24h_change ?? null;
            t.valuationStatus = 'VALUED';
          }
        }
      } catch (err) {
        console.warn(`[CanonicalPortfolio] Pricing failed for chain ${chain}:`, err.message);
      }
    }));

    const valuedTokens = normalized.filter(t => Number.isFinite(t.valueUSD));
    const totalUSD = Number(valuedTokens.reduce((sum, t) => sum + t.valueUSD, 0).toFixed(2));
    return { tokens: normalized, totalUSD };
  }

  static async fetchSolanaPortfolio(wallets) {
    if (!wallets.length) return { tokens: [], totalUSD: 0 };
    const nativePrices = await getNativePrices();
    const solPrice = nativePrices['solana']?.usd ?? null;
    const solChange24h = nativePrices['solana']?.usd_24h_change ?? null;

    const allTokens = [];
    for (const w of wallets) {
      try {
        const solBalances = await blockchainService.getSolanaBalances(w.address);
        if (!solBalances) continue;

        const solAmount = (Number(solBalances.nativeBalance) || 0) / 1e9;
        const nativeSol = {
          contractAddress: 'native',
          symbol: 'SOL',
          name: 'Solana',
          chain: 'solana',
          walletAddress: w.address,
          balance: String(solAmount),
          priceUSD: solPrice,
          valueUSD: solPrice == null ? null : Number((solAmount * solPrice).toFixed(2)),
          valuationStatus: solPrice == null ? 'UNAVAILABLE' : 'VALUED',
          change24h: solChange24h,
          isNative: true,
        };
        allTokens.push(nativeSol);

        (solBalances.tokens || []).forEach(t => {
          allTokens.push({
            contractAddress: t.mint,
            symbol: t.mint,
            name: 'Solana SPL Token',
            chain: 'solana',
            walletAddress: w.address,
            balance: formatUnits(t.balance, t.decimals ?? 9),
            priceUSD: null,
            valueUSD: null,
            valuationStatus: 'UNAVAILABLE',
            change24h: null,
            isNative: false,
          });
        });
      } catch (err) {
        console.warn('[CanonicalPortfolio] Solana fetch failed for address:', w.address, err.message);
      }
    }

    const valuedTokens = allTokens.filter(t => Number.isFinite(t.valueUSD));
    const totalUSD = Number(valuedTokens.reduce((sum, t) => sum + t.valueUSD, 0).toFixed(2));
    return { tokens: allTokens, totalUSD };
  }
}
