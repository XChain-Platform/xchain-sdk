'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, notFound } = require('./helpers/setup.js');
const { mockSdk } = require('../../helpers/mock.js');

// From TICK_NORMALIZE_ACTIVATION an ISSUE caret TICK must be ^<positive decimal id> without
// leading zeroes, or the indexer refuses it as 'invalid: TICK (id)' before the token row is
// read (xchain-indexer src/actions/issue/tick_rules.js validateTickForm). The gate is unarmed
// on mainnet and testnet and armed on a regtest venue by XC_TICK_NORMALIZE_REGTEST_ACTIVATION,
// so the client warns on regtest and testnet and never raises an error.
const NON_CANONICAL = ['^007', '^0', '^+7', '^-7', '^0x10', '^1e3'];
const OTHER_TOKEN = () => ({ tick: 'OTHER', owner: 'me', decimals: 0 });

async function reportOn(network, coin, wire, getToken) {
    const sdk = mockSdk({
        explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), getToken },
        network,
    });
    sdk.explorer.coin = coin;
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}

const normalizeFindings = (r) => r.findings.filter((f) => f.code === 'TICK_FORMAT'
    && f.data && f.data.rule === 'TICK_NORMALIZE');
const noCreateFinding = (r) => r.findings.some((f) => f.code === 'TICK_FORMAT'
    && f.data && f.data.rule === 'ISSUE_CARET_TICK_NO_CREATE');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('ISSUE (caret TICK in the canonical form behind TICK_NORMALIZE)', function () {
        for (const tick of NON_CANONICAL) {
            it(`warns on regtest for the non-canonical caret TICK ${tick}`, async function () {
                const r = await reportOn('bitcoin-regtest', 'RBTC', 'ISSUE|0|' + tick + '|1000', notFound);
                const found = normalizeFindings(r);
                expect(found, tick).to.have.length(1);
                expect(found[0].severity).to.equal('warning');
                expect(found[0].message).to.include('invalid: TICK (id)');
                expect(found[0].message).to.include('XC_TICK_NORMALIZE_REGTEST_ACTIVATION');
            });
        }

        it('names the id refusal first, as the indexer does, instead of the caret create rule', async function () {
            const r = await reportOn('bitcoin-regtest', 'RBTC', 'ISSUE|0|^007|1000', notFound);
            expect(normalizeFindings(r)).to.have.length(1);
            expect(noCreateFinding(r)).to.equal(false);
        });

        it('warns even when the explorer answers the id by number with an existing token', async function () {
            const r = await reportOn('bitcoin-testnet', 'TBTC', 'ISSUE|0|^007|1000', OTHER_TOKEN);
            expect(normalizeFindings(r)).to.have.length(1);
        });

        it('does not warn on mainnet, where the gate is unarmed', async function () {
            const r = await reportOn('bitcoin-mainnet', 'BTC', 'ISSUE|0|^007|1000', notFound);
            expect(normalizeFindings(r)).to.deep.equal([]);
        });

        it('keeps a canonical caret TICK clear of the warning', async function () {
            const r = await reportOn('bitcoin-regtest', 'RBTC', 'ISSUE|0|^7|1000', OTHER_TOKEN);
            expect(normalizeFindings(r)).to.deep.equal([]);
        });

        it('never raises the canonical-form rule as an error', async function () {
            for (const tick of NON_CANONICAL) {
                const r = await reportOn('bitcoin-regtest', 'RBTC', 'ISSUE|0|' + tick + '|1000', notFound);
                expect(r.findings.some((f) => f.code === 'TICK_FORMAT' && f.severity === 'error'), tick).to.equal(false);
            }
        });
    });
});
