'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Intra-BATCH projected-delta suite (spec §4.4/§4.7). The load-bearing
// rule: a legitimate MINT-then-SEND-the-minted batch must NOT
// false-alarm on the SEND leg, because the MINT credited the balance.

const { expect } = require('chai');
const { mockSdk } = require('./_mock.js');

function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: 'report', ...opts });
}

const has = (r, code, sev) => r.findings.some(f => f.code === code && (!sev || f.severity === sev));

describe('pre-flight intra-BATCH projection', function () {

    it('MINT-then-SEND-the-minted does not false-error on the SEND leg', async function () {
        // Start balance 0; MINT 10 credits it; SEND 5 is then covered.
        const r = await reportFor('BATCH|0|MINT|0|JDOG|10;SEND|0|JDOG|5|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '0' }],
        });
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
    });

    it('SEND-more-than-minted still errors', async function () {
        const r = await reportFor('BATCH|0|MINT|0|JDOG|3;SEND|0|JDOG|5|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '0' }],
        });
        // minted 3, balance 0 -> effective 3, send 5 exceeds
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
    });

    it('carries the non-atomicity standing warning', async function () {
        const r = await reportFor('BATCH|0|MINT|0|JDOG|1', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '0' }],
        });
        expect(has(r, 'BATCH_NOT_ATOMIC', 'warning')).to.equal(true);
    });

    it('an unparseable sub-command errors on that command only', async function () {
        const r = await reportFor('BATCH|0|NOPE|0|x;MINT|0|JDOG|1', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [],
        });
        expect(has(r, 'PARSE_INVALID', 'error')).to.equal(true);
        const f = r.findings.find(x => x.code === 'PARSE_INVALID');
        expect(f.data.commandIndex).to.equal(0);
    });

    it('after an unprojectable command, a dependent balance error caps at warning', async function () {
        // ISSUE (mint-supply) is unprojectable; a following SEND that
        // relies on that supply must not hard-block.
        const r = await reportFor('BATCH|0|ISSUE|0|NEWT|1000|1000;SEND|0|NEWT|500|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: (t) => (t === 'NEWT' ? { tick: 'NEWT', decimals: '0' } : null),
            getBalances: () => [{ tick: 'NEWT', amount: '0' }],
        });
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
    });
});
