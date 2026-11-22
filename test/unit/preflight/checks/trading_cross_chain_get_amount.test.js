'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// A cross-chain SWAP's GET_AMOUNT is never checked against a local token row:
// the indexer loads the GET token only when GET_COIN is its own coin.

const { expect } = require('chai');
const { mockSdk } = require('../helpers/mock.js');

const TOKENS = Object.freeze({
    ALPHA: Object.freeze({ info: Object.freeze({ tick: 'ALPHA', tick_id: 7, decimals: 0 }) }),
    BRAVO: Object.freeze({ info: Object.freeze({ tick: 'BRAVO', tick_id: 8, decimals: 0 }) }),
});

const LTC_ADDRESS = 'rltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9';

function wire(action, { giveAmount = '1', getCoin, getAmount }) {
    const address = getCoin === 'BTC' ? '' : LTC_ADDRESS;
    return `${action}|0|BTC|ALPHA|${giveAmount}|0|${getCoin}|BRAVO|${getAmount}|0|${address}||||m`;
}

async function report(action, fields, coin = 'RBTC') {
    const sdk = mockSdk({
        network: 'bitcoin-regtest',
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getToken: (tick) => TOKENS[String(tick)] || null,
            getBalances: () => [{ tick: 'ALPHA', amount: '10' }],
        },
    });
    sdk.explorer.coin = coin;
    return sdk.preflight(wire(action, fields), { source: 'me', preflight: 'report', bypassCache: true });
}

const formatErrors = (result) => result.findings.filter((finding) =>
    finding.code === 'AMOUNT_FORMAT_INVALID' && finding.severity === 'error');
const formatUnverified = (result) => result.unverified.some((entry) => entry.check === 'AMOUNT_FORMAT_INVALID');

describe('pre-flight cross-chain SWAP GET_AMOUNT format', function () {
    it('skips a SWAP GET_AMOUNT whose GET_COIN is another chain', async function () {
        const result = await report('SWAP', { getCoin: 'LTC', getAmount: '0.5' });
        expect(formatErrors(result)).to.deep.equal([]);
    });

    it('still checks a SWAP GET_AMOUNT whose GET_COIN is this chain', async function () {
        const result = await report('SWAP', { getCoin: 'BTC', getAmount: '0.5' });
        expect(formatErrors(result)).to.have.length(1);
    });

    it('keeps skipping a cross-chain ORDER GET_AMOUNT', async function () {
        const result = await report('ORDER', { getCoin: 'LTC', getAmount: '0.5' });
        expect(formatErrors(result)).to.deep.equal([]);
    });

    it('still checks a cross-chain SWAP GIVE_AMOUNT against the local token', async function () {
        const result = await report('SWAP', { giveAmount: '0.5', getCoin: 'LTC', getAmount: '1' });
        expect(formatErrors(result)).to.have.length(1);
    });

    it('keeps the local check on a SWAP with an empty GET_COIN, which the indexer refuses anyway', async function () {
        const result = await report('SWAP', { getCoin: '', getAmount: '0.5' });
        expect(formatErrors(result)).to.have.length(1);
    });

    it('discloses a SWAP GET_AMOUNT as unverified when no chain coin is configured', async function () {
        const result = await report('SWAP', { getCoin: 'LTC', getAmount: '0.5' }, '');
        expect(formatErrors(result)).to.deep.equal([]);
        expect(formatUnverified(result)).to.equal(true);
    });
});
