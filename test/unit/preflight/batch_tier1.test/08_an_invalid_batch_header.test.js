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
