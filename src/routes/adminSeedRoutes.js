// SPDX-License-Identifier: MIT
// PATCH: adminSeedRoutes.js — Secure bootstrap for first admin
// Usage: POST /api/admin-seed with { wallet: "0x...", secret: "SETUP_SECRET_FROM_ENV" }
// This route is ONLY usable when zero admins exist in the database,
// OR when the correct ADMIN_SETUP_SECRET is provided.
// After the first admin is created, disable this route by removing it from app.js
// or by rotating/deleting the ADMIN_SETUP_SECRET env var.

import express from 'express';
import { config } from '../config/env.js';
import { store } from '../services/storeService.js';

const router = express.Router();

/**
 * POST /api/admin-seed
 * Body: { wallet: string, secret: string }
 * 
 * Creates the first admin record. Requires ADMIN_SETUP_SECRET env var.
 * Once at least one admin exists, the secret check still applies,
 * but you should remove this route from production after bootstrap.
 */
router.post('/', async (req, res) => {
    try {
        const { wallet, secret } = req.body;

        if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
            return res.status(400).json({ error: 'Valid wallet address required' });
        }

        if (!secret) {
            return res.status(400).json({ error: 'Setup secret required' });
        }

        // Verify setup secret
        if (!config.adminSetupSecret) {
            return res.status(503).json({ error: 'Admin setup is not configured on this server.' });
        }

        if (secret !== config.adminSetupSecret) {
            console.warn(`[SECURITY] Invalid admin setup attempt from ${req.ip}`);
            return res.status(401).json({ error: 'Invalid setup secret.' });
        }

        const normalizedWallet = wallet.toLowerCase();

        // Check if already admin
        const existing = await store.findOne('admins', { wallet: normalizedWallet });
        if (existing) {
            return res.status(409).json({ error: 'Wallet is already an admin' });
        }

        const newAdmin = await store.create('admins', {
            wallet: normalizedWallet,
            addedBy: 'SETUP_SECRET',
            addedAt: new Date(),
        });

        console.log(`[ADMIN-SEED] Wallet ${normalizedWallet} promoted to admin via setup secret`);

        res.status(201).json({ 
            success: true, 
            message: 'Admin created successfully. Remove ADMIN_SETUP_SECRET from env to disable this route.',
            admin: { id: newAdmin.id, wallet: newAdmin.wallet }
        });
    } catch (error) {
        console.error('Admin seed error:', error);
        res.status(500).json({ error: 'Failed to create admin' });
    }
});

export default router;
