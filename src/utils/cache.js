import NodeCache from 'node-cache';

// Standard default 30-second TTL (Time-To-Live), check for expired entries every 60s
export const memoryCache = new NodeCache({
  stdTTL: 30,
  checkperiod: 60,
  useClones: false
});

/**
 * Universal get-or-set helper for in-memory caching
 * @param {string} key - Cache identifier
 * @param {number} ttlSeconds - Duration to store in seconds (default: 30s)
 * @param {Function} fetchFn - Async function returning fresh data if cache missed
 * @returns {Promise<{ data: any, fromCache: boolean }>}
 */
export async function getOrSetCache(key, ttlSeconds = 30, fetchFn) {
  const cached = memoryCache.get(key);
  if (cached !== undefined && cached !== null) {
    return { data: cached, fromCache: true };
  }

  const fresh = await fetchFn();
  if (fresh !== undefined && fresh !== null) {
    memoryCache.set(key, fresh, ttlSeconds);
  }
  return { data: fresh, fromCache: false };
}

/**
 * Invalidate a specific key or keys matching prefix
 * @param {string} prefix 
 */
export function invalidateCache(prefix) {
  const keys = memoryCache.keys();
  const matched = keys.filter(k => k.startsWith(prefix));
  if (matched.length > 0) {
    memoryCache.del(matched);
  }
}

export default memoryCache;