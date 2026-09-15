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

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

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
});
