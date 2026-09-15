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
});
