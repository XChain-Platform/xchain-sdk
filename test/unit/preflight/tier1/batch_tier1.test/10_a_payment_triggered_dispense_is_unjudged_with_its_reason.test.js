'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// The indexer's BATCH probe answers a payment-triggered DISPENSE sub-command with
// `status: null` because the synthetic pre-flight transaction pays no dispenser
// address (actions/batch/probe.js). It now says so in the row's `refused` note
// instead of leaving it null. No verdict moves: the row was already unjudged, so
// these pin that the note reaches the disclosure and that the command is still
// neither a pass nor a failure.

const { expect } = require('chai');
const { runTier1 } = require('../../../../../src/preflight/tier1.js');
const { applyTier1, computeVerdict } = require('../../../../../src/preflight/index.js');
const { parse } = require('../../../../../src/decoder/parse.js');
const constants = require('../../../../../src/preflight/constants.js');

const FC = constants.FINDING_CODES;
const WIRE = 'BATCH|0|SEND|1|JDOG|5|addr';
const NOTE = 'payment-triggered DISPENSE is not judged on the public pre-flight '
    + '(the pre-flight transaction pays no dispenser address)';

async function tier1With(rows) {
    const sdk = { explorer: { getPreflight: async () => ({ supported: true, valid: true,
        status: 'valid', blockIndex: 1, subCommands: rows }) } };
    return runTier1({ sdk, parsed: parse(WIRE, { validate: false }), source: 's', timeoutMs: 1000 });
}

function clientError(code, commandIndex) {
    return { code, severity: 'error', source: 'client', overridable: false, message: 'x',
        data: { commandIndex } };
}

describe('BATCH pre-flight (Tier 1 sub-command verdicts)', function () {

    describe('a payment-triggered DISPENSE sub-command is unjudged with its reason', function () {

        it('carries the indexer note into the disclosure and keeps the command unjudged', async function () {
            const out = await tier1With([
                { position: 0, action: 'SEND', status: 'valid', refused: null },
                { position: 1, action: 'DISPENSE', status: null, refused: NOTE }]);
            expect(out.kind).to.equal('verdict');
            expect(out.subCommands[1]).to.deep.equal({ position: 1, action: 'DISPENSE', status: null, refused: NOTE });

            const findings = applyTier1([], out);
            const unjudged = findings.filter((x) => x.code === FC.DRYRUN_SUBCOMMAND_UNJUDGED);
            expect(unjudged).to.have.length(1);
            expect(unjudged[0].severity).to.equal('info');
            expect(unjudged[0].data.commandIndex).to.equal(1);
            expect(unjudged[0].data.refused).to.equal(NOTE);
            expect(unjudged[0].message).to.include(NOTE);
            expect(findings.filter((x) => x.code === FC.DRYRUN_SUBCOMMAND_INVALID)).to.have.length(0);
        });

        it('never lets the unjudged row override a client error on the same command', async function () {
            const out = await tier1With([{ position: 0, action: 'DISPENSE', status: null, refused: NOTE }]);
            const f = clientError(FC.BALANCE_INSUFFICIENT, 0);
            const findings = applyTier1([f], out);
            expect(f.severity).to.equal('error');
            expect(computeVerdict(findings)).to.equal('fail');
        });

        it('still reads an older answer with no note as unjudged with the generic reason', async function () {
            const out = await tier1With([{ position: 0, action: 'DISPENSE', status: null, refused: null }]);
            const findings = applyTier1([], out);
            const unjudged = findings.filter((x) => x.code === FC.DRYRUN_SUBCOMMAND_UNJUDGED);
            expect(unjudged).to.have.length(1);
            expect(unjudged[0].message).to.include('the read-only pre-flight cannot evaluate this command');
        });
    });
});
