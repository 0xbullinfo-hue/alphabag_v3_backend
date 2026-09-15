// SPDX-License-Identifier: MIT
// AlphaBAG V3 — CEX Controller (fixed)
// Fixes vs. previous version:
//   1. REMOVED the `balancesByCurrency` ReferenceError that 500'd every
//      successful connect (the connection was saved, then the handler crashed).
//   2. Balances are now VALUED IN USD via priceService (were hardcoded 0).
//   3. New: GET /api/cex/trades — imports trade history (ccxt fetchMyTrades)
//      into the `trades` table as the foundation for cost-basis / P&L.

import ccxt from 'ccxt';
import crypto from 'crypto';
import { store } from '../services/storeService.js';
import { decryptCredential, encryptCredential } from '../services/credentialEncryptionService.js';
import { getSymbolPrices } from '../services/priceService.js';

const toPublicConnection = (connection) => ({
    id: connection.id,
    exchangeId: connection.exchangeId,
    name: connection.exchangeId,
    status: connection.status,
    createdAt: connection.createdAt,
    lastSyncedAt: connection.lastSyncedAt || null,
});

const createExchange = (exchangeId, apiKey, secret, passphrase) => {
    if (!ccxt[exchangeId]) {
        const error = new Error('Exchange not supported');
        error.statusCode = 400;
        throw error;
    }
    return new ccxt[exchangeId]({
        apiKey,
        secret,
        password: passphrase || undefined,
        enableRateLimit: true,
    });
};

const exchangeFromConnection = (connection) => createExchange(
    connection.exchangeId,
    decryptCredential(connection.encryptedApiKey),
    decryptCredential(connection.encryptedSecret),
    connection.encryptedPassphrase ? decryptCredential(connection.encryptedPassphrase) : undefined,
);

/** Non-zero balances from a ccxt fetchBalance response */
const serializeBalances = (response) => Object.entries(response.total || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([symbol, amount]) => ({ symbol, balance: Number(amount) }));

/** Attach USD prices + values, sorted by value desc. */
export const buildPricedBalances = async (connection, response) => {
    const raw = serializeBalances(response);
    const prices = await getSymbolPrices(raw.map((b) => b.symbol));

    let totalUSD = 0;
    const balances = raw.map(({ symbol, balance }) => {
        const p = prices[symbol.toUpperCase()] || { usd: 0, usd_24h_change: 0 };
        const valueUSD = balance * p.usd;
        totalUSD += valueUSD;
        return {
            connectionId: connection.id,
            exchange: connection.exchangeId,
            symbol,
            name: symbol,
            balance: String(balance),
            priceUSD: p.usd,
            valueUSD: Number(valueUSD.toFixed(2)),
            change24h: p.usd_24h_change,
        };
    }).sort((a, b) => b.valueUSD - a.valueUSD);

    return { balances, totalUSD: Number(totalUSD.toFixed(2)) };
};

/** Fetch + price every CEX connection for a user. Shared by REST, SSE and net-worth. */
export const fetchUserCexBalances = async (userId) => {
    const connections = (await store.read('cex_connections')).filter((c) => c.userId === userId);
    const balances = [];
    let totalUSD = 0;

    for (const connection of connections) {
        try {
            const exchange = exchangeFromConnection(connection);
            const response = await exchange.fetchBalance();
            const priced = await buildPricedBalances(connection, response);
            balances.push(...priced.balances);
            totalUSD += priced.totalUSD;
            await store.updateById('cex_connections', connection.id, () => ({
                lastSyncedAt: new Date().toISOString(),
                status: 'CONNECTED',
            }));
        } catch (error) {
            console.error(`[CEX] Balance refresh failed for ${connection.exchangeId}: ${error.message}`);
            await store.updateById('cex_connections', connection.id, () => ({ status: 'ERROR' }));
        }
    }

    return { balances, totalUSD: Number(totalUSD.toFixed(2)), updatedAt: new Date().toISOString() };
};

export const createConnection = async (req, res) => {
    const { exchangeId, apiKey, secret, passphrase } = req.body;

    try {
        if (typeof exchangeId !== 'string' || typeof apiKey !== 'string' || typeof secret !== 'string' || !apiKey || !secret) {
            return res.status(400).json({ error: 'exchangeId, apiKey, and secret are required' });
        }

        const exchange = createExchange(exchangeId, apiKey, secret, passphrase);
        const balanceResponse = await exchange.fetchBalance(); // live credential verification

        const existing = await store.findOne('cex_connections', { userId: req.user.id, exchangeId });
        const connectionData = {
            exchangeId,
            encryptedApiKey: encryptCredential(apiKey),
            encryptedSecret: encryptCredential(secret),
            encryptedPassphrase: passphrase ? encryptCredential(passphrase) : null,
            status: 'CONNECTED',
            lastSyncedAt: new Date().toISOString(),
        };

        let connection;
        if (existing) {
            connection = await store.updateById('cex_connections', existing.id, () => connectionData);
        } else {
            connection = await store.create('cex_connections', {
                id: crypto.randomUUID(),
                userId: req.user.id,
                ...connectionData,
            });
        }

        // Price the freshly verified balances so the UI shows real values immediately
        const { balances, totalUSD } = await buildPricedBalances(connection, balanceResponse);

        res.status(existing ? 200 : 201).json({
            success: true,
            verified: true,
            connection: toPublicConnection(connection),
            balances,
            totalUSD,
        });
    } catch (error) {
        console.error(`[CEX] Connection failed: ${error.message}`);
        const isAuthError = /invalid|unauthor|signature|api[- ]?key/i.test(error.message);
        res.status(isAuthError ? 401 : (error.statusCode || 500)).json({
            error: isAuthError ? 'Exchange rejected the API credentials' : (error.statusCode ? error.message : 'Could not verify exchange credentials'),
        });
    }
};

