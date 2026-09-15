import axios from 'axios';
import { config } from '../config/env.js';

let cachedHealth = null;
let lastCheckTime = 0;

const timeoutMs = config.providerHealthTimeoutMs || 5000;
const cacheMs = config.providerHealthCacheMs || 15000;

function sanitizeErrorMessage(msg) {
  if (!msg) return '';
  let cleaned = String(msg);
  for (const secret of [
    process.env.GEMINI_API_KEY,
    process.env.MORALIS_API_KEY,
    process.env.ALCHEMY_API_KEY,
    process.env.COVALENT_API_KEY,
    process.env.COINGECKO_API_KEY,
    process.env.JWT_SECRET,
    process.env.CEX_ENCRYPTION_KEY,
  ]) {
    if (secret && secret.length >= 4) {
      cleaned = cleaned.replaceAll(secret, '[REDACTED]');
    }
  }
  cleaned = cleaned.replace(/([?&][a-zA-Z0-9_-]*key=)[^&\s]+/gi, '$1[REDACTED]');
  return cleaned.slice(0, 200);
}

function classifyError(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(error?.message || '')) return 'TIMEOUT';
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') return 'UNAVAILABLE';
  return 'ERROR';
}

async function probeHttp(url, options = {}) {
  const started = Date.now();
  try {
    const response = await axios.get(url, {
      headers: options.headers || {},
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const latencyMs = Date.now() - started;
    let status = 'HEALTHY';
    if (response.status === 401 || response.status === 403) status = 'AUTH_FAILED';
    else if (response.status === 429) status = 'RATE_LIMITED';
    else if (response.status >= 500) status = 'UNAVAILABLE';
    else if (response.status >= 400) status = 'ERROR';
    else if (latencyMs > 2500) status = 'DEGRADED';

    return {
      status,
      httpStatus: response.status,
      latencyMs,
    };
  } catch (error) {
    return {
      status: classifyError(error),
      latencyMs: Date.now() - started,
      message: sanitizeErrorMessage(error.message),
    };
  }
}

async function probeRpc(rpcUrl, method = 'eth_blockNumber', params = []) {
  const started = Date.now();
  try {
    const response = await axios.post(
      rpcUrl,
      { jsonrpc: '2.0', id: 1, method, params },
      { timeout: timeoutMs, validateStatus: () => true }
    );
    const latencyMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) return { status: 'AUTH_FAILED', latencyMs };
    if (response.status === 429) return { status: 'RATE_LIMITED', latencyMs };
    if (response.status >= 500) return { status: 'UNAVAILABLE', latencyMs };
    if (response.data?.error) {
      return { status: 'ERROR', latencyMs, message: sanitizeErrorMessage(response.data.error.message) };
    }
    const result = response.data?.result;
    const blockNumber = typeof result === 'string' && result.startsWith('0x') ? parseInt(result, 16) : (typeof result === 'number' ? result : null);
    return {
      status: latencyMs > 2500 ? 'DEGRADED' : 'HEALTHY',
      latencyMs,
      blockOrSlot: blockNumber,
    };
  } catch (error) {
    return {
      status: classifyError(error),
      latencyMs: Date.now() - started,
      message: sanitizeErrorMessage(error.message),
    };
  }
}

export async function checkDatabaseHealth() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { provider: 'database', kind: 'infrastructure', status: 'UNCONFIGURED' };
  }
  const started = Date.now();
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: dbUrl, connectionTimeoutMillis: timeoutMs });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      const latencyMs = Date.now() - started;
      return {
        provider: 'database',
        kind: 'infrastructure',
        status: latencyMs > 2000 ? 'DEGRADED' : 'HEALTHY',
        latencyMs,
      };
    } catch (queryErr) {
      await pool.end().catch(() => {});
      throw queryErr;
    }
  } catch (err) {
    const isAuth = /password|authentication/i.test(err.message || '');
    return {
      provider: 'database',
      kind: 'infrastructure',
      status: isAuth ? 'AUTH_FAILED' : 'UNAVAILABLE',
      latencyMs: Date.now() - started,
      message: sanitizeErrorMessage(err.message),
    };
  }
}

export async function checkRedisHealth() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return { provider: 'redis', kind: 'cache', status: 'UNCONFIGURED' };
  }
  return { provider: 'redis', kind: 'cache', status: 'CONFIGURED', latencyMs: 1 };
}

