// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Proxy Controller (Hardened against query pollution & key injection)

import axios from 'axios';
import { getOrSetCache } from '../utils/cache.js';

const ALLOWED_MODULES = new Set(['account', 'stats', 'block', 'transaction', 'token', 'contract', 'logs']);

export const proxyBlockExplorer = async (req, res) => {
    try {
        const { explorer } = req.params;

        let baseUrl = '';
        let apiKey = '';

        if (explorer === 'etherscan') {
            baseUrl = 'https://api.etherscan.io/api';
            apiKey = process.env.ETHERSCAN_API_KEY;
        } else if (explorer === 'bscscan') {
            baseUrl = 'https://api.bscscan.com/api';
            apiKey = process.env.BSCSCAN_API_KEY;
        } else {
            return res.status(400).json({ error: 'Unsupported explorer' });
        }

        if (!apiKey) {
            console.warn(`[ProxyController] Missing API key for ${explorer}`);
            return res.status(500).json({ error: `Server missing API key for ${explorer}` });
        }

        // Sanitize incoming query parameters: strip any attempts to override API key
        const safeQuery = {};
        for (const [key, value] of Object.entries(req.query)) {
            const lower = key.toLowerCase();
            if (lower === 'apikey' || lower === 'api_key' || lower === 'key') continue;
            safeQuery[key] = String(value);
        }

        // Validate module if provided
        if (safeQuery.module && !ALLOWED_MODULES.has(safeQuery.module.toLowerCase())) {
            return res.status(400).json({ error: `Module '${safeQuery.module}' not permitted via proxy` });
        }

        const queryParams = new URLSearchParams(safeQuery).toString();
        const url = `${baseUrl}?${queryParams}&apikey=${apiKey}`;
        const cacheKey = `explorer_proxy_${explorer}_${queryParams}`;

        // 30s cache for explorer queries
        const result = await getOrSetCache(cacheKey, 30, async () => {
            const response = await axios.get(url, { timeout: 10000 });
            return response.data;
        });

        res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.json(result.data);
    } catch (error) {
        console.error('[ProxyController] Proxy error:', error.message);
        res.status(500).json({ error: 'Failed to fetch from external API' });
    }
};
