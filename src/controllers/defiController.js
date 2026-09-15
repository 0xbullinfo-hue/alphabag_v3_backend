// SPDX-License-Identifier: MIT
// AlphaBAG V3 — DeFi Controller (Hardened)
// GET /api/portfolio/defi — Real wallet positions (authenticated)
// GET /api/defi/opportunities — Market yield opportunities (public/authenticated)

import axios from 'axios';
import crypto from 'crypto';
import { getOrSetCache } from '../utils/cache.js';

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2';
const CHAIN_HEX = {
  ethereum: '0x1',
  eth: '0x1',
  bsc: '0x38',
  polygon: '0x89',
  arbitrum: '0xa4b1',
  base: '0x2105',
  avalanche: '0xa86a',
};

const CANONICAL_CHAINS = ['ethereum', 'base', 'arbitrum', 'polygon', 'bsc', 'avalanche'];

export function generateDeterministicPositionId(chain, address, protocol = '', type = '', protocolAddress = '', label = '') {
  const stableKey = [
    chain,
    (address || '').toLowerCase(),
    protocol || '',
    type || '',
    protocolAddress || '',
    label || '',
  ].join(':');
  return `${chain}:${crypto.createHash('sha256').update(stableKey).digest('hex').slice(0, 24)}`;
}

function normalizePosition(raw, chain, address) {
  const stableId = generateDeterministicPositionId(
    chain,
    address,
    raw.protocol_id || raw.protocol || raw.project || '',
    raw.position_type || raw.type || '',
    raw.protocol_address || raw.address || raw.token_address || '',
    raw.label || raw.name || ''
  );

  const supplied = raw.supplied_usd != null ? Number(raw.supplied_usd) : (raw.balance_usd != null ? Number(raw.balance_usd) : (raw.value_usd != null ? Number(raw.value_usd) : null));
  const debt = raw.debt_usd != null ? Number(raw.debt_usd) : (raw.borrowed_usd != null ? Number(raw.borrowed_usd) : 0);
  const net = supplied != null ? supplied - debt : null;
  const valuationStatus = supplied != null ? 'VALUED' : 'UNAVAILABLE';

  return {
    id: stableId,
    walletAddress: address.toLowerCase(),
    chain,
    protocol: raw.protocol_name || raw.protocol || raw.project || 'Unknown',
    protocolAddress: raw.protocol_address || raw.address || null,
    positionType: raw.position_type || raw.type || 'UNKNOWN',
    suppliedUsd: supplied,
    debtUsd: debt,
    netUsd: net,
    valuationStatus,
    apy: raw.apy == null ? null : Number(raw.apy),
    rewardsUsd: raw.rewards_usd == null ? null : Number(raw.rewards_usd),
    healthFactor: raw.health_factor == null ? null : Number(raw.health_factor),
    liquidationPrice: raw.liquidation_price == null ? null : Number(raw.liquidation_price),
    source: 'moralis',
    sourceUpdatedAt: new Date().toISOString(),
  };
}

export const getDefiPositions = async (req, res) => {
  try {
    const rawAddress = req.query.address || req.user?.verifiedWallet || req.user?.wallet || req.user?.address;
    if (!rawAddress) {
      return res.status(400).json({ error: 'wallet address required' });
    }

    const address = String(rawAddress).trim().toLowerCase();
    const { chains } = req.query;
    const requestedChains = typeof chains === 'string'
      ? chains.split(',').map(s => s.trim().toLowerCase()).filter(c => CANONICAL_CHAINS.includes(c) || CHAIN_HEX[c])
      : ['ethereum', 'base', 'arbitrum', 'polygon', 'bsc'];

    const moralisKey = process.env.MORALIS_API_KEY;
    if (!moralisKey) {
      return res.status(200).json({
        success: false,
        complete: false,
        status: 'UNCONFIGURED',
        message: 'DeFi provider not configured (MORALIS_API_KEY missing)',
        positions: [],
        chainStatus: requestedChains.map(chain => ({ chain, status: 'UNCONFIGURED', error: 'PROVIDER_UNCONFIGURED' })),
        updatedAt: new Date().toISOString(),
      });
    }

    const responses = await Promise.allSettled(
      requestedChains.map(async chain => {
        const hex = CHAIN_HEX[chain] || CHAIN_HEX.ethereum;
        const { data } = await axios.get(`${MORALIS_BASE}/${address}/defi/positions`, {
          headers: { 'X-API-Key': moralisKey },
          params: { chain: hex },
          timeout: 10000,
        });
        const rows = data.result || data.positions || data || [];
        return Array.isArray(rows) ? rows.map(p => normalizePosition(p, chain, address)) : [];
      })
    );

    const positions = responses.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const chainStatus = requestedChains.map((chain, index) => {
      const r = responses[index];
      if (r.status === 'fulfilled') {
        return { chain, status: 'OK', count: r.value.length };
      }
      const httpStatus = r.reason?.response?.status;
      const error = httpStatus === 429 ? 'RATE_LIMITED' : (httpStatus === 401 || httpStatus === 403 ? 'AUTH_FAILED' : 'PROVIDER_ERROR');
      return { chain, status: 'ERROR', error };
    });

    const complete = chainStatus.every(s => s.status === 'OK');

    return res.json({
      success: true,
      source: 'moralis',
      positions,
      complete,
      chainStatus,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[DeFi] Controller failure:', error.message);
    return res.status(500).json({ error: 'Failed to fetch DeFi data' });
  }
};

export const getDefiOpportunities = async (req, res) => {
  try {
    const cacheKey = 'defi_llama_opportunities';
    const result = await getOrSetCache(cacheKey, 300, async () => {
      const response = await axios.get('https://yields.llama.fi/pools', { timeout: 10000 });
      const pools = Array.isArray(response.data?.data) ? response.data.data : [];
      return pools
        .filter(p => (p.tvlUsd || 0) > 10_000_000)
        .slice(0, 50)
        .map(p => ({
          pool: p.pool,
          project: p.project,
          chain: p.chain,
          symbol: p.symbol,
          tvlUsd: p.tvlUsd,
          apy: p.apy,
          apyBase: p.apyBase,
          apyReward: p.apyReward,
        }));
    });
    res.json({
      success: true,
      source: 'defillama',
      opportunities: result.data || [],
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch DeFi opportunities' });
  }
};
