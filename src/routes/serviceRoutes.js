import express from 'express';
import { getPrices, searchCoins, getCoinsMarkets } from '../controllers/marketController.js';
import { tokenPriceController } from '../controllers/tokenPriceController.js';
import { dexController } from '../controllers/dexController.js';
import { getAddressTransactions, getTopHolders, followWhale, unfollowWhale, getFollows, getTransactions, getWallets, getTokenTransfers } from '../controllers/whaleController.js';
import { getBriefing, analyzePortfolio, streamNeuralCore } from '../controllers/aiController.js';
import { getHistory, saveSnapshot } from '../controllers/historyController.js';
import { getBalances, streamPortfolio, getSolanaPortfolio, getNetWorth, getCanonicalPortfolio } from '../controllers/portfolioController.js';
import { getDefiPositions } from '../controllers/defiController.js';
import { createConnection, deleteConnection, getBalances as getCexBalances, listConnections, getTradeHistory, getAccountCoverage } from '../controllers/cexController.js';
import { verifyToken } from '../middleware/authMiddleware.js';

const marketRouter = express.Router();
marketRouter.get('/prices', getPrices);
marketRouter.get('/coins/markets', getCoinsMarkets);
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
whaleRouter.post('/follow', verifyToken, followWhale);
whaleRouter.get('/follows', verifyToken, getFollows);
whaleRouter.delete('/follow/:id', verifyToken, unfollowWhale);

const aiRouter = express.Router();
aiRouter.post('/briefing', verifyToken, getBriefing);
aiRouter.post('/analyze', verifyToken, analyzePortfolio);
aiRouter.post('/neural-core', verifyToken, streamNeuralCore);

const portfolioRouter = express.Router();
portfolioRouter.get('/history', getHistory);
portfolioRouter.get('/public-balances', getBalances);
portfolioRouter.get('/balances', verifyToken, getBalances);
portfolioRouter.get('/net-worth', verifyToken, getNetWorth);
portfolioRouter.get('/canonical', verifyToken, getCanonicalPortfolio);
portfolioRouter.get('/defi', getDefiPositions);
portfolioRouter.get('/solana', getSolanaPortfolio);
portfolioRouter.post('/snapshot', saveSnapshot);

const streamRouter = express.Router();
streamRouter.get('/portfolio', streamPortfolio);

const cexRouter = express.Router();
cexRouter.post('/connections', verifyToken, createConnection);
cexRouter.get('/connections', verifyToken, listConnections);
cexRouter.delete('/connections/:connectionId', verifyToken, deleteConnection);
cexRouter.get('/balances', verifyToken, getCexBalances);
cexRouter.post('/connect', verifyToken, createConnection);
cexRouter.get('/trades', verifyToken, getTradeHistory);
cexRouter.get('/coverage', verifyToken, getAccountCoverage);

export { marketRouter, dexRouter, whaleRouter, aiRouter, portfolioRouter, cexRouter, streamRouter };
