'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Activation splits worded into batch and dispenser disclosures come from the pinned
// mirrors, and the pins match the indexer's own rows.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { DISCLOSURE_MIRRORS, describeActivation } = require('../../../../src/preflight/activation.js');
const { checkCommandCap } = require('../../../../src/preflight/checks/batch.js');
const { FINDING_CODES } = require('../../../../src/preflight/constants.js');
const { declareAmountRepresentability } = require('../../../../src/preflight/checks/dispenser/amount_rules.js');

const INDEXER = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'protocol_changes');
const read = (f) => fs.readFileSync(path.join(INDEXER, f), 'utf8');

describe('pre-flight activation splits are mirrored, not hard-coded', function () {
    it('pins the representability and batch gates', function () {
        expect(Object.keys(DISCLOSURE_MIRRORS)).to.have.members(
            ['AMOUNT_REPRESENTABILITY', 'BATCH_ISSUANCE_LIMITS', 'BATCH_COST_WEIGHTING']);
    });

    it('the dispenser representability disclosure is built from the pinned table', function () {
        const seen = [];
        declareAmountRepresentability({ addUnverified: (check, text) => seen.push({ check, text }) });
        expect(seen).to.have.length(1);
        expect(seen[0].check).to.equal('AMOUNT_REPRESENTABILITY');
        expect(seen[0].text).to.contain(describeActivation('AMOUNT_REPRESENTABILITY'));
        expect(seen[0].text).to.not.contain('neither mainnet nor testnet is armed');
    });

    it('the batch weight finding is worded from the pinned issuance-limits table', function () {
        const findings = [];
        const ctx = {
            parsed: { params: { COMMAND: Array(11).fill('DROP|TICK|1').join(';') } },
            findings,
            markRun: () => {},
            addFinding: (code, level, text, data) => findings.push({ code, level, text, data }),
        };
        checkCommandCap(ctx, []);
        expect(findings).to.have.length(1);
        expect(findings[0].code).to.equal(FINDING_CODES.BATCH_LIMIT_EXCEEDED);
        expect(findings[0].data.weight).to.be.greaterThan(findings[0].data.limit);
        expect(findings[0].text).to.contain(describeActivation('BATCH_ISSUANCE_LIMITS'));
        expect(findings[0].text).to.not.contain('2026-08-16');
    });

    it('describes each pinned table by value', function () {
        expect(describeActivation('BATCH_ISSUANCE_LIMITS')).to.contain('armed at time 1786838400 on mainnet');
        expect(describeActivation('BATCH_COST_WEIGHTING')).to.contain('active from genesis on mainnet');
        expect(describeActivation('AMOUNT_REPRESENTABILITY')).to.contain('armed at time 1791061097 on BTC:testnet');
    });

    const indexerPresent = fs.existsSync(INDEXER);
    (indexerPresent ? describe : describe.skip)('against the indexer rows', function () {
        it('amount representability table matches the addGate row', function () {
            const src = read('gates_1.js');
            const body = src.split("AMOUNT_REPRESENTABILITY_ACTIVATION', 'time', {")[1].split('});')[0];
            const got = {};
            for (const m of body.matchAll(/'?([A-Za-z:]+)'?:\s*(\d+)/g)) got[m[1]] = Number(m[2]) === 9999999999 ? 'UNARMED' : Number(m[2]);
            expect(got).to.deep.equal(DISCLOSURE_MIRRORS.AMOUNT_REPRESENTABILITY.table);
        });

        it('batch mainnet constants match the flag-time file', function () {
            const src = read('flag_times_batch_fees.js');
            expect(Number(/BATCH_ISSUANCE_LIMITS_MAINNET_TIME = (\d+);/.exec(src)[1]))
                .to.equal(DISCLOSURE_MIRRORS.BATCH_ISSUANCE_LIMITS.table.mainnet);
            expect(Number(/BATCH_COST_WEIGHTING_MAINNET_TIME = (\d+);/.exec(src)[1]))
                .to.equal(DISCLOSURE_MIRRORS.BATCH_COST_WEIGHTING.table.mainnet);
        });
    });
});
