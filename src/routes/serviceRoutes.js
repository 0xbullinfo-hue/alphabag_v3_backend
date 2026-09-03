import express from 'express';
import { getPrices, searchCoins } from '../controllers/marketController.js';
import { tokenPriceController } from '../controllers/tokenPriceController.js';
import { dexController } from '../controllers/dexController.js';
import { getAddressTransactions, getTopHolders, followWhale, getTransactions, getWallets, getTokenTransfers } from '../controllers/whaleController.js';
import { getBriefing, analyzePortfolio, streamNeuralCore } from '../controllers/aiController.js';
import { getHistory, saveSnapshot } from '../controllers/historyController.js';
import { getBalances, streamPortfolio } from '../controllers/portfolioController.js';
import { createConnection, deleteConnection, getBalances as getCexBalances, listConnections } from '../controllers/cexController.js';
import { verifyToken } from '../middleware/authMiddleware.js';

const marketRouter = express.Router();
marketRouter.get('/prices', getPrices);
marketRouter.get('/search', searchCoins);
marketRouter.get('/token-price', tokenPriceController.getTokenPrices);

const dexRouter = express.Router();
dexRouter.get('/search', dexController.searchPairs);
dexRouter.get('/tokens/:tokenAddress', dexController.getTokenPairs);

const whaleRouter = express.Router();
whaleRouter.get('/address/:address/transactions', getAddressTransactions);
whaleRouter.get('/transactions', getTransactions);
whaleRouter.get('/wallets', getWallets);
whaleRouter.get('/transfers', getTokenTransfers);
whaleRouter.get('/top-holders', getTopHolders);
whaleRouter.post('/follow', followWhale);

const aiRouter = express.Router();
aiRouter.post('/briefing', verifyToken, getBriefing);
aiRouter.post('/analyze', verifyToken, analyzePortfolio);
aiRouter.post('/neural-core', verifyToken, streamNeuralCore);

const portfolioRouter = express.Router();
portfolioRouter.get('/history', getHistory);
portfolioRouter.get('/public-balances', getBalances);
portfolioRouter.get('/balances', verifyToken, getBalances);
portfolioRouter.post('/snapshot', saveSnapshot);

const streamRouter = express.Router();
streamRouter.get('/portfolio', streamPortfolio);

const cexRouter = express.Router();
cexRouter.post('/connections', verifyToken, createConnection);
cexRouter.get('/connections', verifyToken, listConnections);
cexRouter.delete('/connections/:connectionId', verifyToken, deleteConnection);
cexRouter.get('/balances', verifyToken, getCexBalances);
cexRouter.post('/connect', verifyToken, createConnection);

export { marketRouter, dexRouter, whaleRouter, aiRouter, portfolioRouter, cexRouter, streamRouter };
