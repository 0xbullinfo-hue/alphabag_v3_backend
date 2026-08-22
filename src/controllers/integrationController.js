import axios from 'axios';
import { config } from '../config/env.js';

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const COVALENT_CHAIN_SLUGS = {
    ethereum: 'eth-mainnet',
    bsc: 'bsc-mainnet',
    polygon: 'matic-mainnet',
    arbitrum: 'arbitrum-mainnet',
    base: 'base-mainnet',
    avalanche: 'avalanche-mainnet',
};

const READ_ONLY_RPC_METHODS = new Set([
    'eth_blockNumber',
    'eth_call',
    'eth_chainId',
    'eth_estimateGas',
    'eth_feeHistory',
    'eth_gasPrice',
    'eth_getBalance',
    'eth_getBlockByHash',
    'eth_getBlockByNumber',
    'eth_getBlockTransactionCountByHash',
    'eth_getBlockTransactionCountByNumber',
    'eth_getCode',
    'eth_getLogs',
    'eth_getStorageAt',
    'eth_getTransactionByBlockHashAndIndex',
    'eth_getTransactionByBlockNumberAndIndex',
    'eth_getTransactionByHash',
    'eth_getTransactionCount',
    'eth_getTransactionReceipt',
    'eth_getUncleByBlockHashAndIndex',
    'eth_getUncleByBlockNumberAndIndex',
    'eth_getUncleCountByBlockHash',
    'eth_getUncleCountByBlockNumber',
    'eth_getProof',
    'eth_maxPriorityFeePerGas',
    'eth_syncing',
    'net_listening',
    'net_peerCount',
    'net_version',
    'web3_clientVersion',
]);

const featureDefaults = {
    disabledPages: [],
    enableTokenGating: false,
    isTeaserMode: false,
    maxPortfolios: 5,
    maxWhales: 5,
    enableAlphaAi: true,
    enableSecurityScanner: true,
};

const parseBoolean = (value, fallback) => {
    if (value === undefined) return fallback;
    return value === 'true';
};

const parseDisabledPages = (value) => {
    if (!value) return [];
    return value.split(',').map((path) => path.trim()).filter((path) => path.startsWith('/'));
};

const rpcError = (id, code, message) => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
});

export const getFeatures = (_req, res) => {
    res.json({
        disabledPages: parseDisabledPages(process.env.DISABLED_PAGES),
        enableTokenGating: parseBoolean(process.env.ENABLE_TOKEN_GATING, featureDefaults.enableTokenGating),
        isTeaserMode: parseBoolean(process.env.IS_TEASER_MODE, featureDefaults.isTeaserMode),
        maxPortfolios: Number(process.env.MAX_PORTFOLIOS) || featureDefaults.maxPortfolios,
        maxWhales: Number(process.env.MAX_WHALES) || featureDefaults.maxWhales,
        enableAlphaAi: parseBoolean(process.env.ENABLE_ALPHA_AI, featureDefaults.enableAlphaAi),
        enableSecurityScanner: parseBoolean(process.env.ENABLE_SECURITY_SCANNER, featureDefaults.enableSecurityScanner),
        updatedAt: new Date().toISOString(),
    });
};

export const getApprovals = async (req, res) => {
    const { address, chain } = req.query;
    const providerChain = COVALENT_CHAIN_SLUGS[chain];

    if (typeof address !== 'string' || !EVM_ADDRESS_PATTERN.test(address)) {
        return res.status(400).json({ error: 'address must be a valid EVM address' });
    }
    if (!providerChain) {
        return res.status(400).json({ error: 'chain must be a supported EVM chain key' });
    }
    if (!config.covalentApiKey) {
        return res.status(503).json({ error: 'Security approvals provider is not configured' });
    }

    try {
        const response = await axios.get(
            `https://api.covalenthq.com/v1/${providerChain}/approvals/${address}/`,
            {
                auth: { username: config.covalentApiKey, password: '' },
                timeout: 10000,
            }
        );
        res.json({
            items: response.data?.data?.items || response.data?.items || [],
            updatedAt: new Date().toISOString(),
        });
    } catch (error) {
        const status = error.response?.status;
        console.error(`[SecurityApprovals] Provider request failed for ${chain}:`, error.message);
        res.status(status && status < 500 ? 502 : 503).json({ error: 'Security approvals provider is unavailable' });
    }
};

export const proxyRpc = async (req, res) => {
    const rpcUrl = config.rpcUrls[req.params.chain];
    const requests = Array.isArray(req.body) ? req.body : [req.body];

    if (!rpcUrl) {
        return res.status(404).json(rpcError(null, -32601, 'Unsupported or unconfigured chain'));
    }
    if (requests.length === 0 || requests.length > 20) {
        return res.status(400).json(rpcError(null, -32600, 'Batch must contain between 1 and 20 requests'));
    }

    for (const request of requests) {
        if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !Array.isArray(request.params)) {
            return res.status(400).json(rpcError(request?.id, -32600, 'Invalid JSON-RPC request'));
        }
        if (!READ_ONLY_RPC_METHODS.has(request.method)) {
            return res.status(403).json(rpcError(request.id, -32601, 'RPC method is not permitted'));
        }
    }

    try {
        const payload = Array.isArray(req.body) ? req.body : req.body;
        const response = await axios.post(rpcUrl, payload, {
            timeout: 10000,
            maxContentLength: 1024 * 1024,
            headers: { 'Content-Type': 'application/json' },
        });
        res.status(response.status).json(response.data);
    } catch (error) {
        const id = Array.isArray(req.body) ? null : req.body?.id;
        console.error(`[RpcProxy] ${req.params.chain} request failed:`, error.message);
        res.status(502).json(rpcError(id, -32000, 'RPC provider is unavailable'));
    }
};