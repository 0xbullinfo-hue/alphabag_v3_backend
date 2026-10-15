// SPDX-License-Identifier: MIT
import axios from 'axios';
import NodeCache from 'node-cache';

const priceCache = new NodeCache({ stdTTL: 15, checkperiod: 120 });
const searchCache = new NodeCache({ stdTTL: 60, checkperiod: 120 }); // Cache searches for 1 minute
const marketDataCache = new NodeCache({ stdTTL: 30, checkperiod: 120 });

export const getPrices = async (req, res) => {
    const { ids } = req.query;
    if (!ids || typeof ids !== 'string' || ids.length > 500) {
        return res.status(400).json({ error: 'Valid coin ids parameter required' });
    }

    const cacheKey = `prices_${ids.toLowerCase().trim()}`;
    if (priceCache.has(cacheKey)) {
        return res.json(priceCache.get(cacheKey));
    }

    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: ids.trim(),
                vs_currencies: 'usd',
                include_24hr_change: 'true'
            },
            timeout: 10000,
            headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {}
        });

        priceCache.set(cacheKey, response.data);
        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({ error: 'Market data sync failed' });
    }
};

export const searchCoins = async (req, res) => {
    const { query } = req.query;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.json([]);
    }

    const sanitized = query.trim().slice(0, 50);
    const cacheKey = `search_${sanitized.toLowerCase()}`;
    if (searchCache.has(cacheKey)) {
        return res.json(searchCache.get(cacheKey));
    }

    try {
        const response = await axios.get(`https://api.coingecko.com/api/v3/search`, {
            params: { query: sanitized },
            timeout: 10000,
            headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {}
        });
        const results = (response.data?.coins || []).slice(0, 8);
        searchCache.set(cacheKey, results);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Search failed' });
    }
};

export const getCoinsMarkets = async (req, res) => {
    const { vs_currency = 'usd', order = 'market_cap_desc', per_page = '100', page = '1', sparkline = 'false', price_change_percentage, ids } = req.query;
    
    // Bounds check pagination to prevent DoS
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safePerPage = Math.min(Math.max(1, parseInt(per_page, 10) || 100), 250);
    const safeCurrency = typeof vs_currency === 'string' ? vs_currency.slice(0, 10).toLowerCase() : 'usd';

    const cacheKey = `markets_${safeCurrency}_${order}_${safePerPage}_${safePage}_${sparkline}_${price_change_percentage}_${ids || 'all'}`;

    if (marketDataCache.has(cacheKey)) {
        return res.json(marketDataCache.get(cacheKey));
    }

    try {
        const params = {
            vs_currency: safeCurrency,
            order: typeof order === 'string' ? order.slice(0, 20) : 'market_cap_desc',
            per_page: safePerPage,
            page: safePage,
            sparkline: sparkline === 'true',
        };
        if (price_change_percentage) params.price_change_percentage = price_change_percentage;
        if (ids && typeof ids === 'string') params.ids = ids.slice(0, 500);

        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params,
            timeout: 10000,
            headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {}
        });

        marketDataCache.set(cacheKey, response.data);
        res.json(response.data);
    } catch (error) {
        console.error(`[Market] coins/markets fetch failed: ${error.message}`);
        res.status(error.response?.status || 500).json({ error: 'Failed to fetch coin markets' });
    }
};
