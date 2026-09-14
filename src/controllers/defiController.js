
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

const CANONICAL_CHAINS = Object.keys(CHAIN_HEX);

function normalizePosition(raw, chain, address) {
  return {
    id: `${chain}:${raw.protocol_id || raw.protocol || raw.address || raw.token_address || Math.random()}`,
    walletAddress: address.toLowerCase(),
    chain,
    protocol: raw.protocol_name || raw.protocol || raw.project || 'Unknown',
    protocolAddress: raw.protocol_address || raw.address || null,
    positionType: raw.position_type || raw.type || 'UNKNOWN',
    suppliedUsd: Number(raw.supplied_usd ?? raw.balance_usd ?? raw.value_usd ?? 0),
    debtUsd: Number(raw.debt_usd ?? raw.borrowed_usd ?? 0),
    netUsd: Number(raw.net_usd ?? ((raw.supplied_usd ?? raw.balance_usd ?? 0) - (raw.debt_usd ?? raw.borrowed_usd ?? 0))),
    apy: raw.apy == null ? null : Number(raw.apy),
    rewardsUsd: raw.rewards_usd == null ? null : Number(raw.rewards_usd),
    healthFactor: raw.health_factor == null ? null : Number(raw.health_factor),
    liquidationPrice: raw.liquidation_price == null ? null : Number(raw.liquidation_price),
    source: 'moralis',
    sourceUpdatedAt: new Date().toISOString(),
  };
}
// SPDX-License-Identifier: MIT
// AlphaBAG V3 — DeFi Controller (NEW)
// GET /api/portfolio/defi
//   • With MORALIS_API_KEY: real wallet positions (Nansen/Moralis DeFi endpoint)
//   • Without a key: top yield opportunities from DeFiLlama (TVL > $10M)
// The DeFi page in the frontend previously hit a route that didn't exist.

import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2';
const CHAIN_HEX = { eth: '0x1', bsc: '0x38', polygon: '0x89', arbitrum: '0xa4b1', base: '0x2105', avalanche: '0xa86a' };

export const getDefiPositions = async (req, res) => {
    const { address, chains } = req.query;
    if (!address) return res.status(400).json({ error: 'wallet address required' });

    const requestedChains = typeof chains === 'string'
      ? chains.split(',').map(s => s.trim()).filter(c => CANONICAL_CHAINS.includes(c))
      : CANONICAL_CHAINS;

    const moralisKey = process.env.MORALIS_API_KEY;
    if (moralisKey) {
        try {
            const responses = await Promise.allSettled(
              requestedChains.map(async chain => {
                const { data } = await axios.get(`${MORALIS_BASE}/${address}/defi/positions`, {
                  headers: { 'X-API-Key': moralisKey },
                  params: { chain: CHAIN_HEX[chain] },
                  timeout: 15000,
                });
                const rows = data.result || data.positions || data || [];
                return Array.isArray(rows) ? rows.map(p => normalizePosition(p, chain, address)) : [];
              })
            );
            const positions = responses.flatMap(r => r.status === 'fulfilled' ? r.value : []);
            return res.json({
                success: true,
                source: 'moralis',
                positions,
                updatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.warn(`[DeFi] Moralis positions failed: ${error.message} - falling back to opportunities`);
        }
    }

    try {
        const result = await fetchDefiOpportunities();
        return res.json({
          success: true,
          source: 'defillama-opportunities',
          positions: [],
          opportunities: result?.data || [],
          updatedAt: new Date().toISOString(),
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch DeFi data' });
    }
};
