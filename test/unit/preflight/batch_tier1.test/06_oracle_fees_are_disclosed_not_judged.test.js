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
});
