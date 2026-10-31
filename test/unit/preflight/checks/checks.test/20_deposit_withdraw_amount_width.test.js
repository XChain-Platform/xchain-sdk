'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, notFound, reportFor } = require('./helpers/setup.js');

const SPEC = {
    getToken: (tick) => ({ info: { tick, tick_id: 1, decimals: 8 }, supply: { current: '1000', max: '0', decimals: 8 } }),
    getBalances: () => ({ data: [{ tick: 'JDOG', amount: '1000' }], total: 1 }),
    getAction: () => ({ action: 'DEPLOY', status: 'valid', source: 'me' }),
};

function widthErrors(report) {
    return report.findings.filter((finding) => finding.code === 'AMOUNT_FORMAT_INVALID'
        && finding.severity === 'error' && finding.data && finding.data.limit === 250);
}

describe('pre-flight Tier-2 per-action matrix', function () {
    describe('DEPOSIT and WITHDRAW amount column width', function () {
        for (const action of ['DEPOSIT', 'WITHDRAW']) {
            const wire = (amount) => `${action}|0|42|JDOG|${amount}`;

            it(`${action} refuses a 251-character QUANTITY as a non-overridable error`, async function () {
                const report = await reportFor(wire('0'.repeat(250) + '1'), SPEC);
                const found = widthErrors(report);
                expect(found, JSON.stringify(report.findings)).to.have.length(1);
                expect(found[0].overridable).to.equal(false);
                expect(found[0].message).to.include(`rejects this ${action} as invalid: AMOUNT (format)`);
                expect(found[0].data).to.include({ field: 'QUANTITY', width: 251, limit: 250 });
            });

            it(`${action} keeps a 250-character QUANTITY clear of the width refusal`, async function () {
                const report = await reportFor(wire('0'.repeat(249) + '1'), SPEC);
                expect(widthErrors(report), JSON.stringify(report.findings)).to.deep.equal([]);
            });
        }

        it('keeps the authority lookup failure separate from the width verdict', async function () {
            const report = await reportFor('DEPOSIT|0|42|JDOG|' + '9'.repeat(251), {
                ...SPEC, getAction: () => notFound(),
            });
            expect(widthErrors(report)).to.have.length(1);
        });
    });
});
