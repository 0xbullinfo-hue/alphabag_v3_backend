import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const CACHE_TTL = 30; // 30 seconds for DEX data

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
};

export default dexController;
