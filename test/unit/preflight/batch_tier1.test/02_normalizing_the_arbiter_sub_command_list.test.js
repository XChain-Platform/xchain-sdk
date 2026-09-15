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
});
