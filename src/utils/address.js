import { isAddress, getAddress } from 'viem';

/**
 * Normalizes an EVM address using viem.
 * Rejects undefined, null, non-hex strings, and the zero address (0x000...000).
 *
 * @param {string} addr
 * @returns {string|null} Checksummed address, or null if invalid
 */
export function normalizeAddress(addr) {
  if (!addr || typeof addr !== 'string') return null;
  const trimmed = addr.trim();
  if (!isAddress(trimmed, { strict: false })) return null;
  const checksummed = getAddress(trimmed);
  if (checksummed.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return null;
  }
  return checksummed;
}

/**
 * Express-validator custom validator for EVM addresses.
 */
export function isValidEvmAddress(value) {
  if (!value) return false;
  return normalizeAddress(value) !== null;
}
