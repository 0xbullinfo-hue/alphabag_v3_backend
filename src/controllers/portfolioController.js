import { blockchainService } from '../services/blockchainService.js';
import { getOrSetCache } from '../utils/cache.js';

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAIN_KEYS = {
    ETH: 'ethereum',
    POLYGON: 'polygon',
    BASE: 'base',
    ARB: 'arbitrum',
};

const formatUnits = (value, decimals = 18) => {
    try {
        const raw = BigInt(value || 0);
        const divisor = 10n ** BigInt(decimals);
        const whole = raw / divisor;
        const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction.slice(0, 12)}` : whole.toString();
    } catch {
        return '0';
    }
};

const normalizeEvmBalances = (chains) => chains.flatMap((chain) => {
    const chainKey = CHAIN_KEYS[chain.chain];
    if (!chainKey) return [];

    const nativeToken = {
        contractAddress: NATIVE_TOKEN_ADDRESS,
        symbol: chain.chain === 'POLYGON' ? 'MATIC' : chain.chain === 'ARB' ? 'ETH' : chain.chain,
        name: chain.chainName,
        chain: chainKey,
        balance: formatUnits(chain.nativeBalance),
        priceUSD: 0,
        valueUSD: 0,
        change24h: 0,
    };

    const tokens = (chain.tokens || []).map((token) => ({
        contractAddress: token.address || NATIVE_TOKEN_ADDRESS,
        symbol: token.symbol || 'UNK',
        name: token.name || 'Unknown Token',
        chain: chainKey,
        balance: formatUnits(token.balance, token.decimals ?? 18),
        priceUSD: 0,
        valueUSD: 0,
        change24h: 0,
        logo: token.logo || undefined,
    }));

    return [nativeToken, ...tokens];
});

export const getBalances = async (req, res) => {
    const { address, chains } = req.query;
    
    if (typeof address !== 'string' || !EVM_ADDRESS_PATTERN.test(address)) {
        return res.status(400).json({ error: 'address must be a valid EVM address' });
    }

    const normalizedAddress = address.toLowerCase();
    const cacheKey = `portfolio_balances_${normalizedAddress}_${chains || 'all'}`;

    try {
        // 30-second RAM cache to eliminate multi-chain API latency
        const result = await getOrSetCache(cacheKey, 30, async () => {
            const balances = await blockchainService.getEvmBalances(address);
            const requestedChains = typeof chains === 'string'
                ? new Set(chains.split(',').map((chain) => chain.trim()).filter(Boolean))
                : null;
            const tokens = normalizeEvmBalances(balances)
                .filter((token) => !requestedChains || requestedChains.has(token.chain));

            return { tokens, updatedAt: new Date().toISOString() };
        });

        res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.json(result.data);
    } catch (err) {
        console.error('PortfolioController: Error fetching balances:', err.message);
        res.status(500).json({ error: 'Failed to fetch blockchain data' });
    }
};

export const getAggregatedPortfolio = async (req, res) => {
    const { address } = req.query;
    if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: 'address is required' });
    }

    const cacheKey = `portfolio_aggregated_${address.toLowerCase()}`;
    try {
        const result = await getOrSetCache(cacheKey, 30, async () => {
            const evmBalances = await blockchainService.getEvmBalances(address);
            return { success: true, data: evmBalances };
        });

        res.set('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

export const streamPortfolio = (req, res) => {
    const rawToken = req.query.token || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].split(' ')[1] : null);
    if (!rawToken) {
        return res.status(401).json({ error: 'Token required for SSE portfolio connection' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    const sendUpdate = () => {
        const payload = JSON.stringify({
            balances: [],
            cexBalances: [],
            timestamp: Date.now(),
        });
        res.write(`data: ${payload}\n\n`);
    };

    sendUpdate();
    const interval = setInterval(sendUpdate, 30000);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
};
