
import ccxt from 'ccxt';
import crypto from 'crypto';
import { store } from '../services/storeService.js';
import { decryptCredential, encryptCredential } from '../services/credentialEncryptionService.js';

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

export const createConnection = async (req, res) => {
    const { exchangeId, apiKey, secret, passphrase } = req.body;

    try {
        if (typeof exchangeId !== 'string' || typeof apiKey !== 'string' || typeof secret !== 'string' || !apiKey || !secret) {
            return res.status(400).json({ error: 'exchangeId, apiKey, and secret are required' });
        }
        const exchange = createExchange(exchangeId, apiKey, secret, passphrase);
        await exchange.fetchBalance();

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

        res.status(existing ? 200 : 201).json({ connection: toPublicConnection(connection) });

    } catch (error) {
        console.error(`[CEX] Connection failed: ${error.message}`);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not verify exchange credentials' });
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
    const connections = (await store.read('cex_connections')).filter((connection) => connection.userId === req.user.id);
    const balances = [];

    for (const connection of connections) {
        try {
            const exchange = createExchange(
                connection.exchangeId,
                decryptCredential(connection.encryptedApiKey),
                decryptCredential(connection.encryptedSecret),
                connection.encryptedPassphrase ? decryptCredential(connection.encryptedPassphrase) : undefined,
            );
            const response = await exchange.fetchBalance();
            for (const [symbol, amount] of Object.entries(response.total || {})) {
                if (Number(amount) > 0) {
                    balances.push({
                        connectionId: connection.id,
                        exchange: connection.exchangeId,
                        symbol,
                        name: symbol,
                        balance: String(amount),
                        priceUSD: 0,
                        valueUSD: 0,
                    });
                }
            }
            await store.updateById('cex_connections', connection.id, () => ({ lastSyncedAt: new Date().toISOString(), status: 'CONNECTED' }));
        } catch (error) {
            console.error(`[CEX] Balance refresh failed for ${connection.exchangeId}: ${error.message}`);
            await store.updateById('cex_connections', connection.id, () => ({ status: 'ERROR' }));
        }
    }

    res.json({ balances, totalUSD: 0, updatedAt: new Date().toISOString() });
};

export const getBalance = createConnection;
