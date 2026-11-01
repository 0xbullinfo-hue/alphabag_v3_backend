import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const CACHE_TTL = 30; // 30 seconds for DEX data
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryDelay = (error, retryCount) => {
  const retryAfter = error.response?.headers?.['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()));
  }
  const exponential = Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** (retryCount - 1)));
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
};

export async function requestDexScreener(url, options = {}, request = axios.get, wait = sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request(url, options);
    } catch (error) {
      const status = error.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt > MAX_RETRIES) throw error;
      await wait(retryDelay(error, attempt));
    }
  }
}

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
        const response = await requestDexScreener(`${DEXSCREENER_BASE}/search`, {
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
        const response = await requestDexScreener(`${DEXSCREENER_BASE}/tokens/${tokenAddress}`, {
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
