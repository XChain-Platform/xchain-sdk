'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./checks.test/helpers/setup.js');
const numeric = require('../../../../src/preflight/numeric.js');

// Where AMOUNT_REPRESENTABILITY is unarmed (mainnet), the legacy format rule passes leg
// amounts such as '1.+5' that mathjs cannot parse. The indexer refuses such a leg as
// invalid: AMOUNT (format) instead of halting on its DEBIT math, so pre-flight must refuse it
// too, on every leg and inside a BATCH.
const explorer = {
    getToken: () => ({ tick: 'JDOG', decimals: 8 }),
    getAction: () => ({ action: 'LIST', action_index: '55' }),
};
const MAINNET = { network: 'bitcoin-mainnet' };

function amountErrors(r) {
    return r.findings.filter(f => f.code === 'AMOUNT_FORMAT_INVALID' && f.severity === 'error');
}

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('AIRDROP (a leg amount the ledger cannot parse)', function () {
        it('bignumberParses agrees with mathjs on the legacy-passing forms', function () {
            for (const bad of ['1.+5', '1.-5', '01 .5', '00e5.']) expect(numeric.bignumberParses(bad)).to.equal(false);
            for (const good of ['1', '1.5', '0.00000001', '1.', null]) expect(numeric.bignumberParses(good)).to.equal(true);
        });

        it('refuses a format-1 second leg of 1.+5 where representability is unarmed', async function () {
            const r = await reportFor('AIRDROP|1|55|JDOG|1|JDOG|1.+5', explorer, MAINNET);
            const errs = amountErrors(r);
            expect(errs).to.have.length(1);
            expect(errs[0].data.field).to.equal('AMOUNT');
            expect(errs[0].data.amount).to.equal('1.+5');
            expect(errs[0].message).to.contain('invalid: AMOUNT (format)');
        });

        it('refuses a format-2 leg of 1.-5 where representability is unarmed', async function () {
            const r = await reportFor('AIRDROP|2|JDOG|1|55|JDOG|1.-5|55', explorer, MAINNET);
            expect(amountErrors(r)).to.have.length(1);
        });

        it('refuses the same leg inside a BATCH sub-command', async function () {
            const r = await reportFor('BATCH|0|AIRDROP|1|55|JDOG|1|JDOG|01 .5', explorer, MAINNET);
            const errs = amountErrors(r);
            expect(errs).to.have.length(1);
            expect(errs[0].data.commandIndex).to.equal(0);
        });

        it('leaves parseable multi-leg amounts alone', async function () {
            const r = await reportFor('AIRDROP|1|55|JDOG|1|JDOG|1.5', explorer, MAINNET);
            expect(amountErrors(r)).to.have.length(0);
        });

        it('raises one finding, not two, where representability already refuses the leg', async function () {
            const r = await reportFor('AIRDROP|1|55|JDOG|1|JDOG|1.+5', explorer);
            expect(amountErrors(r)).to.have.length(1);
        });
    });
});
