import { EventEmitter } from 'node:events';
import { store } from './storeService.js';

const signalEvents = new EventEmitter();
signalEvents.setMaxListeners(0);
const POLL_INTERVAL_MS = 3000;
let signalFingerprint = null;
let pollTimer = null;
let pollingSubscribers = 0;

export const pollSignalChanges = async () => {
  try {
    const signals = await store.read('signals') || [];
    const nextFingerprint = JSON.stringify(signals);
    if (signalFingerprint !== null && signalFingerprint !== nextFingerprint) {
      signalEvents.emit('change', { action: 'synced', occurredAt: new Date().toISOString() });
    }
    signalFingerprint = nextFingerprint;
  } catch (error) {
    console.warn('[SignalEvents] Change poll failed:', error.message);
  }
};

export const publishSignalChange = (change) => {
  signalFingerprint = null;
  signalEvents.emit('change', { ...change, occurredAt: new Date().toISOString() });
};

export const subscribeToSignalChanges = (listener, { pollDatabase = false } = {}) => {
  signalEvents.on('change', listener);
  if (pollDatabase) {
    pollingSubscribers += 1;
    if (!pollTimer) {
      void pollSignalChanges();
      pollTimer = setInterval(pollSignalChanges, POLL_INTERVAL_MS);
    }
  }
  return () => {
    signalEvents.off('change', listener);
    if (pollDatabase) {
      pollingSubscribers = Math.max(0, pollingSubscribers - 1);
      if (pollingSubscribers === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        signalFingerprint = null;
      }
    }
  };
};