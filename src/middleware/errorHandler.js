// SPDX-License-Identifier: MIT
import { config } from '../config/env.js';
export function errorHandler(err, req, res, next) {
  console.error('[SERVER ERROR]', err);
  
  if (res.headersSent) {
    return next(err);
  }

  const isStoreOutage = err.name === 'StoreUnavailableError' || err.statusCode === 503;
  const statusCode = isStoreOutage ? 503 : (err.statusCode || err.status || 500);
  const message = isStoreOutage ? 'Service temporarily unavailable' : (err.message || 'Internal Server Error');

  res.status(statusCode).json({
    error: message,
    ...(config.isDev && { stack: err.stack })
  });
}
