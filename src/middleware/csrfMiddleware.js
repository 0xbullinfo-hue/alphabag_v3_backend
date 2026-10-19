import { config } from '../config/env.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Reduce any URL-ish string to its origin ("https://app.example.com/path/" -> "https://app.example.com"). */
export function toOrigin(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF Protection Middleware
 * Defends against cross-site request forgery when requests are authenticated via the HttpOnly session cookie.
 *
 * For cookie-authenticated, state-changing requests ALL of these must hold:
 *  1. an Origin (or, failing that, Referer) header is present and parses,
 *  2. it matches the configured frontend origin (any localhost origin is also accepted outside production),
 *  3. a custom client header (X-Requested-With or X-Request-Id) is present, which cross-site forms cannot set.
 * Header-authenticated API clients (no session cookie) are not affected.
 */
export function csrfProtection(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const hasCookieAuth = Boolean(req.cookies?.alphabag_session);
  if (!hasCookieAuth) return next();

  const origin = toOrigin(req.headers['origin']) || toOrigin(req.headers['referer']);
  if (!origin) {
    return res.status(403).json({ error: 'CSRF validation failed: Origin header required' });
  }

  const allowedOrigin = toOrigin(config.frontendUrl);
  const isAllowed = origin === allowedOrigin || (!config.isProduction && LOCAL_ORIGIN.test(origin));
  if (!isAllowed) {
    return res.status(403).json({ error: 'CSRF validation failed: Invalid origin' });
  }

  if (!req.headers['x-requested-with'] && !req.headers['x-request-id']) {
    return res.status(403).json({ error: 'CSRF validation failed: Missing custom client header' });
  }

  next();
}
