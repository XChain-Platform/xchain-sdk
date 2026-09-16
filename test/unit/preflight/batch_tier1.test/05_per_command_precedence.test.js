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

function acceptedCommandFindings() {
    const f = clientError(FC.TOKEN_NOT_FOUND, 1);
    const findings = applyTier1([f], verdictWith(
        [{ position: 0, action: 'SEND', status: 'valid', refused: null },
            { position: 1, action: 'SEND', status: 'valid', refused: null }]));
    return { f, findings };
}

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

    describe('per-command precedence: Tier 1 outranks Tier 2 only where it judged', function () {

        it('a client error on a command the network ACCEPTED is downgraded', function () {
            const { f, findings } = acceptedCommandFindings();
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
});
