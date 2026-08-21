'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight engine suite: modes, input normalization, report shape,
// tier precedence, and the severity/trust model (spec §4.1-4.3).

const { expect } = require('chai');
const { mockSdk, notFound } = require('./_mock.js');
const { SDKFormatError, SDKPreflightError } = require('../../../src/errors.js');
const { normalizeInput } = require('../../../src/preflight/index.js');
const Actions = require('../../../src/actions.js');
const Utility = require('../../../src/utility.js');
// A real compose core, built directly rather than off mockSdk (which is a
// bare {config} shim): these cases compare the TWO CONSUMERS of that core,
// so the mock plumbing should not sit between them.
const core = new Actions({ config: {}, util: new Utility() });
// Real addresses: createAction VALIDATES and pre-flight does not, so a
// placeholder would fail only one side and mask the comparison.
const A1 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const A2 = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

describe('pre-flight engine', function () {

    describe('modes', function () {
        it('false skips entirely (returns null)', async function () {
            const sdk = mockSdk({ preflight: false });
            expect(await sdk.preflight('SEND|0|JDOG|1|addr')).to.equal(null);
        });

        it('per-call false overrides an enforcing default', async function () {
            const sdk = mockSdk({ preflight: 'enforce' });
            expect(await sdk.preflight('SEND|0|JDOG|1|bad', { preflight: false, source: 's' })).to.equal(null);
        });

        it('enforce throws SDKPreflightError on fail (SDK default mode)', async function () {
            const sdk = mockSdk({ preflight: 'enforce', explorerSpec: null });
            let err;
            try { await sdk.preflight('SEND|0|JDOG|1|not-an-address', { source: 's' }); }
            catch (e) { err = e; }
            expect(err).to.be.instanceof(SDKPreflightError);
            expect(err.code).to.equal('PREFLIGHT_FAIL');
            expect(err.report.verdict).to.equal('fail');
        });

        it('report never throws (SDK default mode)', async function () {
            const sdk = mockSdk({ preflight: 'report', explorerSpec: null });
            const r = await sdk.preflight('SEND|0|JDOG|1|not-an-address', { source: 's' });
            expect(r.verdict).to.equal('fail');
        });

        it('local mode makes zero network calls', async function () {
            let calls = 0;
            const sdk = mockSdk({ explorerSpec: {
                getBalances: () => { calls++; return []; },
                getToken: () => { calls++; return {}; },
                getFeeQuote: () => { calls++; return {}; },
            } });
            const r = await sdk.preflight('SEND|0|JDOG|1|addr', { source: 's', preflight: 'local' });
            expect(calls).to.equal(0);
            expect(r.unverified.length).to.be.greaterThan(0);
        });
    });

    describe('input normalization', function () {
        it('unparseable string throws SDKFormatError, not SDKPreflightError', async function () {
            const sdk = mockSdk();
            let err;
            try { await sdk.preflight('!!!garbage', { preflight: 'local' }); } catch (e) { err = e; }
            expect(err).to.be.instanceof(SDKFormatError);
            expect(err).to.not.be.instanceof(SDKPreflightError);
        });

        it('accepts a ParsedAction directly', async function () {
            const { parse } = require('../../../src/decoder/parse.js');
            const sdk = mockSdk();
            const r = await sdk.preflight(parse('MINT|0|JDOG|5'), { source: 's', preflight: 'local' });
            expect(r).to.have.property('verdict');
        });

        it('accepts an {action, params} object', async function () {
            const sdk = mockSdk();
            const r = await sdk.preflight({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'x' } }, { source: 's', preflight: 'local' });
            expect(r).to.have.property('verdict');
        });

        // The case above used canonical UPPER_SNAKE keys, which is why this
        // gap survived: createAction takes camelCase and normalizes it, so the
        // very same object that composes fine threw UNENCODABLE_INPUT out of
        // pre-flight. A headless consumer on the default 'enforce' mode got an
        // exception where §4.2 promises a verdict. Caught the first time the
        // §8.2 harness ran against a real chain.
        it('accepts camelCase params, exactly as createAction does', async function () {
            const sdk = mockSdk();
            const r = await sdk.preflight(
                { action: 'SEND', params: { tick: 'JDOG', amount: '1', destination: 'x' } },
                { source: 's', preflight: 'local' },
            );
            expect(r).to.have.property('verdict');
        });

        // createAction lets a caller force a format version via params.version
        // (ISSUE create vs edit, STAKE v1 vs v2). Pre-flight read only a
        // top-level version, so a params-level one stayed behind as a bogus
        // VERSION field and an owner's ISSUE EDIT could not be pre-flighted at
        // all. Also found by the §8.2 harness on its first real run.
        it('honours a version forced through params, as createAction does', async function () {
            const sdk = mockSdk();
            const r = await sdk.preflight(
                { action: 'ISSUE', params: { tick: 'JDOG', version: 1, description: 'updated' } },
                { source: 's', preflight: 'local' },
            );
            expect(r).to.have.property('verdict');
        });

        it('normalizes camelCase to the same report as UPPER_SNAKE', async function () {
            const sdk = mockSdk();
            const opts = { source: 's', preflight: 'local' };
            const upper = await sdk.preflight({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'x' } }, opts);
            const camel = await sdk.preflight({ action: 'SEND', params: { tick: 'JDOG', amount: '1', destination: 'x' } }, opts);
            // Same action in two spellings must not produce two verdicts.
            expect(camel.verdict).to.equal(upper.verdict);
            expect(camel.checksRun).to.deep.equal(upper.checksRun);
        });

        // The three cases above were each fixed one at a time, because
        // pre-flight re-implemented a SUBSET of createAction's params ->
        // wire-string core. The cases below pin the unification itself:
        // both entry points now call Actions.composeActionString, so a
        // behaviour added there cannot reach one caller and not the other.
        describe('shares ONE compose core with createAction', function () {

            // The anti-drift assertion. Everything else here is a symptom;
            // this is the property. If these two ever disagree, pre-flight is
            // judging a different action than the one that would broadcast.
            const SAME = [
                ['SEND camelCase',   { action: 'SEND',  params: { tick: 'JDOG', amount: '1', destination: A1 } }],
                ['SEND UPPER_SNAKE', { action: 'SEND',  params: { TICK: 'JDOG', AMOUNT: '1', DESTINATION: A1 } }],
                ['ISSUE forced v1',  { action: 'ISSUE', params: { tick: 'JDOG', version: 1, description: 'updated' } }],
                ['LIST lone item',   { action: 'LIST',  params: { type: 1, item: 'TOKEN1,TOKEN2' } }],
            ];

            SAME.forEach(([label, input]) => {
                it(`derives the same wire string as createAction: ${label}`, function () {
                    const viaCompose  = core.createAction(input).actionString;
                    const viaPreflight = normalizeInput(input, core).actionString;
                    expect(viaPreflight).to.equal(viaCompose);
                });
            });

            // LEGS landed in createAction (multi-leg SEND) while the
            // duplicate path was still live, so it is the behaviour that was
            // next in line to be silently forgotten. It is exercised here as
            // the concrete instance of the general property above.
            it('normalizes LEGS, which the duplicated path never did', function () {
                const sdk = mockSdk();
                const input = {
                    action: 'SEND',
                    params: { tick: 'JDOG', legs: [{ amount: '1', destination: A1 },
                                                   { amount: '2', destination: A2 }] },
                };
                const viaPreflight = normalizeInput(input, core).actionString;
                expect(viaPreflight).to.equal(core.createAction(input).actionString);
                // Both legs must actually reach the wire; the bug this fixed
                // re-emitted leg 1 twice, which is well-formed and wrong.
                expect(viaPreflight).to.contain(A1);
                expect(viaPreflight).to.contain(A2);
            });

            // A top-level `version` is pre-flight's spelling, params.VERSION is
            // createAction's. Both are now read by the shared core, so the two
            // spellings must select the same format.
            it('reads a top-level version and a params VERSION identically', function () {
                const sdk = mockSdk();
                const topLevel = normalizeInput({ action: 'ISSUE', version: 1, params: { tick: 'JDOG', description: 'updated' } }, core);
                const inParams = normalizeInput({ action: 'ISSUE', params: { tick: 'JDOG', version: 1, description: 'updated' } }, core);
                expect(topLevel.actionString).to.equal(inParams.actionString);
                expect(topLevel.version).to.equal(1);
            });

            // The one deliberate difference between the callers, kept as a
            // parameter rather than a divergence: compose throws on invalid
            // fields, pre-flight must still return a verdict (spec §4.2), or a
            // headless consumer gets an exception where it expected a report.
            it('does NOT throw on fields createAction would reject', async function () {
                const sdk = mockSdk();
                const bad = { action: 'SEND', params: { tick: 'JDOG', amount: '-5', destination: 'x' } };
                expect(() => core.createAction(bad)).to.throw();
                const r = await sdk.preflight(bad, { source: 's', preflight: 'local' });
                expect(r).to.have.property('verdict');
            });
        });
    });

    describe('report shape (§4.2)', function () {
        it('has every normative field', async function () {
            const sdk = mockSdk({ explorerSpec: null });
            const r = await sdk.preflight('MINT|0|JDOG|5', { source: 's', preflight: 'local' });
            expect(r).to.include.keys(['schemaVersion', 'verdict', 'restricted', 'checksRun', 'findings', 'unverified', 'quote', 'stateHeight', 'elapsedMs']);
            expect(r.schemaVersion).to.equal(1);
            expect(r.restricted).to.equal(false);
            expect(r.checksRun).to.be.an('array');
        });
    });

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

        // A second case of an undeclared dry-run, found by driving a controller-bound token
        // in a browser: the network was reached, answered promptly, and
        // DECLINED to judge. `/feequote` and `/preflight` refuse to enter a
        // controller guard on the public path (GUARD_INERT ->
        // FEE_QUOTE_CONTROLLER_UNSUPPORTED, xchain-indexer
        // utility._invokeController), because running caller-influenced VM code
        // there would hand an unauthenticated endpoint an unmetered compute
        // primitive. classifyQuote calls that `no-verdict`, and applyTier1 used
        // to push NOTHING for it - so the report was a clean pass, and the
        // wallet's confirm screen read "Looks good" on a SEND the chain then
        // recorded `invalid: controller (reverted)`.
        //
        // The same branch covers the other three no-verdict reasons
        // (denylisted VM actions, fee-exempt replies, unquotable ones), which
        // were all silent in exactly the same way.
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

    describe('severity/trust model (§4.2)', function () {
        it('local-provable errors are non-overridable', async function () {
            const sdk = mockSdk({ explorerSpec: null });
            const r = await sdk.preflight('SEND|0|JDOG|1|not-an-address', { source: 's', preflight: 'local' });
            const f = r.findings.find(x => x.code === 'DEST_ADDRESS_INVALID');
            expect(f.severity).to.equal('error');
            expect(f.overridable).to.equal(false);
        });

        it('network-sourced errors are overridable', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => notFound(),
                getBalances: () => [],
            } });
            const r = await sdk.preflight('SEND|0|MISSING|1|addr', { source: 's', preflight: 'report' });
            const f = r.findings.find(x => x.code === 'TOKEN_NOT_FOUND');
            expect(f.severity).to.equal('error');
            expect(f.overridable).to.equal(true);
        });

        it('a passing report emits DRYRUN_VALID info so tests see why it passed', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                getFeeQuote: () => ({ supported: true, valid: true, status: 'valid', blockIndex: 9 }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|1|addr', { source: 's', preflight: 'report' });
            expect(r.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(true);
            expect(r.stateHeight).to.equal(9);
        });
    });
});
