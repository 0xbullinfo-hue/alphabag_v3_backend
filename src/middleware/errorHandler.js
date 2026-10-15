// SPDX-License-Identifier: MIT
import { config } from '../config/env.js';
export function errorHandler(err, req, res, next) {
  console.error('[SERVER ERROR]', err);
  
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: message,
    ...(config.isDev && { stack: err.stack })
  });
}
