// SPDX-License-Identifier: MIT
// AlphaBAG V3 — CoinStats Real-Time Live Data Service
// High-throughput live market quotes, global telemetry, and multi-chain wallet data.

import axios from 'axios';
import NodeCache from 'node-cache';
import { config } from '../config/env.js';

const coinstatsCache = new NodeCache({ stdTTL: 30, checkperiod: 60, useClones: false });

const COINSTATS_BASE = 'https://openapiv1.coinstats.app';

const getHeaders = () => {
  const apiKey = config.coinstatsApiKey || process.env.COINSTATS_API_KEY;
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'AlphaBAG-Terminal/3.0',
  };
  if (apiKey) {
    headers['X-API-KEY'] = apiKey;
  }
  return headers;
};

/**
 * Fetch top coins formatted for AlphaBAG exchange-grade tables & ticker
 */
export async function getLiveCoins({ page = 1, limit = 100, currency = 'USD' } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 250);
  const safeCurrency = (currency || 'USD').toUpperCase();
  const cacheKey = `coinstats_coins_${safePage}_${safeLimit}_${safeCurrency}`;

  const hit = coinstatsCache.get(cacheKey);
  if (hit) return hit;

  try {
    const { data } = await axios.get(`${COINSTATS_BASE}/coins`, {
      params: { page: safePage, limit: safeLimit, currency: safeCurrency },
      headers: getHeaders(),
      timeout: 10000,
    });

    const rawList = data?.result || (Array.isArray(data) ? data : []);
    const formatted = rawList.map((c) => ({
      id: c.id,
      symbol: (c.symbol || '').toLowerCase(),
      name: c.name,
      image: c.icon,
      current_price: Number(c.price || 0),
      market_cap: Number(c.marketCap || 0),
      market_cap_rank: Number(c.rank || 0),
      price_change_percentage_1h_in_currency: Number(c.priceChange1h ?? 0),
      price_change_percentage_24h: Number(c.priceChange1d ?? 0),
      price_change_percentage_24h_in_currency: Number(c.priceChange1d ?? 0),
      price_change_percentage_7d_in_currency: Number(c.priceChange1w ?? 0),
      price_change_percentage_30d_in_currency: Number(c.priceChange1m ?? 0),
      total_volume: Number(c.volume || 0),
      circulating_supply: Number(c.availableSupply || 0),
      total_supply: Number(c.totalSupply || 0),
      contract_addresses: c.contractAddresses || [],
      sparkline_in_7d: undefined,
    }));

    coinstatsCache.set(cacheKey, formatted, 20);
    return formatted;
  } catch (error) {
    console.warn(`[CoinStats] /coins fetch failed: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch single coin details
 */
export async function getLiveCoin(coinId) {
  if (!coinId || typeof coinId !== 'string') return null;
  const cleanId = coinId.trim().toLowerCase();
  const cacheKey = `coinstats_coin_${cleanId}`;

  const hit = coinstatsCache.get(cacheKey);
  if (hit) return hit;

  try {
    const { data } = await axios.get(`${COINSTATS_BASE}/coins/${encodeURIComponent(cleanId)}`, {
      headers: getHeaders(),
      timeout: 10000,
    });

    if (data) {
      coinstatsCache.set(cacheKey, data, 30);
    }
    return data;
  } catch (error) {
    console.warn(`[CoinStats] /coins/${cleanId} fetch failed: ${error.message}`);
    return null;
  }
}

/**
 * Fetch global market telemetry
 */
export async function getGlobalMarketTelemetry() {
  const cacheKey = 'coinstats_global_markets';
  const hit = coinstatsCache.get(cacheKey);
  if (hit) return hit;

  try {
    const { data } = await axios.get(`${COINSTATS_BASE}/markets`, {
      headers: getHeaders(),
      timeout: 8000,
    });

    if (data) {
      coinstatsCache.set(cacheKey, data, 30);
    }
    return data;
  } catch (error) {
    console.warn(`[CoinStats] /markets fetch failed: ${error.message}`);
    return null;
  }
}

/**
 * Fetch live news feed
 */
export async function getLiveNews({ page = 1, limit = 10 } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
  const cacheKey = `coinstats_news_${safePage}_${safeLimit}`;

  const hit = coinstatsCache.get(cacheKey);
  if (hit) return hit;

  try {
    const { data } = await axios.get(`${COINSTATS_BASE}/news`, {
      params: { page: safePage, limit: safeLimit },
      headers: getHeaders(),
      timeout: 8000,
    });

    const news = data?.result || [];
    coinstatsCache.set(cacheKey, news, 60);
    return news;
  } catch (error) {
    console.warn(`[CoinStats] /news fetch failed: ${error.message}`);
    return [];
  }
}

/**
 * Get simple prices for IDs matching CoinGecko schema
 * @param {string[]} ids
 * @returns {Promise<Record<string, { usd: number, usd_24h_change: number }>>}
 */
export async function getPricesByCoinStats(ids = []) {
  if (!ids.length) return {};
  const cacheKey = `coinstats_prices_${ids.sort().join('_')}`;
  const hit = coinstatsCache.get(cacheKey);
  if (hit) return hit;

  try {
    const coins = await getLiveCoins({ page: 1, limit: 100 });
    const result = {};

    const targetSet = new Set(ids.map((id) => id.toLowerCase()));

    for (const c of coins) {
      if (targetSet.has(c.id.toLowerCase()) || targetSet.has(c.symbol.toLowerCase())) {
        result[c.id] = {
          usd: c.current_price,
          usd_24h_change: c.price_change_percentage_24h,
        };
      }
    }

    // If some specific IDs weren't in top 100, try fetching individually
    const missing = ids.filter((id) => !result[id] && !result[id.toLowerCase()]);
    if (missing.length > 0 && missing.length <= 5) {
      await Promise.all(
        missing.map(async (mId) => {
          const coinData = await getLiveCoin(mId);
          if (coinData) {
            result[coinData.id] = {
              usd: Number(coinData.price || 0),
              usd_24h_change: Number(coinData.priceChange1d || 0),
            };
          }
        })
      );
    }

    coinstatsCache.set(cacheKey, result, 15);
    return result;
  } catch (error) {
    console.warn(`[CoinStats] getPricesByCoinStats failed: ${error.message}`);
    return {};
  }
}

/**
 * Fetch multi-chain wallet balances via CoinStats
 */
export async function getWalletBalances(address, connectionType = 'ethereum') {
  if (!address) return [];
  const cacheKey = `coinstats_wallet_${address}_${connectionType}`;
  const hit = coinstatsCache.get(cacheKey);
  if (hit) return hit;

  try {
    const { data } = await axios.get(`${COINSTATS_BASE}/wallet/balance`, {
      params: { address, connectionType },
      headers: getHeaders(),
      timeout: 10000,
    });

    const balances = Array.isArray(data) ? data : (data?.result || []);
    coinstatsCache.set(cacheKey, balances, 30);
    return balances;
  } catch (error) {
    console.warn(`[CoinStats] /wallet/balance failed: ${error.message}`);
    return [];
  }
}

export default {
  getLiveCoins,
  getLiveCoin,
  getGlobalMarketTelemetry,
  getLiveNews,
  getPricesByCoinStats,
  getWalletBalances,
};
