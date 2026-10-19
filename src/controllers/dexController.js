import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const DEXSCREENER_ROOT = 'https://api.dexscreener.com';
const CACHE_TTL = 30; // 30 seconds for live DEX data
const LONG_CACHE_TTL = 120; // 2 minutes for metas/profiles

// Strict input validation: values are interpolated into upstream URLs and cache keys, so they must
// never contain path separators, dots or unbounded text.
const CHAIN_ID_RE = /^[a-z0-9-]{2,30}$/;
const ADDRESS_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|[A-Za-z0-9]{20,66})$/;
const MAX_BATCH_ADDRESSES = 30;
const SEARCH_RE = /^[\p{L}\p{N} .$_\-/]{1,64}$/u;

const isChainId = (v) => typeof v === 'string' && CHAIN_ID_RE.test(v.trim().toLowerCase());
const isAddress = (v) => typeof v === 'string' && ADDRESS_RE.test(v.trim());
const parseAddressList = (raw) => {
  if (typeof raw !== 'string') return null;
  const list = raw.split(',').map((a) => a.trim()).filter(Boolean);
  if (list.length === 0 || list.length > MAX_BATCH_ADDRESSES || !list.every(isAddress)) return null;
  return list;
};

export const dexController = {
  // GET /api/dex/search?q=USDT
  async searchPairs(req, res) {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string' || q.trim().length === 0) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      if (!SEARCH_RE.test(q.trim())) {
        return res.status(400).json({ error: 'Query contains unsupported characters or is too long' });
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
      if (!isAddress(tokenAddress)) {
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

      const addressList = parseAddressList(tokenAddresses);
      if (!isChainId(chainId) || !addressList) {
        return res.status(400).json({ error: `Invalid chainId or tokenAddresses (max ${MAX_BATCH_ADDRESSES} valid addresses)` });
      }
      const cleanChain = chainId.toLowerCase().trim();
      const cleanAddresses = addressList.map((a) => a.toLowerCase()).join(',');
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
      if (!isChainId(chainId) || !isAddress(pairAddress)) {
        return res.status(400).json({ error: 'Valid chainId and pairAddress are required' });
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
