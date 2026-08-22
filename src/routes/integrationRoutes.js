import express from 'express';
import { getApprovals, getFeatures, proxyRpc } from '../controllers/integrationController.js';
import { verifyToken } from '../middleware/authMiddleware.js';

const configRouter = express.Router();
configRouter.get('/features', getFeatures);

const securityRouter = express.Router();
securityRouter.get('/approvals', verifyToken, getApprovals);

const rpcRouter = express.Router();
rpcRouter.post('/:chain', proxyRpc);

export { configRouter, rpcRouter, securityRouter };