// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Live Market Controller
// Backed by CoinStats API with automatic CoinGecko fallback.

import axios from 'axios';
import { config } from '../config/env.js';
import NodeCache from 'node-cache';
import {
  getLiveCoins,
  getLiveCoin,
  getGlobalMarketTelemetry,
  getLiveNews,
  getPricesByCoinStats,
} from '../services/coinstatsService.js';

const priceCache = new NodeCache({ stdTTL: 15, checkperiod: 120 });
const searchCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const marketDataCache = new NodeCache({ stdTTL: 30, checkperiod: 120 });

export const getPrices = async (req, res) => {
  const { ids } = req.query;
  if (!ids || typeof ids !== 'string' || ids.length > 500) {
    return res.status(400).json({ error: 'Valid coin ids parameter required' });
  }

  const cacheKey = `prices_${ids.toLowerCase().trim()}`;
  if (priceCache.has(cacheKey)) {
    return res.json(priceCache.get(cacheKey));
  }

  const idList = ids.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // 1. Try CoinStats first (real-time high-throughput)
  try {
    const csPrices = await getPricesByCoinStats(idList);
    if (csPrices && Object.keys(csPrices).length > 0) {
      priceCache.set(cacheKey, csPrices);
      return res.json(csPrices);
    }
  } catch (csError) {
    console.warn(`[Market] CoinStats getPrices failed, falling back to CoinGecko: ${csError.message}`);
  }

  // 2. Fallback to CoinGecko
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: ids.trim(),
        vs_currencies: 'usd',
        include_24hr_change: 'true',
      },
      timeout: 10000,
      headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {},
    });

    priceCache.set(cacheKey, response.data);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: 'Market data sync failed' });
  }
};

