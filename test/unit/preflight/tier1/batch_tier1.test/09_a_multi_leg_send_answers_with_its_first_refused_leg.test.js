'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// The indexer's BATCH probe folds a multi-leg SEND sub-command's leg verdicts
// into that sub-command's row (actions/batch/probe.js through
// actions/send/leg_verdicts.js): the row's status is the first refused leg
// rather than the last leg settled, a guard-inert leg answers only when no
// other leg refused, and the row gains a `legs` list. The SDK reads `status`
// alone, so these pin that a folded row is read as the refusal it is and that
// the extra field neither breaks normalization nor leaks into the outcome.

const { expect } = require('chai');
const { runTier1 } = require('../../../../../src/preflight/tier1.js');
const { applyTier1, computeVerdict } = require('../../../../../src/preflight/index.js');
const { parse } = require('../../../../../src/decoder/parse.js');
const constants = require('../../../../../src/preflight/constants.js');

const FC = constants.FINDING_CODES;
const WIRE = 'BATCH|0|SEND|1|JDOG|5|addr|JDOG|1|addr2';

function leg(destination, status) {
    return { tick: 'JDOG', amount: destination === 'addr' ? '5' : '1', destination, status };
}

async function tier1With(row) {
    const sdk = { explorer: { getPreflight: async () => ({ supported: true, valid: true,
        status: 'valid', blockIndex: 1, subCommands: [row] }) } };
    return runTier1({ sdk, parsed: parse(WIRE, { validate: false }), source: 's', timeoutMs: 1000 });
}

function clientError(code, commandIndex) {
    return { code, severity: 'error', source: 'client', overridable: false, message: 'x',
        data: { commandIndex } };
}

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

    describe('a multi-leg SEND sub-command answers with its first refused leg', function () {

        it('reads a folded row as the refusal and keeps the client error on that command', async function () {
            const out = await tier1With({ position: 0, action: 'SEND',
                status: 'invalid: insufficient funds', refused: null,
                legs: [leg('addr', 'invalid: insufficient funds'), leg('addr2', 'valid')] });
            expect(out.kind).to.equal('verdict');
            expect(out.subCommands).to.deep.equal([{ position: 0, action: 'SEND',
                status: 'invalid: insufficient funds', refused: null }]);

            const f = clientError(FC.BALANCE_INSUFFICIENT, 0);
            const findings = applyTier1([f], out);
            expect(f.severity).to.equal('error');
            expect(f._downgradedBy).to.equal(undefined);
            const sub = findings.filter((x) => x.code === FC.DRYRUN_SUBCOMMAND_INVALID);
            expect(sub).to.have.length(1);
            expect(sub[0].data.status).to.equal('invalid: insufficient funds');
            expect(computeVerdict(findings)).to.equal('fail');
        });

        it('reads a guard-inert fold as unjudged, never as a pass', async function () {
            const out = await tier1With({ position: 0, action: 'SEND', status: null,
                refused: 'a bound controller (C) gates this action',
                legs: [leg('addr', 'invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED (C)'), leg('addr2', 'valid')] });
            const f = clientError(FC.BALANCE_INSUFFICIENT, 0);
            const findings = applyTier1([f], out);
            expect(f.severity).to.equal('error');
            expect(findings.filter((x) => x.code === FC.DRYRUN_SUBCOMMAND_UNJUDGED)).to.have.length(1);
            expect(computeVerdict(findings)).to.equal('fail');
        });
    });
});
