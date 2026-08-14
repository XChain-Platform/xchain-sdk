'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BATCH reaches Tier 1, and its per-sub-command verdict is read correctly
// (spec batch-issuance-limits row 55, completing the indexer half in row 46).
//
// Two things are under test and only the second is interesting.
//
// The first is the door: BATCH used to short-circuit in runTier1 on
// TIER1_DENYLIST before any network call, so the /preflight endpoint the
// indexer built for it was unreachable from every client.
//
// The second is why opening that door NAIVELY would have been worse than
// leaving it shut. The arbiter answers a batch at TWO levels, and the outer
// one is not a verdict on the inner ones: `valid:true` means the transaction
// is accepted and its commands run, not that any command succeeds. Every
// fixture below is a shape MEASURED against a live BTC regtest indexer
// carrying the row-46 code (2026-08-13, blockIndex 14513), not invented:
//
//   BATCH|0|SEND|0|NOSUCHTOKENXYZ|1|<addr>
//     -> valid:true, status:"valid",
//        subCommands:[{position:0,action:"SEND",status:"invalid: TICK (unknown)",refused:null}]
//   BATCH|0|COINPAY|0|999999;SEND|0|XCHAIN|1|<addr>
//     -> valid:true, subCommands:[{position:0,action:"COINPAY",status:null,refused:null},
//                                 {position:1,action:"SEND",status:"valid",refused:null}]
//   BATCH|0|SEND|...;DEPLOY|0|Zm9v
//     -> supported:false, denied:true, deniedSubAction:"DEPLOY"
//
// The first of those is the trap: without the per-command precedence rule the
// SDK would have pushed DRYRUN_VALID and demoted its OWN TOKEN_NOT_FOUND error
// to info, rendering a clean network approval for a batch that does nothing.

const { expect } = require('chai');
const { runTier1, normalizeSubCommands } = require('../../../src/preflight/tier1.js');
const { applyTier1, computeVerdict } = require('../../../src/preflight/index.js');
const { parse } = require('../../../src/decoder/parse.js');
const constants = require('../../../src/preflight/constants.js');
const { mockSdk } = require('./_mock.js');

const FC = constants.FINDING_CODES;
const BATCH_WIRE = 'BATCH|0|SEND|0|JDOG|1|addr;SEND|0|JDOG|2|addr2';

function sdkWithPreflight(impl, feeQuoteImpl) {
    const explorer = { getPreflight: async (a, o) => impl(a, o) };
    if (feeQuoteImpl) explorer.getFeeQuote = async (a) => feeQuoteImpl(a);
    return { explorer };
}

async function tier1(wire, sdk) {
    return runTier1({ sdk, parsed: parse(wire, { validate: false }), source: 's', timeoutMs: 1000 });
}

// A finding as Tier 2 emits one: client-sourced, error, optionally tagged with
// the sub-command it came from (CheckContext.addFinding stamps commandIndex).
function clientError(code, commandIndex) {
    const data = {};
    if (commandIndex !== undefined) data.commandIndex = commandIndex;
    return { code, severity: 'error', source: 'client', overridable: false, message: 'x', data };
}

function verdictWith(subCommands, extra) {
    return Object.assign({ kind: 'verdict', valid: true, status: 'valid', error: null,
        quote: {}, blockIndex: 1, subCommands, oracleFeesOwed: null }, extra || {});
}

