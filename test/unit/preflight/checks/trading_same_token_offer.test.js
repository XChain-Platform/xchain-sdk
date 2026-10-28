'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk } = require('../helpers/mock.js');

const TOKENS = Object.freeze({
    ALPHA: Object.freeze({ info: Object.freeze({ tick: 'ALPHA', tick_id: 7, decimals: 0 }) }),
    BRAVO: Object.freeze({ info: Object.freeze({ tick: 'BRAVO', tick_id: 8, decimals: 0 }) }),
});

function getToken(tick) {
    const search = String(tick);
    if (search === '^7') return TOKENS.ALPHA;
    // The explorer looks a name up exactly (index_tickers is utf8mb4_bin), so the mock does too.
    return TOKENS[search] || null;
}

function wire(action, giveTick, getTick, getCoin = 'BTC') {
    return `${action}|0|BTC|${giveTick}|1|0|${getCoin}|${getTick}|1|0|||||m`;
}

async function report(action, giveTick, getTick, opts = {}) {
    const quote = { feeExempt: true };
    if (Object.prototype.hasOwnProperty.call(opts, 'height')) quote.blockIndex = opts.height;
    const sdk = mockSdk({
        network: opts.network || 'bitcoin-regtest',
        explorerSpec: {
            getFeeQuote: () => quote,
            getToken: opts.getToken || getToken,
            getBalances: () => [{ tick: 'ALPHA', amount: '10' }, { tick: 'BRAVO', amount: '10' }],
        },
    });
    sdk.explorer.coin = opts.coin || 'RBTC';
    return sdk.preflight(wire(action, giveTick, getTick, opts.getCoin),
        { source: 'me', preflight: 'report', bypassCache: true });
}

const sameTokenErrors = (result) => result.findings.filter((finding) =>
    finding.code === 'VALIDATOR_SEMANTICS'
    && finding.severity === 'error'
    && finding.message.includes('invalid: cannot trade a token for itself'));

const sameTokenDisclosure = (result) => result.unverified.some((entry) =>
    entry.check === 'VALIDATOR_SEMANTICS' && entry.reason.includes('same-token offer check'));
const errors = (result) => result.findings.filter((finding) => finding.severity === 'error');

describe('pre-flight ORDER and SWAP same-token offer refusal', function () {
    for (const action of ['ORDER', 'SWAP']) {
        it(`${action} refuses the same token name on both sides when the height gate is active`, async function () {
            const result = await report(action, 'ALPHA', 'ALPHA', { height: 0 });
            expect(sameTokenErrors(result)).to.have.length(1);
            expect(sameTokenErrors(result)[0].overridable).to.equal(false);
            // A no-verdict quote height feeds the gate but is not reported as the checked state.
            expect(result.stateHeight).to.equal(null);
        });
    }

    it('leaves a case-variant name to the indexer, since the explorer lookup is exact', async function () {
        const result = await report('ORDER', 'ALPHA', 'alpha', { height: 1 });
        expect(sameTokenErrors(result)).to.deep.equal([]);
    });

    it('refuses a caret alias that resolves to the named token id', async function () {
        const result = await report('SWAP', 'ALPHA', '^7', { height: 1 });
        expect(sameTokenErrors(result)).to.have.length(1);
    });

    it('accepts two distinct resolved token ids', async function () {
        const result = await report('ORDER', 'ALPHA', 'BRAVO', { height: 1 });
        expect(errors(result)).to.deep.equal([]);
        expect(result.unverified.some((entry) => entry.reason.includes('same-token offer check'))).to.equal(false);
    });

    it('accepts equal token ids while the network is unarmed', async function () {
        const result = await report('SWAP', 'ALPHA', '^7', {
            height: 200000, network: 'bitcoin-testnet', coin: 'TBTC',
        });
        expect(errors(result)).to.deep.equal([]);
        expect(sameTokenDisclosure(result)).to.equal(false);
    });

    it('discloses an unknown target height without refusing', async function () {
        const result = await report('ORDER', 'ALPHA', 'ALPHA');
        expect(errors(result)).to.deep.equal([]);
        expect(sameTokenDisclosure(result)).to.equal(true);
        expect(result.stateHeight).to.equal(null);
    });

    it('discloses a failed token lookup without refusing', async function () {
        const result = await report('SWAP', 'ALPHA', 'BRAVO', {
            height: 0,
            getToken: (tick) => {
                if (tick === 'BRAVO') throw new Error('token endpoint unavailable');
                return getToken(tick);
            },
        });
        expect(errors(result)).to.deep.equal([]);
        expect(sameTokenDisclosure(result)).to.equal(true);
    });

    it('does not compare a cross-chain SWAP GET token locally', async function () {
        const result = await report('SWAP', 'ALPHA', 'ALPHA', { height: 0, getCoin: 'LTC' });
        expect(errors(result)).to.deep.equal([]);
        expect(sameTokenDisclosure(result)).to.equal(false);
    });
});
