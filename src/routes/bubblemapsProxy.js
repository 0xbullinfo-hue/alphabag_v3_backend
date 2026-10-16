import express from 'express';
import { getOrSetCache } from '../utils/cache.js';

const router = express.Router();

const BUBBLEMAPS_API_BASE = 'https://api.bubblemaps.io/v0';
const BATCH_LIMIT = 50;
const CACHE_TTL_SECONDS = 300; // 5 minutes

export function normalizeChain(chain) {
  const c = String(chain || '').toLowerCase().trim();
  switch (c) {
    case 'ethereum':
    case 'eth':
      return 'eth';
    case 'arbitrum':
    case 'arbi':
    case 'arb':
      return 'arbi';
    case 'binance':
    case 'binancesmartchain':
    case 'bsc':
      return 'bsc';
    case 'sol':
    case 'solana':
      return 'solana';
    case 'polygon':
    case 'matic':
    case 'pol':
      return 'polygon';
    case 'avalanche':
    case 'avax':
      return 'avax';
    case 'base':
      return 'base';
    case 'fantom':
    case 'ftm':
      return 'ftm';
    case 'cronos':
    case 'cro':
      return 'cronos';
    default:
      return null;
  }
}

export function isValidAddress(address, chain = 'eth') {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  if (chain === 'solana') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
  }
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
}

export function validateBubblemapsParams(req, res, next) {
  const { chain, address } = req.params;

  if (chain !== undefined) {
    const normalized = normalizeChain(chain);
    if (!normalized) {
      return res.status(400).json({ error: `Unsupported chain: ${chain}` });
    }
    req.params.chain = normalized;
  }

  if (address !== undefined) {
    const valid = isValidAddress(address, req.params.chain || 'eth');
    if (!valid) {
      return res.status(400).json({ error: `Invalid wallet or token address: ${address}` });
    }
  }

  next();
}

function resolveUpstreamPath(path, params) {
  if (path.startsWith('/map/')) {
    return `/tokens/map/${params.chain}/${params.address}`;
  }
  if (path.startsWith('/screenshot/')) {
    return `/tokens/screenshot/${params.chain}/${params.address}`;
  }
  if (path.startsWith('/holders/')) {
    return `/tokens/holders/${params.chain}/${params.address}`;
  }
  if (path.startsWith('/metadata/')) {
    return `/tokens/metadata/${params.chain}/${params.address}`;
  }
  if (path.startsWith('/metrics/')) {
    return `/tokens/metrics/${params.chain}/${params.address}`;
  }
  return path;
}

export async function handleBubblemapsProxyRequest(req, res) {
  const upstreamPath = resolveUpstreamPath(req.path, req.params);
  const method = req.method.toUpperCase();

  // Validate batch limits
  if (method === 'POST') {
    if (upstreamPath.includes('/tokens/metadata')) {
      if (!Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Request body must be an array of token queries' });
      }
      if (req.body.length > BATCH_LIMIT) {
        return res.status(400).json({ error: `Batch request exceeds limit of ${BATCH_LIMIT} items` });
      }
      for (const item of req.body) {
        if (!item?.address || !item?.chain || !normalizeChain(item.chain)) {
          return res.status(400).json({ error: 'Each token query must have a valid chain and address' });
        }
      }
    } else if (upstreamPath.includes('/addresses/metadata')) {
      const addresses = req.body?.addresses;
      if (!Array.isArray(addresses)) {
        return res.status(400).json({ error: 'Request body must contain an addresses array' });
      }
      if (addresses.length > BATCH_LIMIT) {
        return res.status(400).json({ error: `Batch request exceeds limit of ${BATCH_LIMIT} items` });
      }
      for (const addr of addresses) {
        if (typeof addr !== 'string' || (!isValidAddress(addr, 'eth') && !isValidAddress(addr, 'solana'))) {
          return res.status(400).json({ error: `Invalid address in batch list: ${addr}` });
        }
      }
    } else if (upstreamPath.includes('/relationships/subgraph')) {
      const addresses = req.body?.addresses;
      if (!Array.isArray(addresses)) {
        return res.status(400).json({ error: 'Request body must contain an addresses array' });
      }
      if (addresses.length > BATCH_LIMIT) {
        return res.status(400).json({ error: `Addresses list exceeds limit of ${BATCH_LIMIT} items` });
      }
      for (const addr of addresses) {
        if (typeof addr !== 'string' || (!isValidAddress(addr, 'eth') && !isValidAddress(addr, 'solana'))) {
          return res.status(400).json({ error: `Invalid address in subgraph list: ${addr}` });
        }
      }
    }
  }

  const apiKey = process.env.BUBBLEMAPS_API_KEY;

  const fetchUpstream = async () => {
    const url = new URL(`${BUBBLEMAPS_API_BASE}${upstreamPath}`);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers = {
      Accept: 'application/json',
    };
    if (apiKey) {
      headers['X-ApiKey'] = apiKey;
    }
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const upstreamRes = await fetch(url.toString(), {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(10000),
      });

      const responseData = await upstreamRes.json().catch(() => null);
      return {
        status: upstreamRes.status,
        data: responseData || { error: 'Empty upstream response' },
      };
    } catch (err) {
      console.warn(`[Bubblemaps Proxy] Upstream fetch error for ${upstreamPath}:`, err.message);
      return {
        status: 502,
        data: { error: 'Bubblemaps upstream service unavailable' },
      };
    }
  };

  try {
    if (method === 'GET') {
      const cacheKey = `bubblemaps:${upstreamPath}:${JSON.stringify(req.query || {})}`;
      const { data: cachedOrFresh } = await getOrSetCache(cacheKey, CACHE_TTL_SECONDS, fetchUpstream);
      return res.status(cachedOrFresh.status || 200).json(cachedOrFresh.data);
    }

    const fresh = await fetchUpstream();
    return res.status(fresh.status).json(fresh.data);
  } catch (err) {
    console.error(`[Bubblemaps Proxy] Handler error:`, err);
    return res.status(500).json({ error: 'Internal Bubblemaps proxy error' });
  }
}

// ── Route Definitions ────────────────────────────────────────────────────────

// Public chains & search
router.get('/chains', handleBubblemapsProxyRequest);
router.get('/tokens/search', handleBubblemapsProxyRequest);

// Tokens endpoints
router.get('/tokens/map/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);
router.get('/map/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);

router.get('/tokens/screenshot/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);
router.get('/screenshot/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);

router.get('/tokens/metrics/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);
router.get('/metrics/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);

router.get('/tokens/holders/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);
router.get('/holders/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);

router.get('/tokens/metadata/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);
router.get('/metadata/:chain/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);

router.post('/tokens/metadata', handleBubblemapsProxyRequest);

// Addresses & Subgraph endpoints
router.get('/addresses/metadata/:address', validateBubblemapsParams, handleBubblemapsProxyRequest);
router.post('/addresses/metadata', handleBubblemapsProxyRequest);
router.post('/relationships/subgraph', handleBubblemapsProxyRequest);

export default router;
