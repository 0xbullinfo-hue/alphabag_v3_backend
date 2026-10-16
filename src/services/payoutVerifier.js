import { createPublicClient, http, parseAbiItem, parseEventLogs } from 'viem';
import { bsc } from 'viem/chains';
import { config } from '../config/env.js';
import { normalizeAddress } from '../utils/address.js';

export const TRANSFER_EVENT = parseAbiItem(
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
 * Verifies on-chain that an ERC-20 Transfer occurred on BSC from configured treasury to recipient.
 *
 * @param {Object} params
 * @param {string} params.txHash - 64 hex char tx hash with 0x prefix
 * @param {string} params.to - expected recipient address
 * @param {bigint|number|string} params.minAmountWei - minimum amount expected
 * @param {string} [params.tokenAddress] - token contract address (default: config.bagTokenAddress)
 * @param {string} [params.treasuryAddress] - treasury address (default: config.treasuryAddress)
 * @param {number} [params.minConfirmations=12] - minimum confirmations required
 * @param {Object} [params.client] - optional injected Viem client (for tests)
 * @returns {Promise<{ verified: boolean, error?: string, matchingLogs?: Array }>}
 */
export async function verifyTransfer({
  txHash,
  to,
  minAmountWei,
  tokenAddress = config.bagTokenAddress,
  treasuryAddress = config.treasuryAddress,
  minConfirmations = 12,
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

  const normalizedTreasury = normalizeAddress(treasuryAddress);
  if (!normalizedTreasury) {
    return { verified: false, error: 'Treasury address not configured or invalid' };
  }

  const publicClient = client || getBscPublicClient();

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

    if (!receipt || receipt.status !== 'success') {
      return { verified: false, error: 'Transaction failed or receipt not found' };
    }

    if (minConfirmations > 1 && typeof publicClient.getBlockNumber === 'function') {
      const currentBlock = await publicClient.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber + 1n);
      if (confirmations < minConfirmations) {
        return {
          verified: false,
          error: `Insufficient confirmations (${confirmations} < ${minConfirmations})`,
        };
      }
    }

    // Filter logs for this token contract
    const tokenLogs = (receipt.logs || []).filter(
      (log) => log.address && log.address.toLowerCase() === normalizedToken.toLowerCase()
    );

    // Decode logs using viem parseEventLogs to prevent non-Transfer events (e.g. Approval) from matching
    let parsedEvents = [];
    try {
      parsedEvents = parseEventLogs({
        abi: [TRANSFER_EVENT],
        eventName: 'Transfer',
        logs: tokenLogs,
      });
    } catch {
      parsedEvents = [];
    }

    const minAmountBigInt = BigInt(minAmountWei || 0);
    const matchingTransfers = [];

    for (const event of parsedEvents) {
      const fromAddr = normalizeAddress(event.args.from);
      const toAddr = normalizeAddress(event.args.to);
      if (fromAddr === normalizedTreasury && toAddr === normalizedTo) {
        matchingTransfers.push({
          from: fromAddr,
          to: toAddr,
          value: BigInt(event.args.value),
        });
      }
    }

    if (matchingTransfers.length === 0) {
      return {
        verified: false,
        error: 'No matching Transfer events found from treasury to recipient in transaction',
        matchingLogs: [],
      };
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

/**
 * Verifies on-chain that a batch transaction succeeded and parses all ERC-20 transfers
 * originating from the treasury address.
 *
 * @param {Object} params
 * @param {string} params.txHash
 * @param {string} [params.tokenAddress]
 * @param {string} [params.treasuryAddress]
 * @param {number} [params.minConfirmations=12]
 * @param {Object} [params.client]
 * @returns {Promise<{ verified: boolean, error?: string, transfersByRecipient?: Map<string, bigint> }>}
 */
export async function verifyBatchTransfers({
  txHash,
  tokenAddress = config.bagTokenAddress,
  treasuryAddress = config.treasuryAddress,
  minConfirmations = 12,
  client = null,
}) {
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, error: 'Invalid transaction hash format' };
  }

  const normalizedToken = normalizeAddress(tokenAddress);
  if (!normalizedToken) {
    return { verified: false, error: 'Token address not configured or invalid' };
  }

  const normalizedTreasury = normalizeAddress(treasuryAddress);
  if (!normalizedTreasury) {
    return { verified: false, error: 'Treasury address not configured or invalid' };
  }

  const publicClient = client || getBscPublicClient();

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

    if (!receipt || receipt.status !== 'success') {
      return { verified: false, error: 'Transaction failed or receipt not found' };
    }

    if (minConfirmations > 1 && typeof publicClient.getBlockNumber === 'function') {
      const currentBlock = await publicClient.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber + 1n);
      if (confirmations < minConfirmations) {
        return {
          verified: false,
          error: `Insufficient confirmations (${confirmations} < ${minConfirmations})`,
        };
      }
    }

    const tokenLogs = (receipt.logs || []).filter(
      (log) => log.address && log.address.toLowerCase() === normalizedToken.toLowerCase()
    );

    let parsedEvents = [];
    try {
      parsedEvents = parseEventLogs({
        abi: [TRANSFER_EVENT],
        eventName: 'Transfer',
        logs: tokenLogs,
      });
    } catch {
      parsedEvents = [];
    }

    const transfersByRecipient = new Map();

    for (const event of parsedEvents) {
      const fromAddr = normalizeAddress(event.args.from);
      const toAddr = normalizeAddress(event.args.to);
      if (fromAddr === normalizedTreasury && toAddr) {
        const current = transfersByRecipient.get(toAddr) || 0n;
        transfersByRecipient.set(toAddr, current + BigInt(event.args.value));
      }
    }

    return {
      verified: true,
      transfersByRecipient,
      totalTransfers: transfersByRecipient.size,
    };
  } catch (err) {
    return {
      verified: false,
      error: `On-chain verification error: ${err.message}`,
    };
  }
}

