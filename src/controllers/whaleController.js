// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Whale Controller (fixed)
// Fixes vs. previous version:
//   1. followWhale now PERSISTS to the `whale_follows` table (was a no-op stub
//      returning success without saving, which starved the alert cron).
//   2. New: GET /api/whales/follows and DELETE /api/whales/follow/:id.

import axios from 'axios';
import crypto from 'crypto';
import { getOrSetCache } from '../utils/cache.js';
import { store } from '../services/storeService.js';

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2';
const CACHE_TTL = 60;
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SUPPORTED_EVM_CHAIN_IDS = new Set([1, 56, 137, 42161, 43114, 8453]);

const TRACKED_WHALE_WALLETS = {
  eth: [
    '0x28C6c06298d514Db089934071355E5743bf21d60',
    '0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8',
  ],
  bsc: [
    '0x8894e0a0c962cb723c1976a4421c95949be2d4e3',
    '0xF977814e90dA44bFA03b6295A0616a897441aceC',
  ],
  sol: [
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  ],
};

const isValidAddress = (address) =>
    EVM_ADDRESS_PATTERN.test(address) || SOLANA_ADDRESS_PATTERN.test(address);

export const whaleController = {
  async getAddressTransactions(req, res) {
    const { address } = req.params;
    const chainId = Number(req.query.chainId || 56);

    if (!EVM_ADDRESS_PATTERN.test(address) || !SUPPORTED_EVM_CHAIN_IDS.has(chainId)) {
      return res.status(400).json({ error: 'A valid EVM address and supported chainId are required' });
    }

    if (!process.env.MORALIS_API_KEY) {
      return res.status(503).json({ error: 'Whale transaction data is not configured' });
    }

    try {
      const chainHex = `0x${chainId.toString(16)}`;
      const response = await axios.get(`${MORALIS_BASE}/${address}/erc20/transfers`, {
        headers: { 'X-API-Key': process.env.MORALIS_API_KEY },
        params: { chain: chainHex, order: 'DESC', limit: 20 },
        timeout: 10000,
      });
      res.json((response.data.result || []).map((tx) => ({
        hash: tx.transaction_hash,
        from: tx.from_address,
        to: tx.to_address,
        value: (Number(tx.value) / Math.pow(10, Number(tx.token_decimals))).toFixed(4),
        timeStamp: String(new Date(tx.block_timestamp).getTime() / 1000),
        tokenSymbol: tx.token_symbol,
        tokenDecimal: tx.token_decimals,
      })));
    } catch (error) {
      console.error('[WhaleController] Address transactions error:', error.message);
      res.status(502).json({ error: 'Unable to retrieve whale transaction data' });
    }
  },

  // GET /api/whales/transactions?chain=eth&limit=50
  async getTransactions(req, res) {
    try {
      const { chain = 'eth', limit = 50 } = req.query;
      const cacheKey = `whale_tx_${chain}_${limit}`;

      const result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
        const moralisKey = process.env.MORALIS_API_KEY;
        if (moralisKey && TRACKED_WHALE_WALLETS[chain]?.[0]) {
          try {
            const response = await axios.get(`${MORALIS_BASE}/${TRACKED_WHALE_WALLETS[chain][0]}/transactions`, {
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

        return [];
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
            const response = await axios.get(`${MORALIS_BASE}/erc20/${tokenAddress}/transfers`, {
              headers: { 'X-API-Key': moralisKey },
              params: { chain: chain === 'bsc' ? '0x38' : '0x1', limit: 50 },
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

        return [];
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

  // POST /api/whales/follow  { whaleAddress, chain, label, threshold }
  // PERSISTS the follow so check_followed_whales.js can actually alert on it.
  async followWhale(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { whaleAddress, chain = 'eth', label, threshold = 0 } = req.body || {};
      if (!isValidAddress(whaleAddress || '')) {
        return res.status(400).json({ error: 'A valid EVM or Solana whaleAddress is required' });
      }

      const existing = await store.findOne('whale_follows', { userId, address: whaleAddress });
      if (existing) {
        return res.status(200).json({ success: true, follow: existing, message: 'Already tracking this wallet' });
      }

      const follow = await store.create('whale_follows', {
        id: 'wf_' + crypto.randomUUID(),
        userId,
        address: whaleAddress,
        chain,
        label: label || null,
        threshold: Number(threshold) || 0,
        isActive: true,
        lastSeenTx: null,
      });

      res.status(201).json({ success: true, follow });
    } catch (error) {
      console.error('[WhaleController] Follow error:', error.message);
      res.status(500).json({ error: 'Failed to save whale follow' });
    }
  },

  // DELETE /api/whales/follow/:id
  async unfollowWhale(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const follows = await store.read('whale_follows');
      const follow = (follows || []).find((f) => f.id === req.params.id && f.userId === userId);
      if (!follow) return res.status(404).json({ error: 'Follow not found' });

      await store.write('whale_follows', follows.filter((f) => f.id !== follow.id));
      res.status(204).end();
    } catch (error) {
      console.error('[WhaleController] Unfollow error:', error.message);
      res.status(500).json({ error: 'Failed to remove whale follow' });
    }
  },

  // GET /api/whales/follows — the current user's tracked whales
  async getFollows(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const follows = (await store.read('whale_follows')).filter((f) => f.userId === userId);
      res.json({ success: true, follows });
    } catch (error) {
      console.error('[WhaleController] Follows error:', error.message);
      res.status(500).json({ error: 'Failed to fetch follows' });
    }
  },
};

export const getTopHolders = whaleController.getTopHolders;
export const getAddressTransactions = whaleController.getAddressTransactions;
export const followWhale = whaleController.followWhale;
export const unfollowWhale = whaleController.unfollowWhale;
export const getFollows = whaleController.getFollows;
export const getTransactions = whaleController.getTransactions;
export const getWallets = whaleController.getWallets;
export const getTokenTransfers = whaleController.getTokenTransfers;
export default whaleController;
