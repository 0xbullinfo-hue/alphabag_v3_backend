// SPDX-License-Identifier: MIT
export function errorHandler(err, req, res, next) {
  console.error('[SERVER ERROR]', err);
  
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}
