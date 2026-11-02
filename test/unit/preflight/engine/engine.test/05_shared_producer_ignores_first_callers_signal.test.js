'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coalesced pre-flight: the shared producer must not run under the first
// joiner's AbortSignal. One caller's abort stops only that caller's view;
// every other joiner gets the report its own solo run would produce.

const { expect } = require('chai');
const { mockSdk } = require('../../helpers/mock.js');

describe('pre-flight shared producer and caller abort', function () {
    it('aborting the first joiner leaves the second joiner with the full Tier-1 report', async function () {
        let quoteCalls = 0;
        const sdk = mockSdk({ explorerSpec: {
            getToken: () => ({ tick: 'JDOG' }),
            getBalances: () => [{ tick: 'JDOG', amount: '100' }],
            getFeeQuote: async () => {
                quoteCalls++;
                await new Promise(r => setTimeout(r, 80));
                return { supported: true, valid: true, status: 'valid', blockIndex: 500 };
            },
        } });
        const args = 'SEND|0|JDOG|1|addr';
        const acA = new AbortController();
        const acB = new AbortController();
        const pA = sdk.preflight(args, { source: 's', preflight: 'report', signal: acA.signal });
        const pB = sdk.preflight(args, { source: 's', preflight: 'report', signal: acB.signal });
        setTimeout(() => acA.abort(), 20);

        let errA = null;
        try { await pA; } catch (e) { errA = e; }
        expect(errA && errA.message).to.equal('aborted');

        const rB = await pB;
        expect(rB.verdict).to.equal('pass');
        expect(rB.stateHeight).to.equal(500);
        expect(rB.findings.some(f => f.code === 'DRYRUN_UNAVAILABLE')).to.equal(false);
        expect(rB.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(true);
        expect(quoteCalls).to.equal(1);

        const solo = await sdk.preflight(args, { source: 's', preflight: 'report', bypassCache: true });
        expect(rB.verdict).to.equal(solo.verdict);
        expect(rB.stateHeight).to.equal(solo.stateHeight);
    });
});
