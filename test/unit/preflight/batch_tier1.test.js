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
const { mockSdk } = require('./helpers/mock.js');

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

    });
});

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

    describe('the door: BATCH reaches the endpoint', function () {

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
});