export async function checkProvider(name) {
  const normalized = String(name).toLowerCase();
  switch (normalized) {
    case 'database':
    case 'postgres':
    case 'postgresql':
      return checkDatabaseHealth();
    case 'redis':
      return checkRedisHealth();
    case 'alchemy': {
      const key = process.env.ALCHEMY_API_KEY;
      if (!key) return { provider: 'alchemy', kind: 'rpc', status: 'UNCONFIGURED' };
      const probe = await probeRpc(`https://eth-mainnet.g.alchemy.com/v2/${key}`, 'eth_blockNumber', []);
      return { provider: 'alchemy', kind: 'rpc', ...probe };
    }
    case 'moralis': {
      const key = process.env.MORALIS_API_KEY;
      if (!key) return { provider: 'moralis', kind: 'defi', status: 'UNCONFIGURED' };
      const probe = await probeHttp('https://deep-index.moralis.io/api/v2/date', {
        headers: { 'X-API-Key': key },
      });
      return { provider: 'moralis', kind: 'defi', ...probe };
    }
    case 'coingecko': {
      const key = process.env.COINGECKO_API_KEY;
      const headers = key ? { 'x-cg-demo-api-key': key } : {};
      const probe = await probeHttp('https://api.coingecko.com/api/v3/ping', { headers });
      return { provider: 'coingecko', kind: 'market', ...probe };
    }
    case 'dexscreener': {
      const probe = await probeHttp('https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      return { provider: 'dexscreener', kind: 'market', ...probe };
    }
    case 'covalent': {
      const key = process.env.COVALENT_API_KEY;
      if (!key) return { provider: 'covalent', kind: 'data', status: 'UNCONFIGURED' };
      const probe = await probeHttp('https://api.covalenthq.com/v1/1/block/latest/', {
        headers: { Authorization: `Bearer ${key}` },
      });
      return { provider: 'covalent', kind: 'data', ...probe };
    }
    case 'gemini': {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return { provider: 'gemini', kind: 'ai', status: 'UNCONFIGURED' };
      const started = Date.now();
      try {
        const res = await axios.get(
          'https://generativelanguage.googleapis.com/v1beta/models',
          {
            params: { key },
            timeout: timeoutMs,
            validateStatus: () => true,
          }
        );
        const latencyMs = Date.now() - started;
        let status = 'HEALTHY';
        if (res.status === 401 || res.status === 403) status = 'AUTH_FAILED';
        else if (res.status === 429) status = 'RATE_LIMITED';
        else if (res.status >= 500) status = 'UNAVAILABLE';
        else if (res.status >= 400) status = 'ERROR';
        else if (latencyMs > 2500) status = 'DEGRADED';
        return { provider: 'gemini', kind: 'ai', status, httpStatus: res.status, latencyMs };
      } catch (err) {
        return {
          provider: 'gemini',
          kind: 'ai',
          status: classifyError(err),
          latencyMs: Date.now() - started,
          message: sanitizeErrorMessage(err.message),
        };
      }
    }
    case 'ethereum': {
      const key = process.env.ALCHEMY_API_KEY;
      const url = key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : 'https://cloudflare-eth.com';
      const probe = await probeRpc(url, 'eth_blockNumber');
      return { provider: 'ethereum', kind: 'chain', chain: 'ethereum', ...probe };
    }
    case 'base': {
      const key = process.env.ALCHEMY_API_KEY;
      const url = key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : 'https://mainnet.base.org';
      const probe = await probeRpc(url, 'eth_blockNumber');
      return { provider: 'base', kind: 'chain', chain: 'base', ...probe };
    }
    case 'arbitrum': {
      const key = process.env.ALCHEMY_API_KEY;
      const url = key ? `https://arb-mainnet.g.alchemy.com/v2/${key}` : 'https://arb1.arbitrum.io/rpc';
      const probe = await probeRpc(url, 'eth_blockNumber');
      return { provider: 'arbitrum', kind: 'chain', chain: 'arbitrum', ...probe };
    }
    case 'polygon': {
      const key = process.env.ALCHEMY_API_KEY;
      const url = key ? `https://polygon-mainnet.g.alchemy.com/v2/${key}` : 'https://polygon-rpc.com';
      const probe = await probeRpc(url, 'eth_blockNumber');
      return { provider: 'polygon', kind: 'chain', chain: 'polygon', ...probe };
    }
    case 'bsc': {
      const probe = await probeRpc('https://binance.llamarpc.com', 'eth_blockNumber');
      return { provider: 'bsc', kind: 'chain', chain: 'bsc', ...probe };
    }
    case 'solana': {
      const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      const probe = await probeRpc(url, 'getSlot');
      return { provider: 'solana', kind: 'chain', chain: 'solana', ...probe };
    }
    default:
      return { provider: name, status: 'UNKNOWN' };
  }
}

export async function getProviderHealth(force = false) {
  const now = Date.now();
  if (!force && cachedHealth && (now - lastCheckTime < cacheMs)) {
    return { ...cachedHealth, fromCache: true };
  }

  const providersToProbe = [
    'database',
    'redis',
    'alchemy',
    'moralis',
    'coingecko',
    'dexscreener',
    'covalent',
    'gemini',
    'ethereum',
    'base',
    'arbitrum',
    'polygon',
    'bsc',
    'solana',
  ];

  const results = await Promise.all(providersToProbe.map(name => checkProvider(name)));
  const unhealthy = results.filter(r => !['HEALTHY', 'CONFIGURED', 'UNCONFIGURED'].includes(r.status));
  const overallStatus = unhealthy.length > 0 ? 'DEGRADED' : 'HEALTHY';

  cachedHealth = {
    status: overallStatus,
    checkedAt: new Date(now).toISOString(),
    providers: results,
  };
  lastCheckTime = now;

  return cachedHealth;
}
