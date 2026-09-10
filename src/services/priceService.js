// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Price Resolution Service
// Single source of truth for USD pricing:
//   • CEX assets    → CoinGecko /simple/price (curated symbol map + stablecoin pegs)
//   • EVM ERC-20s   → CoinGecko /simple/token_price/{platform}, DexScreener fallback
//   • Native assets → CoinGecko /simple/price
// All results cached 60s in memory. Swap the cache for Redis later without
// touching callers.

import axios from 'axios';
import crypto from 'crypto';
import NodeCache from 'node-cache';
import { config } from '../config/env.js';

const priceCache = new NodeCache({ stdTTL: 60, checkperiod: 120, useClones: false });

const CG_BASE = 'https://api.coingecko.com/api/v3';
const DEX_BASE = 'https://api.dexscreener.com/latest/dex';
const REQUEST_HEADERS = { 'User-Agent': 'AlphaBAG-Terminal/3.0' };

const cgHeaders = () => (config.coingeckoApiKey ? { 'x-cg-pro-api-key': config.coingeckoApiKey } : {});

// chain key (as used in portfolioController CHAIN_KEYS) → CoinGecko platform id
export const CHAIN_TO_CG_PLATFORM = {
    ethereum: 'ethereum',
    bsc: 'binance-smart-chain',
    polygon: 'polygon-pos',
    base: 'base',
    arbitrum: 'arbitrum-one',
    avalanche: 'avalanche',
};

// Stablecoins & fiat-pegged assets — no API call needed
export const STABLE_PEGS = {
    USDT: 1, USDC: 1, BUSD: 1, DAI: 1, TUSD: 1, FDUSD: 1, USDP: 1, PYUSD: 1,
    USDD: 1, USDJ: 1, GUSD: 1, EURC: 1.08, EURT: 1.08, XUSD: 1, AUSD: 1,
};

// Curated symbol → CoinGecko id map. Extend as your user base demands;
// unknown symbols resolve to 0 and are logged (see getSymbolPrices).
export const SYMBOL_TO_GECKO_ID = {
    BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple',
    ADA: 'cardano', AVAX: 'avalanche-2', DOGE: 'dogecoin', DOT: 'polkadot',
    MATIC: 'matic-network', POL: 'matic-network', LINK: 'chainlink', TRX: 'tron',
    UNI: 'uniswap', ATOM: 'cosmos', LTC: 'litecoin', NEAR: 'near', APT: 'aptos',
    ARB: 'arbitrum', OP: 'optimism', INJ: 'injective-protocol', SUI: 'sui',
    SEI: 'sei', TIA: 'celestia', WIF: 'dogwifcoin', PEPE: 'pepe', SHIB: 'shiba-inu',
    FLOKI: 'floki', BONK: 'bonk', JUP: 'jupiter-exchange-solana', PYTH: 'pyth-network',
    ORDI: 'ordinals', STX: 'blockstack', IMX: 'immutable-x', FIL: 'filecoin',
    RENDER: 'render-token', FET: 'fetch-ai', GRT: 'the-graph', AAVE: 'aave',
    MKR: 'maker', CRO: 'crypto-com-chain', HBAR: 'hedera-hashgraph', XLM: 'stellar',
    ALGO: 'algorand', VET: 'vechain', ICP: 'internet-computer', MANA: 'decentraland',
    SAND: 'the-sandbox', AXS: 'axie-infinity', LDO: 'lido-dao', ENA: 'ethena',
    ONDO: 'ondo-finance', WLD: 'worldcoin-wld', TON: 'the-open-network', KAS: 'kaspa',
    WETH: 'ethereum', WBTC: 'wrapped-bitcoin', WBETH: 'ethereum', WEETH: 'ethereum',
    STETH: 'lido-staked-ether', WSTETH: 'wrapped-steth', CBBTC: 'coinbase-wrapped-btc',
};

const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

/**
 * Resolve CEX-style symbols (BTC, ETH, …) to USD prices.
 * @returns {Promise<Object<string, {usd:number, usd_24h_change:number}>>}
 */
