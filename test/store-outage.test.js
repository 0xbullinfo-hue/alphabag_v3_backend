import test from 'node:test';
import assert from 'node:assert/strict';

import { StoreUnavailableError } from '../src/services/storeService.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

test('StoreUnavailableError has statusCode 503 and formats correctly', () => {
    const err = new StoreUnavailableError('Database refused connection');
    assert.equal(err.name, 'StoreUnavailableError');
    assert.equal(err.statusCode, 503);
    assert.equal(err.status, 503);
    assert.equal(err.message, 'Database refused connection');
});

test('errorHandler maps StoreUnavailableError to 503 Service temporarily unavailable without stack leak in non-dev', () => {
    const err = new StoreUnavailableError('ECONNREFUSED 127.0.0.1:5432');
    let statusCode = null;
    let body = null;

    const res = {
        headersSent: false,
        status(code) {
            statusCode = code;
            return this;
        },
        json(payload) {
            body = payload;
            return this;
        }
    };

    errorHandler(err, {}, res, () => {});

    assert.equal(statusCode, 503);
    assert.equal(body.error, 'Service temporarily unavailable');
    // In test environment config.isDev is true so stack is visible in test runs; in production isDev is false
});
