'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client-returned activation disclosures vs the authority activation maps.
//
// These strings are handed to wallets as the explanation of which acceptance
// rules the chain applies, so a stale one is a wrong answer, not a stale
// comment. The 2026-09-09 ruling armed CONSOLIDATION_LEG_AMOUNT_ACTIVATION and
// GATED_HANDOFF_REF_ACTIVATION at `mainnet: 0`, and moved
// BATCH_COST_WEIGHTING_MAINNET_TIME to 0 (effective mainnet instant
// 2026-08-16T00:00:00Z, through the issuance-limits gate it nests inside), so
// no disclosure may still tell a caller mainnet is unarmed for them.

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');

const OTHER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: 'report', ...opts });
}

const textFor = (r, check) => (r.unverified || [])
    .filter(u => u.check === check)
    .map(u => u.aspect || u.message || u.detail || JSON.stringify(u))
    .join(' ');

describe('pre-flight activation disclosures track the authority maps', function () {

    let report = null;

    before(async function () {
        report = await reportFor(`SEND|0|JDOG|1|${OTHER}`, {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '10' }],
        });
    });

    it('the leg-amount consolidation disclosure is returned and does not call mainnet unarmed', function () {
        const text = textFor(report, 'LEG_AMOUNT_CONSOLIDATION');
        expect(text, 'the disclosure is actually emitted').to.not.equal('');
        expect(text).to.not.match(/not armed|unarmed/i);
        expect(text).to.contain('armed on every network');
    });

    it('the gated-handoff disclosure is returned and does not call mainnet unarmed', function () {
        const text = textFor(report, 'GATED_HANDOFF_REF');
        expect(text, 'the disclosure is actually emitted').to.not.equal('');
        expect(text).to.not.match(/not armed|unarmed/i);
        expect(text).to.contain('armed on every network');
    });
});

// The tick-namespace and token-bridge rows are armed per testnet chain and dark on mainnet.
function issueReport(wire, getToken, coin) {
    const network = { TBTC: 'bitcoin-testnet', BTC: 'bitcoin-mainnet' }[coin];
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), getToken }, network });
    sdk.explorer.coin = coin;
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}

const tickWarning = (r, rule) => (r.findings.find(f => f.code === 'TICK_FORMAT' && f.data && f.data.rule === rule) || {}).message || '';

describe('pre-flight ISSUE disclosures read the tick-namespace and token-bridge mirrors', function () {
    const fresh = () => notFound();
    const mine = () => ({ tick: 'JDOG', owner: 'me' });

    it('a short or reserved-root create on BTC testnet names the armed height', async function () {
        for (const [tick, rule] of [['ABC', 'length'], ['ETH', 'reserved-root']]) {
            const text = tickWarning(await issueReport(`ISSUE|0|${tick}|1000`, fresh, 'TBTC'), rule);
            expect(text, tick).to.contain('armed at height 154567 on this chain');
            expect(text, tick).to.not.match(/neither mainnet nor testnet is armed/);
        }
    });

    it('the same create on mainnet says this chain is not armed', async function () {
        const text = tickWarning(await issueReport('ISSUE|0|ABC|1000', fresh, 'BTC'), 'length');
        expect(text).to.contain('this chain is not armed for it');
        expect(text).to.contain('armed at height 67951140 on DOGE:testnet');
    });

    it('the format-7 activation note carries the pinned per-chain heights', async function () {
        const text = textFor(await issueReport('ISSUE|7|JDOG|DOGE,LTC|6|0', mine, 'TBTC'), 'ISSUE_BRIDGE_ACTIVATION');
        expect(text, 'the disclosure is actually emitted').to.not.equal('');
        expect(text).to.contain('armed at height 154567 on BTC:testnet');
        expect(text).to.not.match(/neither mainnet nor testnet is armed/);
    });
});
