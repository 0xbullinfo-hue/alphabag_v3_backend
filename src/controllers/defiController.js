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
    const { address, chain = 'eth' } = req.query;

    if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: 'address query parameter is required' });
    }

    // 1) Real positions via Moralis (requires key)
    const moralisKey = process.env.MORALIS_API_KEY;
    if (moralisKey) {
        try {
            const { data } = await axios.get(`${MORALIS_BASE}/${address}/defi/positions`, {
                headers: { 'X-API-Key': moralisKey },
                params: { chain: CHAIN_HEX[chain] || '0x1' },
                timeout: 15000,
            });
            return res.json({
                success: true,
                source: 'moralis',
                positions: data.result || data.positions || data || [],
            });
        } catch (error) {
            console.warn(`[DeFi] Moralis positions failed: ${error.message} — falling back to opportunities`);
        }
    }

    // 2) Fallback: top yield opportunities (DeFiLlama) — keeps the page useful without a key
    try {
        const result = await getOrSetCache('defi_opportunities_v1', 300, async () => {
            const { data } = await axios.get('https://yields.llama.fi/pools', { timeout: 20000 });
            return (data.data || [])
                .filter((p) => p.tvlUsd > 10_000_000 && p.apy != null)
                .sort((a, b) => b.tvlUsd - a.tvlUsd)
                .slice(0, 50)
                .map((p) => ({
                    protocol: p.project,
                    chain: p.chain,
                    symbol: p.symbol,
                    apy: p.apy,
                    tvlUsd: p.tvlUsd,
                    poolId: p.pool,
                }));
        });

        res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        return res.json({ success: true, source: 'defillama-opportunities', positions: result.data });
    } catch (error) {
        console.error('[DeFi] DeFiLlama fallback failed:', error.message);
        return res.status(502).json({ error: 'DeFi data unavailable' });
    }
};
