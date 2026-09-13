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
const { mockSdk } = require('./_mock.js');

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