export const searchCoins = async (req, res) => {
  const { query } = req.query;
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.json([]);
  }

  const sanitized = query.trim().slice(0, 50);
  const cacheKey = `search_${sanitized.toLowerCase()}`;
  if (searchCache.has(cacheKey)) {
    return res.json(searchCache.get(cacheKey));
  }

  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/search`, {
      params: { query: sanitized },
      timeout: 10000,
      headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {},
    });
    const results = (response.data?.coins || []).slice(0, 8);
    searchCache.set(cacheKey, results);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
};

export const getCoinsMarkets = async (req, res) => {
  const {
    vs_currency = 'usd',
    order = 'market_cap_desc',
    per_page = '100',
    page = '1',
    sparkline = 'false',
    price_change_percentage,
    ids,
  } = req.query;

  // Bounds check pagination to prevent DoS
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safePerPage = Math.min(Math.max(1, parseInt(per_page, 10) || 100), 250);
  const safeCurrency = typeof vs_currency === 'string' ? vs_currency.slice(0, 10).toLowerCase() : 'usd';

  const cacheKey = `markets_${safeCurrency}_${order}_${safePerPage}_${safePage}_${sparkline}_${price_change_percentage}_${ids || 'all'}`;

  if (marketDataCache.has(cacheKey)) {
    return res.json(marketDataCache.get(cacheKey));
  }

  // 1. Try CoinStats real-time live market feed
  try {
    const liveCoins = await getLiveCoins({
      page: safePage,
      limit: safePerPage,
      currency: safeCurrency,
    });

    if (Array.isArray(liveCoins) && liveCoins.length > 0) {
      let filtered = liveCoins;
      if (ids && typeof ids === 'string') {
        const idSet = new Set(ids.split(',').map((id) => id.trim().toLowerCase()));
        filtered = liveCoins.filter(
          (c) => idSet.has(c.id.toLowerCase()) || idSet.has(c.symbol.toLowerCase())
        );
      }
      marketDataCache.set(cacheKey, filtered);
      return res.json(filtered);
    }
  } catch (csError) {
    console.warn(`[Market] CoinStats coins/markets failed, falling back to CoinGecko: ${csError.message}`);
  }

  // 2. Fallback to CoinGecko
  try {
    const params = {
      vs_currency: safeCurrency,
      order: typeof order === 'string' ? order.slice(0, 20) : 'market_cap_desc',
      per_page: safePerPage,
      page: safePage,
      sparkline: sparkline === 'true',
    };
    if (price_change_percentage) params.price_change_percentage = price_change_percentage;
    if (ids && typeof ids === 'string') params.ids = ids.slice(0, 500);

    const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params,
      timeout: 10000,
      headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {},
    });

    marketDataCache.set(cacheKey, response.data);
    res.json(response.data);
  } catch (error) {
    console.error(`[Market] coins/markets fetch failed: ${error.message}`);
    res.status(error.response?.status || 500).json({ error: 'Failed to fetch coin markets' });
  }
};

/**
 * GET /api/market/global
 * Real-time global market telemetry (market cap, 24h volume, BTC dominance, percent changes)
 */
export const getGlobalOverview = async (req, res) => {
  const cacheKey = 'market_global_overview_cache';
  if (marketDataCache.has(cacheKey)) {
    return res.json(marketDataCache.get(cacheKey));
  }

  // 1. Try CoinStats real-time live telemetry
  try {
    const data = await getGlobalMarketTelemetry();
    if (data && (data.marketCap || data.totalMarketCap || data.volume)) {
      marketDataCache.set(cacheKey, data, 20);
      return res.json(data);
    }
  } catch (error) {
    console.warn(`[Market] CoinStats global telemetry error: ${error.message}`);
  }

  // 2. Resilient Fallback to CoinGecko
  try {
    const cgRes = await axios.get('https://api.coingecko.com/api/v3/global', {
      timeout: 8000,
      headers: config.coingeckoApiKey ? { 'x-cg-pro-api-key': config.coingeckoApiKey } : {},
    });
    const cgData = cgRes.data?.data;
    if (cgData) {
      const fallback = {
        marketCap: Number(cgData.total_market_cap?.usd || 0),
        volume: Number(cgData.total_volume?.usd || 0),
        btcDominance: Number(cgData.market_cap_percentage?.btc || 0),
        ethDominance: Number(cgData.market_cap_percentage?.eth || 0),
        marketCapChange24h: Number(cgData.market_cap_change_percentage_24h_usd || 0),
        volumeChange24h: Number(cgData.volume_change_percentage_24h_usd || 0),
        source: 'coingecko-fallback',
      };
      marketDataCache.set(cacheKey, fallback, 30);
      return res.json(fallback);
    }
  } catch (cgError) {
    console.warn(`[Market] CoinGecko global fallback error: ${cgError.message}`);
  }

  res.status(503).json({ error: 'Global market telemetry unavailable' });
};

/**
 * GET /api/market/news
 * Live crypto news feed from CoinStats
 */
export const getLiveNewsFeed = async (req, res) => {
  try {
    const { page = '1', limit = '10' } = req.query;
    const news = await getLiveNews({ page, limit });
    if (Array.isArray(news) && news.length > 0) {
      return res.json(news);
    }
  } catch (error) {
    console.warn(`[Market] CoinStats live news feed error: ${error.message}`);
  }

  // Resilient fallback news
  res.json([
    {
      id: 'news-fallback-1',
      title: 'Global Crypto Markets Maintain Liquidity Amid Multi-Chain Ecosystem Expansion',
      description: 'Major digital assets consolidate institutional flows across Layer-1 and DeFi protocols.',
      source: 'AlphaBAG Market Intelligence',
      feedDate: Date.now(),
      link: 'https://alphabag.app',
      imgUrl: 'https://static.coinstats.app/coins/1650455588819.png',
    },
    {
      id: 'news-fallback-2',
      title: 'On-Chain Whale Accumulation Trends Highlight High-Conviction Holdings',
      description: 'Institutional smart wallets maintain defensive risk parameters across decentralized liquidity pools.',
      source: 'AlphaBAG Terminal',
      feedDate: Date.now() - 3600000,
      link: 'https://alphabag.app',
      imgUrl: 'https://static.coinstats.app/coins/1650455629727.png',
    }
  ]);
};

/**
 * GET /api/market/coins/:coinId
 * Live single coin telemetry from CoinStats
 */
export const getCoinDetails = async (req, res) => {
  try {
    const coinId = req.params.coinId || req.query.coinId;
    if (!coinId) {
      return res.status(400).json({ error: 'Coin ID required' });
    }

    // 1. Try CoinStats
    try {
      const coin = await getLiveCoin(coinId);
      if (coin) return res.json(coin);
    } catch (csErr) {
      console.warn(`[Market] CoinStats getLiveCoin failed: ${csErr.message}`);
    }

    // 2. Resilient Fallback to CoinGecko
    try {
      const cleanId = encodeURIComponent(coinId.toLowerCase().trim());
      const cgRes = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${cleanId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
        {
          timeout: 8000,
          headers: config.coingeckoApiKey ? { 'x-cg-pro-api-key': config.coingeckoApiKey } : {},
        }
      );
      const d = cgRes.data;
      if (d) {
        const fallback = {
          id: d.id,
          icon: d.image?.large || d.image?.small,
          name: d.name,
          symbol: d.symbol?.toUpperCase(),
          rank: d.market_cap_rank,
          price: Number(d.market_data?.current_price?.usd || 0),
          volume: Number(d.market_data?.total_volume?.usd || 0),
          marketCap: Number(d.market_data?.market_cap?.usd || 0),
          availableSupply: Number(d.market_data?.circulating_supply || 0),
          totalSupply: Number(d.market_data?.total_supply || 0),
          priceChange1h: Number(d.market_data?.price_change_percentage_1h_in_currency?.usd || 0),
          priceChange1d: Number(d.market_data?.price_change_percentage_24h || 0),
          priceChange1w: Number(d.market_data?.price_change_percentage_7d || 0),
          allTimeHigh: Number(d.market_data?.ath?.usd || 0),
          allTimeLow: Number(d.market_data?.atl?.usd || 0),
          source: 'coingecko-fallback',
        };
        return res.json(fallback);
      }
    } catch (cgErr) {
      console.warn(`[Market] CoinGecko coin fallback error: ${cgErr.message}`);
    }

    res.status(404).json({ error: 'Coin not found' });
  } catch (error) {
    console.error('[Market] Coin details error:', error.message);
    res.status(500).json({ error: 'Failed to fetch coin details' });
  }
};

/**
 * GET /api/stream/ticker
 * Server-Sent Events (SSE) live price ticker stream
 */
export const streamMarketTicker = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  let closed = false;
  let interval = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    try { res.end(); } catch (_) {}
  };

  req.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  const pushTicker = async () => {
    if (closed) return;
    try {
      const [coins, telemetry] = await Promise.all([
        getLiveCoins({ page: 1, limit: 20 }),
        getGlobalMarketTelemetry(),
      ]);
      if (closed) return;
      const payload = {
        type: 'market_ticker',
        timestamp: Date.now(),
        telemetry,
        coins: (coins || []).slice(0, 20).map((c) => ({
          id: c.id,
          symbol: (c.symbol || '').toUpperCase(),
          name: c.name,
          image: c.image,
          price: c.current_price,
          change1h: c.price_change_percentage_1h_in_currency,
          change24h: c.price_change_percentage_24h,
          change7d: c.price_change_percentage_7d_in_currency,
          volume: c.total_volume,
          marketCap: c.market_cap,
        })),
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      if (!closed) {
        try { res.write(': heartbeat\n\n'); } catch (_) {}
      }
    }
  };

  await pushTicker();
  if (!closed) {
    interval = setInterval(pushTicker, 6000);
  }
};

export default {
  getPrices,
  searchCoins,
  getCoinsMarkets,
  getGlobalOverview,
  getLiveNewsFeed,
  getCoinDetails,
  streamMarketTicker,
};