function codes(findings, code) {
    return findings.filter((f) => f.code === code);
}

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

    describe('the door: BATCH reaches the endpoint', function () {

        it('BATCH is on TIER1_DENYLIST and ALSO on TIER1_SUBCOMMAND_PREFLIGHT', function () {
            // The denylist keeps mirroring the indexer literal byte for byte
            // (bin/check-preflight-drift.js binds it by value, and /feequote really
            // does still refuse a batch). The exception is a separate named fact
            // about a different endpoint, not a hole punched in the mirror.
            expect(constants.TIER1_DENYLIST).to.include('BATCH');
            expect(constants.TIER1_SUBCOMMAND_PREFLIGHT).to.deep.equal(['BATCH']);
        });

        it('calls /preflight for BATCH instead of short-circuiting', async function () {
            let called = null;
            const out = await tier1(BATCH_WIRE, sdkWithPreflight((args) => {
                called = args;
                return { supported: true, valid: true, status: 'valid', blockIndex: 14513,
                    subCommands: [{ position: 0, action: 'SEND', status: 'valid', refused: null },
                        { position: 1, action: 'SEND', status: 'valid', refused: null }] };
            }));
            expect(called, 'the endpoint was called').to.not.equal(null);
            expect(called.action).to.equal('BATCH');
            // The wire params are everything after BATCH|, semicolons intact.
            expect(called.params).to.equal('0|SEND|0|JDOG|1|addr;SEND|0|JDOG|2|addr2');
            expect(out.kind).to.equal('verdict');
            expect(out.valid).to.equal(true);
            expect(out.subCommands).to.have.length(2);
        });

        it('the other denylisted actions still never call the endpoint', async function () {
            // Driven off TIER1_DENYLIST itself rather than a hand-typed list, so an
            // action added to it is covered here without anyone remembering to. The
            // parsed action is synthesized because the guard reads `parsed.action`
            // and nothing else, and the SDK decoder does not parse every name on the
            // list (XEXEC has no wire FORMAT here) - a wire fixture would silently
            // test the parser instead of the guard.
            for (const action of constants.TIER1_DENYLIST) {
                if (constants.TIER1_SUBCOMMAND_PREFLIGHT.includes(action)) continue;
                let called = false;
                const out = await runTier1({
                    sdk: sdkWithPreflight(() => { called = true; return {}; }),
                    parsed: { ok: true, action, actionString: action + '|0|x' },
                    source: 's', timeoutMs: 1000 });
                expect(out.kind, action).to.equal('no-verdict');
                expect(out.reason, action).to.equal('denylisted');
                expect(called, action + ' must not reach the network').to.equal(false);
            }
        });

        it('does NOT fall back to /feequote for BATCH when /preflight is absent', async function () {
            // /feequote refuses a batch deliberately and permanently, so the fallback
            // would spend a round trip to learn nothing. An explorer that predates the
            // door degrades to exactly the old behaviour: no-verdict, Tier 2 stands.
            let feeQuoteCalled = false;
            const out = await runTier1({
                sdk: { explorer: { getFeeQuote: async () => { feeQuoteCalled = true; return {}; } } },
                parsed: parse(BATCH_WIRE, { validate: false }), source: 's', timeoutMs: 1000 });
            expect(feeQuoteCalled).to.equal(false);
            expect(out.kind).to.equal('no-verdict');
            expect(out.reason).to.equal('denylisted');
        });

        it('a 404 from /preflight also degrades to no-verdict without a feequote call', async function () {
            let feeQuoteCalled = false;
            const out = await tier1(BATCH_WIRE, sdkWithPreflight(
                () => { const e = new Error('nf'); e.code = 'EXPLORER_HTTP_404'; throw e; },
                () => { feeQuoteCalled = true; return {}; }));
            expect(feeQuoteCalled).to.equal(false);
            expect(out.kind).to.equal('no-verdict');
            expect(out.reason).to.equal('denylisted');
        });
    });

    describe('a refused sub-action is a clear answer, not a bare refusal', function () {

        it('names the sub-action in the reason and on the outcome', async function () {
            const out = await tier1(BATCH_WIRE, sdkWithPreflight(() => ({
                supported: false, denied: true, valid: null, deniedSubAction: 'DEPLOY',
                error: 'BATCH is not available on the public pre-flight endpoint with a DEPLOY sub-command' })));
            expect(out.kind).to.equal('no-verdict');
            expect(out.reason).to.equal('denylisted sub-action DEPLOY');
            expect(out.deniedSubAction).to.equal('DEPLOY');
        });

        it('reaches the caller as a disclosure, never a crash or a silent pass', function () {
            const findings = applyTier1([],
                { kind: 'no-verdict', reason: 'denylisted sub-action XCALL', deniedSubAction: 'XCALL' });
            const notice = codes(findings, FC.DRYRUN_UNAVAILABLE);
            expect(notice).to.have.length(1);
            expect(notice[0].message).to.contain('XCALL');
            expect(notice[0].message).to.contain('declined to judge');
            // Structured too, so a confirm screen can point at the command.
            expect(notice[0].data.deniedSubAction).to.equal('XCALL');
            // Nothing here may read as an approval.
            expect(codes(findings, FC.DRYRUN_VALID)).to.have.length(0);
        });

        it('a denied response with no sub-action name keeps the plain reason', async function () {
            const out = await tier1(BATCH_WIRE, sdkWithPreflight(
                () => ({ supported: false, denied: true, valid: null })));
            expect(out.reason).to.equal('denylisted');
            expect(out.deniedSubAction).to.equal(undefined);
        });
    });

    describe('normalizing the arbiter sub-command list', function () {

        it('fills a missing position from the array index', function () {
            const subs = normalizeSubCommands([{ action: 'SEND', status: 'valid' }, { action: 'MINT', status: 'valid' }]);
            expect(subs.map((s) => s.position)).to.deep.equal([0, 1]);
        });

        it('an absent or empty list is null, not an empty verdict set', function () {
            expect(normalizeSubCommands(undefined)).to.equal(null);
            expect(normalizeSubCommands([])).to.equal(null);
            expect(normalizeSubCommands('nope')).to.equal(null);
        });

        it('a non-string status is null (unjudged), never coerced to a verdict', function () {
            const subs = normalizeSubCommands([{ position: 0, action: 'COINPAY', status: null, refused: null }]);
            expect(subs[0].status).to.equal(null);
            expect(subs[0].refused).to.equal(null);
        });
    });

    describe('the trap: a valid BATCH does NOT mean its commands succeed', function () {

        it('an invalid sub-command under valid:true is an ERROR, so the verdict fails', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'SEND', status: 'invalid: TICK (unknown)', refused: null }]));
            const bad = codes(findings, FC.DRYRUN_SUBCOMMAND_INVALID);
            expect(bad).to.have.length(1);
            expect(bad[0].severity).to.equal('error');
            expect(bad[0].overridable).to.equal(true);
            expect(bad[0].data.commandIndex).to.equal(0);
            expect(bad[0].message).to.contain('invalid: TICK (unknown)');
            expect(computeVerdict(findings)).to.equal('fail');
        });

        it('the DRYRUN_VALID headline says the batch was accepted but not every command', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'SEND', status: 'valid', refused: null },
                    { position: 1, action: 'SEND', status: 'invalid: insufficient funds', refused: null }]));
            const head = codes(findings, FC.DRYRUN_VALID);
            expect(head).to.have.length(1);
            expect(head[0].message).to.contain('NOT every command');
            expect(head[0].data).to.deep.equal({ subCommandCount: 2, accepted: 1 });
        });

        it('all sub-commands valid reads as a clean acceptance', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'SEND', status: 'valid', refused: null },
                    { position: 1, action: 'SEND', status: 'valid', refused: null }]));
            expect(codes(findings, FC.DRYRUN_SUBCOMMAND_INVALID)).to.have.length(0);
            expect(codes(findings, FC.DRYRUN_VALID)[0].message).to.contain('all 2 of its commands');
            expect(computeVerdict(findings)).to.equal('pass');
        });

        it('a non-BATCH verdict is untouched: no sub-command findings, old headline', function () {
            const findings = applyTier1([clientError(FC.TOKEN_NOT_FOUND)],
                { kind: 'verdict', valid: true, status: 'valid', quote: {}, blockIndex: 1,
                    subCommands: null, oracleFeesOwed: null });
            expect(codes(findings, FC.DRYRUN_VALID)[0].message)
                .to.equal('The network dry-run accepted this action.');
            expect(codes(findings, FC.DRYRUN_SUBCOMMAND_INVALID)).to.have.length(0);
            // The pre-existing blanket downgrade still applies with no sub-verdicts.
            expect(findings[0].severity).to.equal('info');
        });
    });

    describe('an UNJUDGED sub-command is neither a pass nor a failure', function () {

        // This is the multi-payee COINPAY case, and getting it wrong in either
        // direction is a real defect. The probe carries no settlement outputs
        // (the synthetic tx's tx_outputs holds only the injected fee output), so
        // coinpay.js resolves no payee output and returns without recording a
        // status. Calling that "invalid" would manufacture the exact false
        // negative the indexer's row 30 removed; calling it "valid" would let the
        // network's silence override a real client-side error.
        it('status:null is an info disclosure, never an error', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'COINPAY', status: null, refused: null },
                    { position: 1, action: 'SEND', status: 'valid', refused: null }]));
            expect(codes(findings, FC.DRYRUN_SUBCOMMAND_INVALID)).to.have.length(0);
            const un = codes(findings, FC.DRYRUN_SUBCOMMAND_UNJUDGED);
            expect(un).to.have.length(1);
            expect(un[0].severity).to.equal('info');
            expect(un[0].data.commandIndex).to.equal(0);
            expect(un[0].message).to.contain('did not judge batch command 1');
            expect(computeVerdict(findings)).to.equal('pass');
        });

        it('a VM-refused sub-command reports the arbiter refusal text', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'VOTE', status: null,
                    refused: 'VM action not dispatched on the public pre-flight' }]));
            const un = codes(findings, FC.DRYRUN_SUBCOMMAND_UNJUDGED);
            expect(un).to.have.length(1);
            expect(un[0].message).to.contain('VM action not dispatched');
            expect(un[0].data.refused).to.contain('VM action not dispatched');
        });

        it('an unjudged command does NOT count as accepted in the headline', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'COINPAY', status: null, refused: null },
                    { position: 1, action: 'SEND', status: 'valid', refused: null }]));
            expect(codes(findings, FC.DRYRUN_VALID)[0].data).to.deep.equal(
                { subCommandCount: 2, accepted: 1 });
        });
    });

    describe('per-command precedence: Tier 1 outranks Tier 2 only where it judged', function () {

        it('a client error on a command the network ACCEPTED is downgraded', function () {
            const f = clientError(FC.TOKEN_NOT_FOUND, 1);
            const findings = applyTier1([f], verdictWith(
                [{ position: 0, action: 'SEND', status: 'valid', refused: null },
                    { position: 1, action: 'SEND', status: 'valid', refused: null }]));
            expect(f.severity).to.equal('info');
            expect(f._downgradedBy).to.equal('dryrun-valid');
            expect(computeVerdict(findings)).to.equal('pass');
        });

        it('a client error on a command the network REJECTED stays an error', function () {
            const f = clientError(FC.TOKEN_NOT_FOUND, 0);
            const findings = applyTier1([f], verdictWith(
                [{ position: 0, action: 'SEND', status: 'invalid: TICK (unknown)', refused: null }]));
            expect(f.severity).to.equal('error');
            expect(f._downgradedBy).to.equal(undefined);
            expect(computeVerdict(findings)).to.equal('fail');
        });

        it('a client error on a command the network did NOT JUDGE stays an error', function () {
            // The whole point of the third bucket: silence is not approval, so the
            // SDK's own check remains the only verdict there is for that command.
            const f = clientError(FC.BALANCE_INSUFFICIENT, 0);
            const findings = applyTier1([f], verdictWith(
                [{ position: 0, action: 'COINPAY', status: null, refused: null }]));
            expect(f.severity).to.equal('error');
            expect(computeVerdict(findings)).to.equal('fail');
        });

        it('a batch-LEVEL client error is outranked only when every command is valid', function () {
            const ok = clientError(FC.BALANCE_INSUFFICIENT);
            applyTier1([ok], verdictWith(
                [{ position: 0, action: 'SEND', status: 'valid', refused: null }]));
            expect(ok.severity, 'all-valid downgrades the batch-level error').to.equal('info');

            const kept = clientError(FC.BALANCE_INSUFFICIENT);
            applyTier1([kept], verdictWith(
                [{ position: 0, action: 'SEND', status: 'valid', refused: null },
                    { position: 1, action: 'ISSUE', status: 'invalid: GAS (insufficient)', refused: null }]));
            expect(kept.severity, 'one bad command keeps the batch-level error').to.equal('error');
        });

        it('a localDeltas finding on an accepted command still degrades to warning, not info', function () {
            // §4.7 exception, preserved through the new per-command gate.
            const f = clientError(FC.BALANCE_INSUFFICIENT, 0);
            f.data.localDeltaApplied = '5';
            applyTier1([f], verdictWith([{ position: 0, action: 'SEND', status: 'valid', refused: null }]));
            expect(f.severity).to.equal('warning');
            expect(f._downgradedBy).to.equal('dryrun-valid-local-delta');
            expect(f.overridable).to.equal(undefined);
        });

        it('the sub-command findings this pass adds are never themselves downgraded', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'SEND', status: 'invalid: TICK (unknown)', refused: null }]));
            expect(codes(findings, FC.DRYRUN_SUBCOMMAND_INVALID)[0].severity).to.equal('error');
        });
    });

    describe('oracle fees are disclosed, not judged', function () {

        it('a per-oracle total becomes an info finding naming the amount and address', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'DISPENSER', status: 'valid', refused: null }],
                { oracleFeesOwed: { mwesY17M4Wmn5K9Vqf8T1JaBdPL6tjmdDf: '0.00020000' } }));
            const owed = codes(findings, FC.DRYRUN_ORACLE_FEES_OWED);
            expect(owed).to.have.length(1);
            expect(owed[0].severity).to.equal('info');
            expect(owed[0].message).to.contain('0.00020000');
            expect(owed[0].message).to.contain('mwesY17M4Wmn5K9Vqf8T1JaBdPL6tjmdDf');
            expect(owed[0].data.oracleFeesOwed).to.deep.equal(
                { mwesY17M4Wmn5K9Vqf8T1JaBdPL6tjmdDf: '0.00020000' });
            // Disclosure only: it must not move the verdict.
            expect(computeVerdict(findings)).to.equal('pass');
        });

        it('no oracleFeesOwed means no finding', function () {
            const findings = applyTier1([], verdictWith(
                [{ position: 0, action: 'SEND', status: 'valid', refused: null }]));
            expect(codes(findings, FC.DRYRUN_ORACLE_FEES_OWED)).to.have.length(0);
        });

        it('tier1 refuses a non-object oracleFeesOwed rather than passing it on', async function () {
            const out = await tier1(BATCH_WIRE, sdkWithPreflight(() => ({
                supported: true, valid: true, status: 'valid',
                subCommands: [{ position: 0, action: 'SEND', status: 'valid', refused: null }],
                oracleFeesOwed: ['not', 'an', 'object'] })));
            expect(out.oracleFeesOwed).to.equal(null);
        });
    });

    // The unit cases above drive applyTier1 directly. These drive the whole
    // engine, because the thing that would have gone wrong is an INTERACTION:
    // Tier 1's outer valid:true meeting Tier 2's per-command findings inside
    // one report.
    describe('end to end through sdk.preflight()', function () {

        const A = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

        function sdkFor(subCommands, extra) {
            return mockSdk({ preflight: 'report', explorerSpec: { getPreflight:
                Object.assign({ supported: true, valid: true, status: 'valid', blockIndex: 14513,
                    subCommands }, extra || {}) } });
        }

        it('THE TRAP: a batch whose only command the chain rejects does not report a pass', async function () {
            // Measured shape, BTC regtest 2026-08-13: this exact wire answers
            // valid:true / status:"valid" with one invalid sub-command. Before the
            // per-command rule the report was verdict 'pass' carrying DRYRUN_VALID,
            // i.e. a clean network approval for a batch that does nothing at all -
            // strictly worse than the no-verdict refusal it replaced.
            const sdk = sdkFor([{ position: 0, action: 'SEND',
                status: 'invalid: TICK (unknown)', refused: null }]);
            const r = await sdk.preflight('BATCH|0|SEND|0|NOSUCHTOKENXYZ|1|' + A, { source: A });
            expect(r.verdict).to.equal('fail');
            const bad = codes(r.findings, FC.DRYRUN_SUBCOMMAND_INVALID);
            expect(bad).to.have.length(1);
            expect(bad[0].data.commandIndex).to.equal(0);
            expect(codes(r.findings, FC.DRYRUN_VALID)[0].data.accepted).to.equal(0);
        });

        it('a fully accepted batch still reports a pass', async function () {
            const sdk = sdkFor([{ position: 0, action: 'SEND', status: 'valid', refused: null },
                { position: 1, action: 'SEND', status: 'valid', refused: null }]);
            const r = await sdk.preflight('BATCH|0|SEND|0|JDOG|1|' + A + ';SEND|0|JDOG|2|' + A, { source: A });
            expect(r.verdict).to.equal('warn');   // BATCH_NOT_ATOMIC is a standing warning
            expect(codes(r.findings, FC.DRYRUN_SUBCOMMAND_INVALID)).to.have.length(0);
            expect(codes(r.findings, FC.DRYRUN_VALID)[0].data.accepted).to.equal(2);
        });

        it('a local error is outranked on the command the network ACCEPTED, not on the batch', async function () {
            // Sharpens the §4.7 rule: the parser tags its per-command findings with
            // the sub-command they came from, so a bad address in command 1 is judged
            // against the network's answer for command 1 - not against whether some
            // OTHER command in the same batch happened to fail.
            const wire = 'BATCH|0|SEND|0|JDOG|1|not-an-address;SEND|0|JDOG|1|' + A;
            const sdk = sdkFor([{ position: 0, action: 'SEND', status: 'valid', refused: null },
                { position: 1, action: 'SEND', status: 'invalid: insufficient funds', refused: null }]);
            const r = await sdk.preflight(wire, { source: A });
            const dest = codes(r.findings, FC.DEST_ADDRESS_INVALID);
            expect(dest, 'the parser finding is tagged with its command').to.have.length(1);
            expect(dest[0].data.commandIndex).to.equal(0);
            expect(dest[0].severity, 'network accepted command 1, so it is outranked').to.equal('info');
            expect(codes(r.findings, FC.DRYRUN_SUBCOMMAND_INVALID)[0].data.commandIndex).to.equal(1);
            expect(r.verdict).to.equal('fail');
        });

        it('an unjudged settlement command leaves the client check standing', async function () {
            // Multi-payee COINPAY: the probe cannot see the settlement outputs, so
            // it returns no status. The report must neither claim the command fails
            // nor let the silence outrank a local error on it.
            const wire = 'BATCH|0|SEND|0|JDOG|1|not-an-address;SEND|0|JDOG|1|' + A;
            const sdk = sdkFor([{ position: 0, action: 'SEND', status: null, refused: null },
                { position: 1, action: 'SEND', status: 'valid', refused: null }]);
            const r = await sdk.preflight(wire, { source: A });
            expect(codes(r.findings, FC.DEST_ADDRESS_INVALID)[0].severity).to.equal('error');
            expect(codes(r.findings, FC.DRYRUN_SUBCOMMAND_INVALID)).to.have.length(0);
            expect(codes(r.findings, FC.DRYRUN_SUBCOMMAND_UNJUDGED)).to.have.length(1);
            expect(r.verdict).to.equal('fail');
        });

        it('a VM sub-action refusal reports as a declined judgement, not a pass', async function () {
            const sdk = mockSdk({ preflight: 'report', explorerSpec: { getPreflight: {
                supported: false, denied: true, valid: null, deniedSubAction: 'DEPLOY',
                error: 'BATCH is not available on the public pre-flight endpoint with a DEPLOY sub-command' } } });
            const r = await sdk.preflight('BATCH|0|SEND|0|JDOG|1|' + A + ';DEPLOY|0|Zm9v', { source: A });
            const notice = codes(r.findings, FC.DRYRUN_UNAVAILABLE);
            expect(notice).to.have.length(1);
            expect(notice[0].message).to.contain('DEPLOY');
            expect(notice[0].data.deniedSubAction).to.equal('DEPLOY');
            expect(codes(r.findings, FC.DRYRUN_VALID)).to.have.length(0);
        });
    });

    describe('an invalid batch header', function () {

        it('still reports DRYRUN_INVALID, and no sub-commands ran', function () {
            const findings = applyTier1([], { kind: 'verdict', valid: false,
                status: 'invalid: COMMAND (limit)', error: 'invalid: COMMAND (limit)',
                quote: {}, blockIndex: 1, subCommands: null, oracleFeesOwed: null });
            expect(codes(findings, FC.DRYRUN_INVALID)).to.have.length(1);
            expect(codes(findings, FC.DRYRUN_SUBCOMMAND_INVALID)).to.have.length(0);
            expect(computeVerdict(findings)).to.equal('fail');
        });
    });
});
