// SPDX-License-Identifier: MIT
// PATCH: authRoutes.js — Wire admin management endpoints

import express from 'express';
import { 
    login, 
    register, 
    getReferrals, 
    getMe, 
    updateProfile, 
    verifyUpgrade, 
    getNonce, 
    verify, 
    logout,
    promoteToAdmin, 
    removeAdmin, 
    listAdmins 
} from '../controllers/authController.js';
import { verifyToken, verifyAdmin } from '../middleware/authMiddleware.js';
import { nonceLimiter, verifyLimiter, authLimiter } from '../middleware/rateLimiters.js';

const router = express.Router();

router.get('/nonce', nonceLimiter, getNonce);
router.post('/verify', verifyLimiter, verify);
router.post('/login', authLimiter, login);
router.post('/logout', verifyToken, logout);
router.post('/register', authLimiter, register);
router.get('/me', verifyToken, getMe);
router.get('/referrals', verifyToken, getReferrals);
router.post('/update-profile', verifyToken, updateProfile);
router.post('/verify-upgrade', verifyToken, verifyUpgrade);

// Admin management (protected by existing admin check)
router.post('/admin/promote', verifyToken, verifyAdmin, promoteToAdmin);
router.post('/admin/remove', verifyToken, verifyAdmin, removeAdmin);
router.get('/admin/list', verifyToken, verifyAdmin, listAdmins);

export default router;
