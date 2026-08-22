import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const CACHE_TTL = 60; // 60 seconds

export const tokenPriceController = {
  // GET /api/market/token-price?platform=ethereum&contract_addresses=0x...
  async getTokenPrices(req, res) {
    try {
      const { platform, contract_addresses } = req.query;

      if (!platform || !contract_addresses) {
        return res.status(400).json({
          error: 'platform and contract_addresses are required',
        });
      }

      const cacheKey = `token_price_${platform}_${contract_addresses}`;
      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const headers = { 'Accept': 'application/json' };
        if (process.env.COINGECKO_API_KEY) {
          headers['x-cg-pro-api-key'] = process.env.COINGECKO_API_KEY;
        }

        const response = await axios.get(`${COINGECKO_BASE}/simple/token_price/${platform}`, {
          params: {
            contract_addresses: contract_addresses,
            vs_currencies: 'usd',
            include_24hr_change: 'true',
            include_market_cap: 'false',
          },
          timeout: 10000,
          headers,
        });
        return response.data;
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[TokenPriceController] Error:', error.message);
      res.status(502).json({
        error: 'CoinGecko token price fetch failed',
        details: error.response?.data || error.message,
      });
    }
  },
};

export default tokenPriceController;
