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

    describe('an UNJUDGED sub-command is neither a pass nor a failure', function () {

        // This is the multi-payee COINPAY case, and getting it wrong in either
        // direction is a real defect. The probe carries no settlement outputs
        // (the synthetic tx's tx_outputs holds only the injected fee output), so
        // coinpay.js resolves no payee output and returns without recording a
        // status. Calling that "invalid" would manufacture the exact false
        // negative the indexer's own fix removed; calling it "valid" would let the
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
});
