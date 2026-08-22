
import express from 'express';
import { getPrices, searchCoins } from '../controllers/marketController.js';
import { getTopHolders, followWhale } from '../controllers/whaleController.js';
import { getBriefing, analyzePortfolio, streamNeuralCore } from '../controllers/aiController.js';
import { getHistory, saveSnapshot } from '../controllers/historyController.js';
import { getBalances, streamPortfolio } from '../controllers/portfolioController.js';
import { createConnection, deleteConnection, getBalances as getCexBalances, listConnections } from '../controllers/cexController.js';
import { verifyToken } from '../middleware/authMiddleware.js';

const marketRouter = express.Router();
marketRouter.get('/prices', getPrices);
marketRouter.get('/search', searchCoins);

const whaleRouter = express.Router();
whaleRouter.get('/top-holders', getTopHolders);
whaleRouter.post('/follow', followWhale);

// Auth required: these call the metered Gemini API. Previously
// unauthenticated (and separately duplicated at an unauthenticated
// /api/neural-core path directly in app.js — removed), meaning anyone,
// logged in or not, could trigger billable AI calls with no attribution
// and no per-user usage limiting.
const aiRouter = express.Router();
aiRouter.post('/briefing', verifyToken, getBriefing);
aiRouter.post('/analyze', verifyToken, analyzePortfolio);
aiRouter.post('/neural-core', verifyToken, streamNeuralCore);

const portfolioRouter = express.Router();
portfolioRouter.get('/history', getHistory);
portfolioRouter.get('/balances', verifyToken, getBalances);
portfolioRouter.post('/snapshot', saveSnapshot);

const streamRouter = express.Router();
streamRouter.get('/portfolio', streamPortfolio);

// Existed as a fully-written controller (using ccxt for real signed
// exchange balance reads) but was never mounted to any route. Requires
// auth since it accepts exchange API keys/secrets in the request body.
const cexRouter = express.Router();
cexRouter.post('/connections', verifyToken, createConnection);
cexRouter.get('/connections', verifyToken, listConnections);
cexRouter.delete('/connections/:connectionId', verifyToken, deleteConnection);
cexRouter.get('/balances', verifyToken, getCexBalances);
cexRouter.post('/connect', verifyToken, createConnection);

export { marketRouter, whaleRouter, aiRouter, portfolioRouter, cexRouter, streamRouter };

