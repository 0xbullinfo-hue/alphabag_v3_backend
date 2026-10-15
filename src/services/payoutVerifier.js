import { createPublicClient, http, parseAbiItem } from 'viem';
import { bsc } from 'viem/chains';
import { config } from '../config/env.js';
import { normalizeAddress } from '../utils/address.js';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

/**
 * Creates a Viem public client for BSC.
 * Uses config.rpcUrls.bsc if available.
 */
export function getBscPublicClient(customRpcUrl = null) {
  const rpcUrl = customRpcUrl || config.rpcUrls?.bsc || 'https://binance.llamarpc.com';
  return createPublicClient({
    chain: bsc,
    transport: http(rpcUrl),
  });
}

/**
 * Verifies on-chain that an ERC-20 Transfer occurred on BSC.
 *
 * @param {Object} params
 * @param {string} params.txHash - 64 hex char tx hash with 0x prefix
 * @param {string} params.to - expected recipient address
 * @param {bigint|number|string} params.minAmountWei - minimum amount expected
 * @param {string} [params.tokenAddress] - token contract address (default: config.bagTokenAddress)
 * @param {number} [params.minConfirmations=1] - minimum confirmations required
 * @param {Object} [params.client] - optional injected Viem client (for tests)
 * @returns {Promise<{ verified: boolean, error?: string, matchingLogs?: Array }>}
 */
export async function verifyTransfer({
  txHash,
  to,
  minAmountWei,
  tokenAddress = config.bagTokenAddress,
  minConfirmations = 1,
  client = null,
}) {
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, error: 'Invalid transaction hash format' };
  }

  const normalizedTo = normalizeAddress(to);
  if (!normalizedTo) {
    return { verified: false, error: 'Invalid recipient address' };
  }

  const normalizedToken = normalizeAddress(tokenAddress);
  if (!normalizedToken) {
    return { verified: false, error: 'Token address not configured or invalid' };
  }

  const publicClient = client || getBscPublicClient();

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

    if (!receipt || receipt.status !== 'success') {
      return { verified: false, error: 'Transaction failed or receipt not found' };
    }

    if (minConfirmations > 1) {
      const currentBlock = await publicClient.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber + 1n);
      if (confirmations < minConfirmations) {
        return {
          verified: false,
          error: `Insufficient confirmations (${confirmations} < ${minConfirmations})`,
        };
      }
    }

    // Inspect logs for Transfer(from, to, value)
    const minAmountBigInt = BigInt(minAmountWei || 0);
    const matchingTransfers = [];

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== normalizedToken.toLowerCase()) {
        continue;
      }
      try {
        // topics[0] is the Transfer event signature
        // topics[1] is 'from', topics[2] is 'to'
        if (
          log.topics &&
          log.topics[2] &&
          log.topics[2].slice(26).toLowerCase() === normalizedTo.slice(2).toLowerCase()
        ) {
          const value = BigInt(log.data);
          matchingTransfers.push({
            to: normalizedTo,
            value,
          });
        }
      } catch (parseErr) {
        // Continue parsing next log
      }
    }

    const totalTransferred = matchingTransfers.reduce(
      (acc, item) => acc + item.value,
      0n
    );

    if (totalTransferred < minAmountBigInt) {
      return {
        verified: false,
        error: `Transferred amount ${totalTransferred} is less than required ${minAmountBigInt}`,
        matchingLogs: matchingTransfers,
      };
    }

    return {
      verified: true,
      totalTransferred,
      matchingLogs: matchingTransfers,
    };
  } catch (err) {
    return {
      verified: false,
      error: `On-chain verification error: ${err.message}`,
    };
  }
}
