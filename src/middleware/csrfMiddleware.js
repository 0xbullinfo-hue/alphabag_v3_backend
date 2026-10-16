import { config } from '../config/env.js';

/**
 * CSRF Protection Middleware
 * Defends against cross-site request forgery when requests are authenticated via HttpOnly cookies.
 */
export function csrfProtection(req, res, next) {
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (!mutatingMethods.includes(req.method)) {
    return next();
  }

  // Only enforce when request is authenticated via cookie
  const hasCookieAuth = Boolean(req.cookies?.alphabag_session);
  if (!hasCookieAuth) {
    return next();
  }

  const origin = req.headers['origin'] || (req.headers['referer'] ? new URL(req.headers['referer']).origin : null);
  if (origin) {
    if (config.isProduction) {
      if (origin !== config.frontendUrl) {
        return res.status(403).json({ error: 'CSRF validation failed: Invalid origin' });
      }
    } else {
      const isLocal =
        origin.startsWith('http://localhost:') ||
        origin.startsWith('https://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('https://127.0.0.1:') ||
        origin.startsWith('http://[::1]:');

      if (!isLocal && origin !== config.frontendUrl) {
        return res.status(403).json({ error: 'CSRF validation failed: Invalid dev origin' });
      }
    }
  }

  // Check custom client header (browsers block cross-site custom headers in simple requests)
  const requestedWith = req.headers['x-requested-with'];
  const requestId = req.headers['x-request-id'];
  if (!requestedWith && !requestId) {
    return res.status(403).json({ error: 'CSRF validation failed: Missing custom client header' });
  }

  next();
}
