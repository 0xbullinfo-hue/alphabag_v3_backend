import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAddress, isValidEvmAddress } from '../src/utils/address.js';
import { verifyTransfer } from '../src/services/payoutVerifier.js';

test('normalizeAddress validates, checksums, and rejects zero or invalid addresses', () => {
    // Valid address (checksummed)
    const valid = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    assert.equal(normalizeAddress(valid), '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    assert.equal(isValidEvmAddress(valid), true);

    // Invalid formats
    assert.equal(normalizeAddress('0x123'), null);
    assert.equal(normalizeAddress('tyutyuty'), null);
    assert.equal(normalizeAddress(''), null);
    assert.equal(normalizeAddress(null), null);
    assert.equal(isValidEvmAddress('tyutyuty'), false);

    // Zero address rejection
    const zero = '0x0000000000000000000000000000000000000000';
    assert.equal(normalizeAddress(zero), null);
    assert.equal(isValidEvmAddress(zero), false);
});

test('verifyTransfer rejects malformed txHash and invalid addresses', async () => {
    const res1 = await verifyTransfer({
        txHash: 'invalid-hash',
        to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        minAmountWei: 1000n,
        tokenAddress: '0x1111111111111111111111111111111111111111'
    });
    assert.equal(res1.verified, false);
    assert.match(res1.error, /Invalid transaction hash format/i);

    const res2 = await verifyTransfer({
        txHash: '0x' + 'a'.repeat(64),
        to: 'invalid-addr',
        minAmountWei: 1000n,
        tokenAddress: '0x1111111111111111111111111111111111111111'
    });
    assert.equal(res2.verified, false);
    assert.match(res2.error, /Invalid recipient address/i);
});

test('verifyTransfer parses mock receipt logs correctly', async () => {
    const to = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const token = '0x1111111111111111111111111111111111111111';
    const txHash = '0x' + 'f'.repeat(64);

    const mockClient = {
        getTransactionReceipt: async () => ({
            status: 'success',
            blockNumber: 1000n,
            logs: [
                {
                    address: token,
                    topics: [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        '0x0000000000000000000000009999999999999999999999999999999999999999',
                        '0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045'
                    ],
                    data: '0x00000000000000000000000000000000000000000000000000000000000003e8' // 1000 in hex
                }
            ]
        }),
        getBlockNumber: async () => 1010n
    };

    const result = await verifyTransfer({
        txHash,
        to,
        minAmountWei: 1000n,
        tokenAddress: token,
        treasuryAddress: '0x9999999999999999999999999999999999999999',
        minConfirmations: 5,
        client: mockClient
    });

    assert.equal(result.verified, true);
    assert.equal(result.totalTransferred, 1000n);
});

test('verifyTransfer rejects when no matching logs or insufficient amount', async () => {
    const to = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const token = '0x1111111111111111111111111111111111111111';
    const txHash = '0x' + 'f'.repeat(64);

    const mockClient = {
        getTransactionReceipt: async () => ({
            status: 'success',
            blockNumber: 1000n,
            logs: []
        }),
        getBlockNumber: async () => 1020n
    };

    const result = await verifyTransfer({
        txHash,
        to,
        minAmountWei: 0n,
        tokenAddress: token,
        treasuryAddress: '0x9999999999999999999999999999999999999999',
        client: mockClient
    });

    assert.equal(result.verified, false);
    assert.match(result.error, /No matching Transfer events found/i);
});

test('verifyBatchTransfers decodes multiple recipient transfers', async () => {
    const token = '0x1111111111111111111111111111111111111111';
    const treasury = '0x9999999999999999999999999999999999999999';
    const recipient1 = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const recipient2 = '0x0000000000000000000000000000000000000001';
    const txHash = '0x' + 'e'.repeat(64);

    const mockClient = {
        getTransactionReceipt: async () => ({
            status: 'success',
            blockNumber: 5000n,
            logs: [
                {
                    address: token,
                    topics: [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        '0x0000000000000000000000009999999999999999999999999999999999999999',
                        '0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045'
                    ],
                    data: '0x00000000000000000000000000000000000000000000000000000000000001f4' // 500
                },
                {
                    address: token,
                    topics: [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        '0x0000000000000000000000009999999999999999999999999999999999999999',
                        '0x0000000000000000000000000000000000000000000000000000000000000001'
                    ],
                    data: '0x00000000000000000000000000000000000000000000000000000000000003e8' // 1000
                }
            ]
        }),
        getBlockNumber: async () => 5020n
    };

    const { verifyBatchTransfers } = await import('../src/services/payoutVerifier.js');
    const result = await verifyBatchTransfers({
        txHash,
        tokenAddress: token,
        treasuryAddress: treasury,
        minConfirmations: 12,
        client: mockClient
    });

    assert.equal(result.verified, true);
    assert.equal(result.transfersByRecipient.get(normalizeAddress(recipient1)), 500n);
    assert.equal(result.transfersByRecipient.get(normalizeAddress(recipient2)), 1000n);
});

