import test from 'node:test';
import assert from 'node:assert/strict';

import { getBalances } from '../src/controllers/portfolioController.js';
import { blockchainService } from '../src/services/blockchainService.js';

const createResponse = () => ({
    statusCode: 200,
    body: undefined,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(payload) {
        this.body = payload;
        return this;
    },
});

const originalGetEvmBalances = blockchainService.getEvmBalances;

test.afterEach(() => {
    blockchainService.getEvmBalances = originalGetEvmBalances;
});

test('getBalances returns canonical token data for EVM portfolio results', async () => {
    blockchainService.getEvmBalances = async () => [{
        chain: 'ETH',
        chainName: 'Ethereum',
        nativeBalance: '1250000000000000000',
        tokens: [{
            address: '0x1111111111111111111111111111111111111111',
            symbol: 'USDC',
            name: 'USD Coin',
            balance: '5000000',
            decimals: 6,
            logo: 'https://example.test/usdc.png',
        }],
    }];
    const req = { query: { address: '0x1234567890123456789012345678901234567890' } };
    const res = createResponse();

    await getBalances(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.tokens.length, 2);
    assert.equal(res.body.tokens[0].chain, 'ethereum');
    assert.equal(res.body.tokens[0].balance, '1.25');
    assert.equal(res.body.tokens[1].symbol, 'USDC');
    assert.equal(res.body.tokens[1].balance, '5');
    assert.equal(res.body.tokens[1].valueUSD, 0);
    assert.equal(typeof res.body.updatedAt, 'string');
});

test('getBalances rejects an invalid EVM address', async () => {
    const res = createResponse();

    await getBalances({ query: { address: 'invalid' } }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'address must be a valid EVM address');
});
