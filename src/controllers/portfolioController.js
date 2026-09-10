import axios from 'axios';
import { blockchainService } from '../services/blockchainService.js';
import { getOrSetCache } from '../utils/cache.js';

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAIN_KEYS = {
    ETH: 'ethereum',
    BSC: 'bsc',
    POLYGON: 'polygon',
    BASE: 'base',
    ARB: 'arbitrum',
    AVAX: 'avalanche',
};


const NATIVE_GECKO_IDS = {
    ETH: 'ethereum',
    POLYGON: 'matic-network',
    BASE: 'ethereum',
    ARB: 'ethereum',
    BSC: 'binancecoin',
    AVAX: 'avalanche-2'
};

async function fetchNativePrices() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'ethereum,binancecoin,matic-network,avalanche-2',
                vs_currencies: 'usd',
                include_24hr_change: 'true'
            },
            timeout: 5000,
            headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {}
        });
        return res.data || {};
    } catch {
        return {};
    }
}

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

const normalizeEvmBalances = (chains, prices = {}) => chains.flatMap((chain) => {
    const chainKey = CHAIN_KEYS[chain.chain];
    if (!chainKey) return [];

    const geckoId = NATIVE_GECKO_IDS[chain.chain];
    const priceUSD = prices[geckoId]?.usd || 0;
    const change24h = prices[geckoId]?.usd_24h_change || 0;
    const balanceNum = parseFloat(formatUnits(chain.nativeBalance)) || 0;

    const nativeToken = {
        contractAddress: NATIVE_TOKEN_ADDRESS,
        symbol: chain.chain === 'POLYGON' ? 'MATIC' : chain.chain === 'ARB' ? 'ETH' : chain.chain,
        name: chain.chainName,
        chain: chainKey,
        balance: formatUnits(chain.nativeBalance),
        priceUSD,
        valueUSD: balanceNum * priceUSD,
        change24h,
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
            const [balances, prices] = await Promise.all([
                blockchainService.getEvmBalances(address),
                fetchNativePrices()
            ]);
            const requestedChains = typeof chains === 'string'
                ? new Set(chains.split(',').map((chain) => chain.trim()).filter(Boolean))
                : null;
            const tokens = normalizeEvmBalances(balances, prices)
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
            status: 'CONNECTED',
            active: true,
            timestamp: Date.now(),
            message: 'Portfolio event stream established'
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

export const getSolanaPortfolio = async (req, res) => {
    const { address } = req.query;
    if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: 'Solana address is required' });
    }
    try {
        const solBalances = await blockchainService.getSolanaBalances(address);
        if (!solBalances) {
            return res.status(500).json({ error: 'Failed to fetch Solana balances' });
        }
        res.json({ success: true, balances: solBalances });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
