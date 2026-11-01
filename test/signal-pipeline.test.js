import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleSignals } from '../src/controllers/publicController.js';
import { createSignal, updateSignal } from '../src/controllers/adminController.js';
import { store } from '../src/services/storeService.js';
import { pollSignalChanges, publishSignalChange, subscribeToSignalChanges } from '../src/services/signalEvents.js';

const signal = {
  id: 'signal-1',
  pair: 'ETH/USDT',
  type: 'LONG',
  entry: '2000',
  stopLoss: '1900',
  targets: ['2200'],
  status: 'ACTIVE',
};

test('Signal visibility uses current database tier, not a stale JWT tier', async () => {
  const originals = { read: store.read, findOne: store.findOne };
  store.read = async () => [signal];
  store.findOne = async (collection) => {
    if (collection === 'users') return { id: 'user-1', tier: 'FREE' };
    return null;
  };
  try {
    const result = await getVisibleSignals({ id: 'user-1', tier: 'ULTIMATE' });
    assert.equal(result[0].isBlurred, true);
    assert.equal('entry' in result[0], false);
  } finally {
    store.read = originals.read;
    store.findOne = originals.findOne;
  }
});

test('Signal visibility returns full details for current ULTIMATE users', async () => {
  const originals = { read: store.read, findOne: store.findOne };
  store.read = async () => [signal];
  store.findOne = async (collection) => collection === 'users' ? { id: 'user-2', tier: 'ULTIMATE' } : null;
  try {
    const result = await getVisibleSignals({ id: 'user-2', tier: 'FREE' });
    assert.equal(result[0].entry, '2000');
    assert.equal(result[0].isBlurred, undefined);
  } finally {
    store.read = originals.read;
    store.findOne = originals.findOne;
  }
});

test('Admin signal creation emits a change only after persistence succeeds', async () => {
  const originalCreate = store.create;
  let published = null;
  const unsubscribe = subscribeToSignalChanges((change) => { published = change; });
  store.create = async (_collection, value) => ({ ...value, id: 'signal-created' });
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  try {
    await createSignal({ body: { pair: 'BTC/USDT', type: 'LONG', targets: ['70000'] } }, response);
    assert.equal(response.body.item.id, 'signal-created');
    assert.equal(published.action, 'created');
    assert.equal(published.signalId, 'signal-created');
  } finally {
    unsubscribe();
    store.create = originalCreate;
  }
});

test('Admin signal updates use targeted persistence and publish only successful changes', async () => {
  const originalUpdate = store.updateById;
  let updateFn;
  let published = null;
  const unsubscribe = subscribeToSignalChanges((change) => { published = change; });
  store.updateById = async (_collection, id, callback) => {
    updateFn = callback;
    return { ...signal, ...callback(signal), id };
  };
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  try {
    await updateSignal({ params: { id: signal.id }, body: { status: 'HIT', ignoredField: 'ignored' } }, response);
    assert.equal(updateFn(signal).status, 'HIT');
    assert.equal(response.body.item.status, 'HIT');
    assert.equal(published.action, 'updated');
    assert.equal(published.signalId, signal.id);
  } finally {
    unsubscribe();
    store.updateById = originalUpdate;
  }
});

test('Signal event payload receives an event timestamp', () => {
  let emitted;
  const unsubscribe = subscribeToSignalChanges((change) => { emitted = change; });
  try {
    publishSignalChange({ action: 'deleted', signalId: 'signal-1' });
    assert.equal(emitted.action, 'deleted');
    assert.ok(Number.isFinite(Date.parse(emitted.occurredAt)));
  } finally {
    unsubscribe();
  }
});

test('Signal polling publishes changes made by another backend instance', async () => {
  const originalRead = store.read;
  let currentSignals = [{ ...signal, status: 'ACTIVE' }];
  let published = null;
  store.read = async () => currentSignals;
  const unsubscribe = subscribeToSignalChanges((change) => { published = change; });
  try {
    await pollSignalChanges();
    currentSignals = [{ ...signal, status: 'HIT' }];
    await pollSignalChanges();
    assert.equal(published.action, 'synced');
  } finally {
    unsubscribe();
    store.read = originalRead;
  }
});