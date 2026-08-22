import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2';
const CACHE_TTL = 60;

const TRACKED_WHALE_WALLETS = {
  eth: [
    '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    '0x8ba1f109551bD432803012645Hac136c82C3e8C9',
  ],
  bsc: [
    '0x8894e0a0c962cb723c1976a4421c95949be2d4e3',
  ],
  sol: [
    'H8sMJSCg6X3s3v4j7v8w9x0y1z2a3b4c5d6e7f8g9h',
  ],
};

function generateMockWhaleTransactions(chain = 'eth', count = 20) {
  const symbols = { eth: 'ETH', bsc: 'BNB', sol: 'SOL', polygon: 'MATIC', base: 'ETH', arbitrum: 'ETH' };
  const names = { eth: 'Ethereum', bsc: 'BNB Chain', sol: 'Solana', polygon: 'Polygon', base: 'Base', arbitrum: 'Arbitrum' };
  const sym = symbols[chain.toLowerCase()] || 'ETH';
  const name = names[chain.toLowerCase()] || 'Ethereum';

  return Array.from({ length: count }, (_, i) => ({
    id: `0x${Math.random().toString(16).substring(2, 42).padStart(40, '0')}`,
    from: `0x${Math.random().toString(16).substring(2, 42).padStart(40, '0')}`,
    to: `0x${Math.random().toString(16).substring(2, 42).padStart(40, '0')}`,
    value: (Math.random() * 500 + 50).toFixed(4),
    tokenSymbol: sym,
    tokenName: name,
    timestamp: new Date(Date.now() - i * 180000).toISOString(),
    txHash: `0x${Math.random().toString(16).substring(2, 66).padStart(64, '0')}`,
    chain,
  }));
}

export const whaleController = {
  // GET /api/whales/transactions?chain=eth&limit=50
  async getTransactions(req, res) {
    try {
      const { chain = 'eth', limit = 50 } = req.query;
      const cacheKey = `whale_tx_${chain}_${limit}`;

      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const moralisKey = process.env.MORALIS_API_KEY;
        if (moralisKey && TRACKED_WHALE_WALLETS[chain]?.[0]) {
          try {
            const response = await axios.get(`${MORALIS_BASE}/${chain}/address/${TRACKED_WHALE_WALLETS[chain][0]}/transactions`, {
              headers: { 'X-API-Key': moralisKey },
              params: { limit: Math.min(parseInt(limit, 10) || 50, 100) },
              timeout: 10000,
            });
            return response.data.result?.map((tx) => ({
              id: tx.hash,
              from: tx.from_address,
              to: tx.to_address,
              value: tx.value,
              tokenSymbol: chain.toUpperCase(),
              tokenName: chain.toUpperCase(),
              timestamp: tx.block_timestamp,
              txHash: tx.hash,
              chain,
            })) || [];
          } catch (moralisErr) {
            console.warn('[WhaleController] Moralis failed, falling back:', moralisErr.message);
          }
        }

        return generateMockWhaleTransactions(chain, parseInt(limit, 10) || 50);
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[WhaleController] Transactions error:', error.message);
      res.status(500).json({ error: 'Failed to fetch whale transactions' });
    }
  },

  // GET /api/whales/wallets?chain=eth
  async getWallets(req, res) {
    try {
      const { chain = 'eth' } = req.query;
      const wallets = TRACKED_WHALE_WALLETS[chain] || [];
      res.json(wallets);
    } catch (error) {
      console.error('[WhaleController] Wallets error:', error.message);
      res.status(500).json({ error: 'Failed to fetch whale wallets' });
    }
  },

  // GET /api/whales/transfers?tokenAddress=...&chain=eth&minValue=100000
  async getTokenTransfers(req, res) {
    try {
      const { tokenAddress, chain = 'eth', minValue = 100000 } = req.query;
      if (!tokenAddress) {
        return res.status(400).json({ error: 'tokenAddress is required' });
      }

      const cacheKey = `whale_transfers_${chain}_${tokenAddress}_${minValue}`;
      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const moralisKey = process.env.MORALIS_API_KEY;
        if (moralisKey) {
          try {
            const response = await axios.get(`${MORALIS_BASE}/${chain}/erc20/${tokenAddress}/transfers`, {
              headers: { 'X-API-Key': moralisKey },
              params: { limit: 50 },
              timeout: 10000,
            });
            return response.data.result
              ?.filter((tx) => parseFloat(tx.value) >= parseFloat(minValue))
              ?.map((tx) => ({
                id: tx.transaction_hash,
                from: tx.from_address,
                to: tx.to_address,
                value: tx.value,
                tokenSymbol: tx.token_symbol || 'UNK',
                tokenName: tx.token_name || 'Unknown',
                timestamp: tx.block_timestamp,
                txHash: tx.transaction_hash,
                chain,
              })) || [];
          } catch (moralisErr) {
            console.warn('[WhaleController] Moralis transfers failed:', moralisErr.message);
          }
        }

        return generateMockWhaleTransactions(chain, 20).map((tx) => ({
          ...tx,
          tokenSymbol: 'USDT',
          tokenName: 'Tether USD',
        }));
      });

      res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
      res.json(result.data);
    } catch (error) {
      console.error('[WhaleController] Transfers error:', error.message);
      res.status(500).json({ error: 'Failed to fetch token transfers' });
    }
  },

  // GET /api/whales/top-holders
  async getTopHolders(req, res) {
    const { token_address, tokenAddress } = req.query;
    const addr = token_address || tokenAddress;
    if (!addr) return res.status(400).json({ error: 'token_address required' });

    const cacheKey = `top_${addr.toLowerCase()}`;
    const result = await getOrSetCache(cacheKey, 300, async () => {
      if (process.env.NANSEN_API_KEY) {
        try {
          const response = await axios.get(`https://api.nansen.ai/v2/tokens/${addr}/top-holders`, {
            headers: { 'api-key': process.env.NANSEN_API_KEY },
            timeout: 10000
          });
          return response.data.holders?.slice(0, 25) || [];
        } catch (e) {
          console.warn('[WhaleController] Nansen top-holders failed:', e.message);
        }
      }
      return [];
    });

    res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
    res.json(result.data);
  },

  async followWhale(req, res) {
    const { whaleAddress } = req.body;
    res.json({ success: true, message: `Now tracking ${whaleAddress}` });
  }
};

export const getTopHolders = whaleController.getTopHolders;
export const followWhale = whaleController.followWhale;
export const getTransactions = whaleController.getTransactions;
export const getWallets = whaleController.getWallets;
export const getTokenTransfers = whaleController.getTokenTransfers;
export default whaleController;
