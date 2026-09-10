// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Followed-Whale Movement Cron (fixed)
// Replaces the demo mock (random 5% "hits") with real on-chain checks via
// Moralis. Alerts fire through telegramService.formatWhaleAlert.

import axios from 'axios';
import cron from 'node-cron';
import { store } from '../src/services/storeService.js';
import { sendTelegramMessage, formatWhaleAlert } from '../src/services/telegramService.js';

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2';
const MORALIS_KEY = process.env.MORALIS_API_KEY;
// Map our `chain` labels to Moralis chain hex + native decimals
const CHAIN_CONFIG = {
    eth: { hex: '0x1', decimals: 18 },
    bsc: { hex: '0x38', decimals: 18 },
    polygon: { hex: '0x89', decimals: 18 },
    arbitrum: { hex: '0xa4b1', decimals: 18 },
    base: { hex: '0x2105', decimals: 18 },
    avalanche: { hex: '0xa86a', decimals: 18 },
    sol: { hex: 'mainnet', decimals: 9 },
};

// Runs every 5 minutes
cron.schedule('*/5 * * * *', async () => {
    console.log('--- [CRON] Scanning Whale Movement Nodes ---');

    if (!MORALIS_KEY) {
        console.warn('--- [CRON] MORALIS_API_KEY not set — whale scan skipped ---');
        return;
    }

    try {
        const follows = await store.read('whale_follows');
        if (!follows || follows.length === 0) {
            console.log('--- [CRON] No whales to watch. ---');
            return;
        }

        for (const follow of follows) {
            if (follow.isActive === false) continue;

            try {
                const cfg = CHAIN_CONFIG[follow.chain] || CHAIN_CONFIG.eth;

                // Latest inbound + outbound native transfers
                const { data } = await axios.get(`${MORALIS_BASE}/${follow.address}`, {
                    headers: { 'X-API-Key': MORALIS_KEY },
                    params: { chain: cfg.hex, limit: 5, order: 'DESC' },
                    timeout: 10000,
                });

                const txs = data.result || [];
                for (const tx of txs) {
                    // Skip already-seen transactions
                    if (follow.lastSeenTx && tx.hash === follow.lastSeenTx) break;
                    if (follow.lastSeenTx && tx.block_number <= (follow.lastSeenBlock || 0)) break;

                    const valueNative = Number(tx.value) / Math.pow(10, cfg.decimals);
                    if (valueNative <= 0) continue;

                    // Price the native amount coarsely for the threshold check
                    // (cached USD map kept simple: threshold is checked in native units
                    //  when follow.threshold <= 0, else approximated via CoinGecko native price)
                    const nativeSymbol = { '0x1': 'ETH', '0x38': 'BNB', '0x89': 'MATIC', '0xa4b1': 'ETH', '0x2105': 'ETH', '0xa86a': 'AVAX', mainnet: 'SOL' }[cfg.hex];
                    const usdValue = await approximateUsd(nativeSymbol, valueNative);

                    if (usdValue >= (follow.threshold || 0)) {
                        console.log(`[CRON] Whale alert: ${follow.label || follow.address} moved ${valueNative} ${nativeSymbol} (~$${usdValue})`);
                        const msg = formatWhaleAlert(follow, {
                            symbol: nativeSymbol,
                            value: valueNative.toFixed(4),
                            usd_value: usdValue.toFixed(2),
                            to_address: tx.to_address,
                            hash: tx.hash,
                        });
                        await sendTelegramMessage(msg);
                    }
                }

                // Mark newest tx as seen so the next run only processes new ones
                if (txs.length > 0) {
                    await store.updateById('whale_follows', follow.id, () => ({
                        lastSeenTx: txs[0].hash,
                        lastSeenBlock: txs[0].block_number,
                    }));
                }
            } catch (err) {
                console.error(`[CRON] Error checking whale ${follow.address}:`, err.message);
            }
        }
    } catch (error) {
        console.error('[CRON] Whale Scan Failure:', error.message);
    }
});

/** Very small native-price helper (60s memory cache, CoinGecko free tier). */
const _priceCache = new Map();
async function approximateUsd(symbol, amount) {
    if (!symbol || amount <= 0) return 0;
    const now = Date.now();
    if (!_priceCache.has(symbol) || now - _priceCache.get(symbol).ts > 60_000) {
        const idMap = { ETH: 'ethereum', BNB: 'binancecoin', MATIC: 'matic-network', AVAX: 'avalanche-2', SOL: 'solana' };
        try {
            const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: { ids: idMap[symbol] || 'ethereum', vs_currencies: 'usd' },
                timeout: 8000,
            });
            _priceCache.set(symbol, { usd: data[idMap[symbol]]?.usd ?? 0, ts: now });
        } catch {
            _priceCache.set(symbol, { usd: _priceCache.get(symbol)?.usd ?? 0, ts: now });
        }
    }
    return amount * _priceCache.get(symbol).usd;
}
