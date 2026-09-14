import { ethers } from 'ethers';

const AAWE_V3_REWARDS_CONTROLLER = {
  1:     '0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb',
  137:   '0x929EC64c34a17401F460460D4B9390518E5B473e',
  42161: '0x929EC64c34a17401F460460D4B9390518E5B473e',
  10:    '0x929EC64c34a17401F460460D4B9390518E5B473e',
  8453:  '0xf9F2e89c8347BD96742C6A71c11aB5b5c92f70E0',
};

const CHAIN_IDS = { eth: 1, ethereum: 1, polygon: 137, arbitrum: 42161, optimism: 10, base: 8453 };

const REWARDS_ABI = [
  'function getUserRewards(address[] assets, address user, address reward) view returns (uint256)',
];

async function scanAaveRewards(address, chainId, provider) {
  const rc = AAWE_V3_REWARDS_CONTROLLER[chainId];
  if (!rc) return [];
  const assets = [
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
  ];
  const stkAave = '0x4da27a545c0c5B758a6BA100e3a049001de870f5';
  const c = new ethers.Contract(rc, REWARDS_ABI, provider);
  try {
    const raw = await c.getUserRewards(assets, address, stkAave);
    if (raw > 0n) {
      return [{
        protocol: 'aave-v3',
        chain: chainId,
        symbol: 'stkAAVE',
        amount: ethers.formatUnits(raw, 18),
        usd: 0,
        claimable: true,
      }];
    }
  } catch (err) {
    console.warn('[rewards] aave scan failed', chainId, err.message);
  }
  return [];
}

export async function getDefiRewards(req, res) {
  const { address, chain = 'eth' } = req.query;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'valid address required' });
  }
  const chainId = CHAIN_IDS[String(chain).toLowerCase()];
  if (!chainId) return res.status(400).json({ error: 'unsupported chain' });

  // Default to public RPC fallback if not explicitly configured in env
  const fallbackRpc = {
    1: 'https://cloudflare-eth.com',
    137: 'https://polygon-rpc.com',
    42161: 'https://arb1.arbitrum.io/rpc',
    10: 'https://mainnet.optimism.io',
    8453: 'https://mainnet.base.org',
  };
  const provider = new ethers.JsonRpcProvider(process.env[`RPC_URL_${chainId}`] || fallbackRpc[chainId]);

  const scanners = [scanAaveRewards];
  const results = await Promise.all(
    scanners.map((s) => s(address, chainId, provider).catch(() => [])),
  );
  const rewards = results.flat();

  return res.json({
    success: true,
    chain,
    address,
    rewards,
    totalUsd: rewards.reduce((s, r) => s + (r.usd || 0), 0),
    scannedAt: new Date().toISOString(),
  });
}