export const listConnections = async (req, res) => {
    const connections = await store.read('cex_connections');
    res.json({ connections: connections.filter((connection) => connection.userId === req.user.id).map(toPublicConnection) });
};

export const deleteConnection = async (req, res) => {
    const connection = await store.findOne('cex_connections', { id: req.params.connectionId, userId: req.user.id });
    if (!connection) {
        return res.status(404).json({ error: 'CEX connection not found' });
    }

    const connections = await store.read('cex_connections');
    await store.write('cex_connections', connections.filter((item) => item.id !== connection.id));
    res.status(204).end();
};

export const getBalances = async (req, res) => {
    const result = await fetchUserCexBalances(req.user.id);
    res.json({ ...result });
};

export const getBalance = getBalances;

/**
 * GET /api/cex/trades?exchangeId=binance&symbol=BTC/USDT&since=<ms>&limit=<n>
 * Imports trade history from the connected exchange into the `trades` table.
 * Idempotent — records carry a deterministic id, so re-imports upsert safely.
 */
export const getTradeHistory = async (req, res) => {
    const { exchangeId, symbol, since, limit } = req.query;
    if (!exchangeId || typeof exchangeId !== 'string') {
        return res.status(400).json({ error: 'exchangeId query parameter is required' });
    }

    const connection = await store.findOne('cex_connections', { userId: req.user.id, exchangeId });
    if (!connection) {
        return res.status(404).json({ error: `No ${exchangeId} connection found for this account` });
    }

    const maxLimit = Math.min(Number(limit) || 500, 1000);
    const sinceMs = since ? Number(since) : Date.now() - 90 * 24 * 60 * 60 * 1000; // default: last 90 days

    try {
        const exchange = exchangeFromConnection(connection);
        const trades = await exchange.fetchMyTrades(symbol || undefined, sinceMs, maxLimit);

        const saved = [];
        for (const t of trades) {
            const record = {
                id: `${req.user.id}:${exchangeId}:${t.id ?? t.order ?? t.timestamp}`,
                userId: req.user.id,
                exchangeId,
                symbol: t.symbol,
                side: t.side,
                price: t.price ?? 0,
                amount: t.amount ?? 0,
                cost: t.cost ?? (t.price ?? 0) * (t.amount ?? 0),
                fee: t.fee?.cost ?? 0,
                feeCurrency: t.fee?.currency ?? null,
                timestamp: new Date(t.timestamp),
                tradeId: String(t.id ?? ''),
            };
            try {
                await store.create('trades', record);
                saved.push(record);
            } catch (error) {
                // Duplicate id on re-import — ignore
                if (!/unique|duplicate/i.test(error.message)) throw error;
            }
        }

        res.json({ success: true, count: saved.length, trades: saved });
    } catch (error) {
        console.error(`[CEX] Trade history import failed for ${exchangeId}: ${error.message}`);
        res.status(502).json({ error: `Could not fetch trade history from ${exchangeId}` });
    }
};


export const getAccountCoverage = async (req, res) => {
    const connections = (await store.read('cex_connections')).filter(c => c.userId === req.user.id);
    const accounts = [];
    for (const connection of connections) {
        const buckets = [];
        try {
            const exchange = exchangeFromConnection(connection);
            const spot = await exchange.fetchBalance();
            buckets.push({ accountType: 'SPOT', status: 'OK', balances: spot.total || {} });
            for (const accountType of ['FUNDING', 'EARN', 'MARGIN', 'FUTURES', 'OPTIONS']) {
                buckets.push({ accountType, status: 'UNSUPPORTED', balances: {} });
            }
        } catch (error) {
            buckets.push({ accountType: 'SPOT', status: 'ERROR', error: 'SYNC_FAILED', balances: {} });
        }
        accounts.push({ connectionId: connection.id, exchangeId: connection.exchangeId, buckets });
    }
    res.json({ accounts, updatedAt: new Date().toISOString() });
};


export const getServerInfo = async (req, res) => {
  const outboundIp = process.env.OUTBOUND_SERVER_IP || null;
  res.json({
    outboundIp,
    requiresWhitelist: Boolean(outboundIp),
    supportedAccounts: ['SPOT'],
    unsupportedAccounts: ['FUNDING', 'EARN', 'MARGIN', 'FUTURES', 'OPTIONS'],
    note: outboundIp ? 'Add this egress IP to your exchange API key allowlist' : 'No static outbound IP configured',
  });
};
