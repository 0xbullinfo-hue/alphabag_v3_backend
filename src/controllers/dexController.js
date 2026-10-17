import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const DEXSCREENER_ROOT = 'https://api.dexscreener.com';
const CACHE_TTL = 30; // 30 seconds for live DEX data
const LONG_CACHE_TTL = 120; // 2 minutes for metas/profiles

export const dexController = {
  // GET /api/dex/search?q=USDT
  async searchPairs(req, res) {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string' || q.trim().length === 0) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }

      const cacheKey = `dex_search_${q.trim().toLowerCase()}`;
      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const response = await axios.get(`${DEXSCREENER_BASE}/search`, {
          params: { q: q.trim() },
          timeout: 10000,
          headers: { 'User-Agent': 'AlphaBAG-Terminal/2.0' }
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[DexController] Search error:', error.message);
      res.status(502).json({
        error: 'DexScreener search failed',
        pairs: [],
      });
    }
  },

  // GET /api/dex/tokens/:tokenAddress
  async getTokenPairs(req, res) {
    try {
      const { tokenAddress } = req.params;
      if (!tokenAddress) {
        return res.status(400).json({ error: 'Valid token address required' });
      }

      const cacheKey = `dex_token_${tokenAddress.toLowerCase()}`;
      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const response = await axios.get(`${DEXSCREENER_BASE}/tokens/${tokenAddress}`, {
          timeout: 10000,
          headers: { 'User-Agent': 'AlphaBAG-Terminal/2.0' }
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[DexController] Token pairs error:', error.message);
      res.status(502).json({
        error: 'DexScreener token lookup failed',
        pairs: [],
      });
    }
  },

  // GET /api/dex/tokens/:chainId/:tokenAddresses (Up to 30 tokens in one request)
  async getMultiTokenPairs(req, res) {
    try {
      const { chainId, tokenAddresses } = req.params;
      if (!chainId || !tokenAddresses) {
        return res.status(400).json({ error: 'chainId and tokenAddresses parameters are required' });
      }

      const cleanChain = chainId.toLowerCase().trim();
      const cleanAddresses = tokenAddresses.toLowerCase().trim();
      const cacheKey = `dex_multi_${cleanChain}_${cleanAddresses}`;

      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const response = await axios.get(`${DEXSCREENER_ROOT}/tokens/v1/${cleanChain}/${cleanAddresses}`, {
          timeout: 10000,
          headers: { 'User-Agent': 'AlphaBAG-Terminal/2.0' }
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[DexController] Multi-token pairs error:', error.message);
      res.status(502).json({
        error: 'DexScreener multi-token lookup failed',
        pairs: [],
      });
    }
  },

  // GET /api/dex/pairs/:chainId/:pairAddress
  async getPairByAddress(req, res) {
    try {
      const { chainId, pairAddress } = req.params;
      if (!chainId || !pairAddress) {
        return res.status(400).json({ error: 'chainId and pairAddress parameters are required' });
      }

      const cacheKey = `dex_pair_${chainId.toLowerCase()}_${pairAddress.toLowerCase()}`;
      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const response = await axios.get(`${DEXSCREENER_BASE}/pairs/${chainId.toLowerCase()}/${pairAddress}`, {
          timeout: 10000,
          headers: { 'User-Agent': 'AlphaBAG-Terminal/2.0' }
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[DexController] Pair lookup error:', error.message);
      res.status(502).json({
        error: 'DexScreener pair lookup failed',
        pair: null,
      });
    }
  },

  // GET /api/dex/metas/trending
  async getTrendingMetas(req, res) {
    try {
      const cacheKey = 'dex_metas_trending';
      const result = await getOrSetCache(cacheKey, LONG_CACHE_TTL, async () => {
        const response = await axios.get(`${DEXSCREENER_ROOT}/metas/trending/v1`, {
          timeout: 10000,
          headers: { 'User-Agent': 'AlphaBAG-Terminal/2.0' }
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[DexController] Trending metas error:', error.message);
      res.status(502).json({
        error: 'DexScreener trending metas lookup failed',
        metas: [],
      });
    }
  },

  // GET /api/dex/boosts/latest
  async getLatestBoosts(req, res) {
    try {
      const cacheKey = 'dex_boosts_latest';
      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const response = await axios.get(`${DEXSCREENER_ROOT}/token-boosts/latest/v1`, {
          timeout: 10000,
          headers: { 'User-Agent': 'AlphaBAG-Terminal/2.0' }
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[DexController] Latest boosts error:', error.message);
      res.status(502).json({
        error: 'DexScreener boosts lookup failed',
        boosts: [],
      });
    }
  },

  // GET /api/dex/community-takeovers
  async getCommunityTakeovers(req, res) {
    try {
      const cacheKey = 'dex_community_takeovers';
      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const response = await axios.get(`${DEXSCREENER_ROOT}/community-takeovers/latest/v1`, {
          timeout: 10000,
          headers: { 'User-Agent': 'AlphaBAG-Terminal/2.0' }
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[DexController] Community takeovers error:', error.message);
      res.status(502).json({
        error: 'DexScreener CTO lookup failed',
        takeovers: [],
      });
    }
  }
};

export default dexController;
