'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight engine suite: modes, input normalization, report shape,
// tier precedence, and the severity/trust model (spec §4.1-4.3).

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');
const A1 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const A2 = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

describe('pre-flight engine', function () {

    describe('tier precedence (§4.2)', function () {
        it('Tier-1 valid downgrades a contradicting Tier-2 client error to info', async function () {
            // Token missing (client would error TOKEN_NOT_FOUND) but the
            // dry-run says valid: the server is authoritative.
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => notFound(),
                getBalances: () => [],
                getFeeQuote: () => ({ supported: true, valid: true, status: 'valid', blockIndex: 5 }),
            } });
            const r = await sdk.preflight('SEND|0|MISSING|1|addr', { source: 's', preflight: 'report' });
            const tokenFinding = r.findings.find(f => f.code === 'TOKEN_NOT_FOUND');
            expect(tokenFinding.severity).to.equal('info');
            expect(r.verdict).to.not.equal('fail');
            expect(r.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(true);
        });

        it('Tier-1 invalid adds an overridable dryrun error', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                getFeeQuote: () => ({ supported: true, valid: false, status: 'some-reject' }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|1|addr', { source: 's', preflight: 'report' });
            const dry = r.findings.find(f => f.code === 'DRYRUN_INVALID');
            expect(dry.severity).to.equal('error');
            expect(dry.overridable).to.equal(true);
            expect(dry.source).to.equal('dryrun');
            expect(r.verdict).to.equal('fail');
        });
    });

    describe('tier precedence (§4.2)', function () {
        // §4.7. A dry-run says valid because the CONFIRMED balance
        // covers the send; only the wallet knows another window already
        // committed the same funds. Flattening that to info made the whole
        // reservation ledger invisible in the verdict, so the second window of
        // a live double-spend read "Looks good".
        it('Tier-1 valid degrades a localDelta-derived shortfall to warning, not info', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG', divisible: 0 }),
                getBalances: () => [{ tick: 'JDOG', amount: '1000' }],
                getFeeQuote: () => ({ supported: true, valid: true, status: 'valid', blockIndex: 5 }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|600|addr', {
                source: 's', preflight: 'report', localDeltas: [{ tick: 'JDOG', amount: '600' }],
            });
            const bal = r.findings.find(f => f.code === 'BALANCE_INSUFFICIENT');
            expect(bal.severity).to.equal('warning');
            expect(bal._downgradedBy).to.equal('dryrun-valid-local-delta');
            expect(bal.data.localDeltaApplied).to.equal('600');
            expect(bal.message).to.contain('already committed from this wallet');
            expect(r.verdict).to.equal('warn');       // NOT 'pass' - no clean "Looks good"
        });

        it('Tier-1 valid still flattens a shortfall with no localDeltas behind it', async function () {
            // Same shape without the §4.7 netting: the client and the network
            // disagree about confirmed state, and the network wins as before.
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG', divisible: 0 }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                getFeeQuote: () => ({ supported: true, valid: true, status: 'valid', blockIndex: 5 }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|600|addr', { source: 's', preflight: 'report' });
            const bal = r.findings.find(f => f.code === 'BALANCE_INSUFFICIENT');
            expect(bal.severity).to.equal('info');
            expect(bal._downgradedBy).to.equal('dryrun-valid');
            expect(bal.data).to.not.have.property('localDeltaApplied');
            expect(r.verdict).to.equal('pass');
        });

        it('Tier-1 unavailable leaves Tier-2 errors standing', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => notFound(),
                getBalances: () => [],
                getFeeQuote: () => { throw new Error('down'); },
            } });
            const r = await sdk.preflight('SEND|0|MISSING|1|addr', { source: 's', preflight: 'report' });
            const tokenFinding = r.findings.find(f => f.code === 'TOKEN_NOT_FOUND');
            expect(tokenFinding.severity).to.equal('error');
            expect(r.findings.some(f => f.code === 'DRYRUN_UNAVAILABLE')).to.equal(true);
        });
    });

    describe('tier precedence (§4.2)', function () {
        // The case above has a dry-run that FAILS FAST; the one that
        // bites in production is a dry-run that never answers at all (a cold
        // verdict on a busy venue costs seconds against a 4000ms budget). An
        // otherwise-clean action therefore passes on Tier 2 alone, and the ONLY
        // thing in the report that says the network was never asked is this
        // finding - a consumer that drops it shows a network approval that
        // never happened, which is exactly what the wallet confirm surface did.
        it('a dry-run that never answers still declares itself in the report', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG', divisible: 0 }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                getFeeQuote: () => new Promise(() => {}),   // never resolves
            } });
            const r = await sdk.preflight('SEND|0|JDOG|5|' + A1,
                { source: A2, preflight: 'report', timeoutMs: 200 });

            // Verdict is a clean pass on client checks alone: nothing else in
            // the report distinguishes it from a network-approved pass.
            expect(r.verdict).to.equal('pass');
            expect(r.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(false);

            const unavailable = r.findings.find(f => f.code === 'DRYRUN_UNAVAILABLE');
            expect(unavailable, 'unanswered dry-run must still be stated').to.not.equal(undefined);
            expect(unavailable.source).to.equal('dryrun');
            expect(unavailable.message).to.match(/timeout/i);
        });
    });

    describe('tier precedence (§4.2)', function () {
        // A second case of an undeclared dry-run, for a controller-bound token
        // sent from a browser: the network is reached, answers promptly, and
        // DECLINES to judge. `/feequote` and `/preflight` refuse to enter a
        // controller guard on the public path (GUARD_INERT ->
        // FEE_QUOTE_CONTROLLER_UNSUPPORTED, xchain-indexer
        // utility.invokeController), because running caller-influenced VM code
        // there would hand an unauthenticated endpoint an unmetered compute
        // primitive. classifyQuote calls that `no-verdict`, and if applyTier1
        // pushed NOTHING for it the report would be a clean pass, and the
        // wallet's confirm screen would read "Looks good" on a SEND the chain then
        // records as `invalid: controller (reverted)`.
        //
        // The same branch covers the other three no-verdict reasons
        // (denylisted VM actions, fee-exempt replies, unquotable ones), which
        // would all be silent in exactly the same way.
        it('a dry-run that DECLINES to judge declares itself too', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG', divisible: 0 }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                // The real feequote shape (indexer actions.js computeFeeQuote): the
                // sentinel rides in `status`, copied from the dry-run, while `error`
                // is REWRITTEN into a human sentence that no longer contains it.
                getFeeQuote: () => ({
                    supported: false, valid: false,
                    status: 'FEE_QUOTE_CONTROLLER_UNSUPPORTED',
                    error: 'native fee pre-flight not supported for a controller-bound SEND '
                        + '(pay the fee in XCHAIN)',
                }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|5|' + A1,
                { source: A2, preflight: 'report' });

            // Same shape as the unanswered case: a Tier-2-only pass. The
            // difference a consumer must be able to see is that the network
            // never approved it.
            expect(r.verdict).to.equal('pass');
            expect(r.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(false);

            const declined = r.findings.find(f => f.code === 'DRYRUN_UNAVAILABLE');
            expect(declined, 'a declined dry-run must still be stated').to.not.equal(undefined);
            expect(declined.severity).to.equal('info');
            expect(declined.source).to.equal('dryrun');
            // Named as declined rather than unreachable: the reason is the half
            // that tells a reader the venue is fine and this action is special.
            expect(declined.message).to.match(/declined/i);
            expect(declined.message).to.match(/guardInert/i);
        });
    });

    describe('tier precedence (§4.2)', function () {
        // A guard-inert reply on the /preflight shape, which carries the
        // boolean instead of the string sentinel. Two endpoints, one
        // classification: a fix that only covered the feequote spelling would
        // leave the modern path silent.
        it('the /preflight guardInert boolean declares itself as well', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG', divisible: 0 }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                getFeeQuote: () => ({ supported: true, valid: null, guardInert: true, blockIndex: 11 }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|5|' + A1,
                { source: A2, preflight: 'report' });
            const declined = r.findings.find(f => f.code === 'DRYRUN_UNAVAILABLE');
            expect(declined, 'a guardInert reply must still be stated').to.not.equal(undefined);
            expect(declined.message).to.match(/declined/i);
        });
    });
});