export async function getSymbolPrices(symbols = []) {
    const unique = [...new Set(symbols.map((s) => String(s).toUpperCase()).filter(Boolean))];
    const result = {};

    for (const symbol of unique) {
        if (STABLE_PEGS[symbol] !== undefined) {
            result[symbol] = { usd: STABLE_PEGS[symbol], usd_24h_change: 0 };
        }
    }

    const known = unique.filter((s) => !(s in result) && SYMBOL_TO_GECKO_ID[s]);
    for (const batch of chunk(known, 100)) {
        const ids = batch.map((s) => SYMBOL_TO_GECKO_ID[s]);
        try {
            const { data } = await axios.get(`${CG_BASE}/simple/price`, {
                params: { ids: ids.join(','), vs_currencies: 'usd', include_24hr_change: 'true' },
                timeout: 8000,
                headers: cgHeaders(),
            });
            for (const symbol of batch) {
                const entry = data[SYMBOL_TO_GECKO_ID[symbol]];
                if (entry) {
                    result[symbol] = { usd: entry.usd ?? 0, usd_24h_change: entry.usd_24h_change ?? 0 };
                }
            }
        } catch (error) {
            console.warn(`[PriceService] CoinGecko simple/price failed: ${error.message}`);
        }
    }

    const unresolved = unique.filter((s) => !(s in result));
    if (unresolved.length) {
        console.warn(`[PriceService] No price source for symbols: ${unresolved.join(', ')} (extend SYMBOL_TO_GECKO_ID)`);
    }
    return result;
}

/**
 * Resolve EVM contract addresses to USD prices for a given chain.
 * CoinGecko first, DexScreener (highest-liquidity pair) as fallback.
 * @returns {Promise<Object<string, {usd:number, usd_24h_change:number}>>} keyed by lowercase address
 */
export async function getEvmTokenPrices(chain, addresses = []) {
    const normalized = [
        ...new Set(addresses.map((a) => String(a).toLowerCase()).filter((a) => /^0x[a-f0-9]{40}$/.test(a))),
    ];
    if (!normalized.length) return {};

    const cacheKey = `evmtok_${chain}_${crypto.createHash('md5').update(normalized.sort().join(',')).digest('hex')}`;
    const hit = priceCache.get(cacheKey);
    if (hit) return hit;

    const prices = {};
    const platform = CHAIN_TO_CG_PLATFORM[chain];

    if (platform) {
        try {
            for (const batch of chunk(normalized, 80)) {
                const { data } = await axios.get(`${CG_BASE}/simple/token_price/${platform}`, {
                    params: { contract_addresses: batch.join(','), vs_currencies: 'usd', include_24hr_change: 'true' },
                    timeout: 8000,
                    headers: cgHeaders(),
                });
                for (const [addr, p] of Object.entries(data)) {
                    prices[addr.toLowerCase()] = { usd: p.usd ?? 0, usd_24h_change: p.usd_24h_change ?? 0 };
                }
            }
        } catch (error) {
            console.warn(`[PriceService] CoinGecko token_price failed for ${chain}: ${error.message}`);
        }
    }

    const unresolved = normalized.filter((a) => !(a in prices));
    for (const batch of chunk(unresolved, 30)) {
        try {
            const { data } = await axios.get(`${DEX_BASE}/tokens/${batch.join(',')}`, {
                timeout: 10000,
                headers: REQUEST_HEADERS,
            });
            for (const addr of batch) {
                const pairs = (data.pairs || []).filter(
                    (p) => p.baseToken?.address?.toLowerCase() === addr && parseFloat(p.priceUsd) > 0
                );
                if (!pairs.length) continue;
                const best = pairs.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
                prices[addr] = {
                    usd: parseFloat(best.priceUsd),
                    usd_24h_change: parseFloat(best.priceChange?.h24 ?? 0),
                };
            }
        } catch (error) {
            console.warn(`[PriceService] DexScreener fallback failed: ${error.message}`);
        }
    }

    priceCache.set(cacheKey, prices, 60);
    return prices;
}

/**
 * Native asset prices (ETH, BNB, MATIC, AVAX, SOL) — 60s cached.
 * @returns {Promise<Object<string, {usd:number, usd_24h_change:number}>>} keyed by CoinGecko id
 */
export async function getNativePrices() {
    const cacheKey = 'native_prices_v1';
    const hit = priceCache.get(cacheKey);
    if (hit) return hit;

    let prices = {};
    try {
        const { data } = await axios.get(`${CG_BASE}/simple/price`, {
            params: {
                ids: 'ethereum,binancecoin,matic-network,avalanche-2,solana',
                vs_currencies: 'usd',
                include_24hr_change: 'true',
            },
            timeout: 8000,
            headers: cgHeaders(),
        });
        prices = data || {};
    } catch (error) {
        console.warn(`[PriceService] Native price fetch failed: ${error.message}`);
    }

    priceCache.set(cacheKey, prices, 60);
    return prices;
}

// Exposed for unit tests
export const __testables = { STABLE_PEGS, SYMBOL_TO_GECKO_ID, chunk };
