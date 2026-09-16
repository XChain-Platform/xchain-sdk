'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { runTier1, normalizeSubCommands } = require('../../../../src/preflight/tier1.js');
const { applyTier1, computeVerdict } = require('../../../../src/preflight/index.js');
const { parse } = require('../../../../src/decoder/parse.js');
const constants = require('../../../../src/preflight/constants.js');
const { mockSdk } = require('../helpers/mock.js');

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

// The unit cases above drive applyTier1 directly. These drive the whole
// engine, because the thing that would have gone wrong is an INTERACTION:
// Tier 1's outer valid:true meeting Tier 2's per-command findings inside
// one report.

const A = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

function sdkFor(subCommands, extra) {
    return mockSdk({ preflight: 'report', explorerSpec: { getPreflight:
        Object.assign({ supported: true, valid: true, status: 'valid', blockIndex: 14513,
            subCommands }, extra || {}) } });
}

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

    describe('end to end through sdk.preflight()', function () {

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


    });
});

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

    describe('end to end through sdk.preflight()', function () {

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
});
