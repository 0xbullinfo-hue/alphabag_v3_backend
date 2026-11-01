import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import { config } from '../src/config/env.js';
import { store } from '../src/services/storeService.js';

const readSseFrame = async (reader, decoder, timeoutMs = 3000) => {
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timeout;
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Timed out waiting for SSE frame')), remaining); }),
    ]).finally(() => clearTimeout(timeout));
    if (result.done) throw new Error('SSE stream closed before sending a frame');
    buffer += decoder.decode(result.value, { stream: true });
    const frameEnd = buffer.indexOf('\n\n');
    if (frameEnd !== -1) return buffer.slice(0, frameEnd);
  }
  throw new Error('Timed out waiting for SSE frame');
};

test('HTTP AlphaCalls flow gates signal details and streams admin posts', async () => {
  const originals = { read: store.read, findOne: store.findOne, create: store.create };
  const signals = [{
    id: 'existing-signal',
    pair: 'ETH/USDT',
    type: 'LONG',
    entry: '2000',
    stopLoss: '1900',
    targets: ['2200'],
    status: 'ACTIVE',
  }];

  store.read = async (collection) => collection === 'signals' ? signals.map((signal) => ({ ...signal })) : [];
  store.findOne = async (collection, query) => {
    if (collection === 'admins' && (query.id === 'admin-test' || query.email === 'admin@test.local')) return { id: 'admin-test', email: 'admin@test.local', tokenVersion: 0 };
    if (collection === 'users' && query.id === 'pro-test') return { id: 'pro-test', tier: 'ULTIMATE', tokenVersion: 0 };
    return null;
  };
  store.create = async (collection, signal) => {
    const saved = { ...signal, id: 'published-signal' };
    signals.push(saved);
    return saved;
  };

  const server = app.listen(0);
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const adminToken = jwt.sign({ id: 'admin-test', email: 'admin@test.local', isAdmin: true, tv: 0 }, config.jwtSecret, { expiresIn: '5m', algorithm: 'HS256' });
  const proToken = jwt.sign({ id: 'pro-test', tier: 'ULTIMATE', tv: 0 }, config.jwtSecret, { expiresIn: '5m', algorithm: 'HS256' });
  const streamController = new AbortController();
  let streamReader;

  try {
    const anonymous = await fetch(`${origin}/api/signals`);
    assert.equal(anonymous.status, 200);
    const anonymousSignals = await anonymous.json();
    assert.equal(anonymousSignals[0].isBlurred, true);
    assert.equal('entry' in anonymousSignals[0], false);

    const proResponse = await fetch(`${origin}/api/signals`, { headers: { Authorization: `Bearer ${proToken}` } });
    assert.equal(proResponse.status, 200);
    assert.equal((await proResponse.json())[0].entry, '2000');

    const forbiddenMutation = await fetch(`${origin}/api/admin/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pair: 'BTC/USDT', type: 'LONG' }),
    });
    assert.equal(forbiddenMutation.status, 401);

    const streamResponse = await fetch(`${origin}/api/signals/stream`, {
      headers: { Authorization: `Bearer ${proToken}` },
      signal: streamController.signal,
    });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
    streamReader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    const initialFrame = await readSseFrame(streamReader, decoder);
    assert.match(initialFrame, /event: snapshot/);
    assert.match(initialFrame, /"entry":"2000"/);

    const mutation = await fetch(`${origin}/api/admin/signals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pair: 'BTC/USDT', type: 'LONG', targets: ['70000'] }),
    });
    assert.equal(mutation.status, 200);
    assert.equal((await mutation.json()).item.id, 'published-signal');

    const updateFrame = await readSseFrame(streamReader, decoder);
    assert.match(updateFrame, /event: signals/);
    assert.match(updateFrame, /"pair":"BTC\/USDT"/);
  } finally {
    await streamReader?.cancel().catch(() => {});
    streamController.abort();
    store.read = originals.read;
    store.findOne = originals.findOne;
    store.create = originals.create;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});