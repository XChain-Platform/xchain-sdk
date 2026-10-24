'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, notFound, reportFor } = require('./helpers/setup.js');

// Every STAKE format refuses an AMOUNT wider than its VARCHAR(250) row column
// (xchain-indexer src/actions/stake/capability_stake.js and contract_stake.js, through
// storesAsNull), at every height. 250 characters is the widest the column stores.
const KEY = 'cd'.repeat(32);
const SPEC = {
    getToken: (tick) => (String(tick) === 'XCHAIN' || String(tick) === 'JDOG'
        ? { info: { tick, tick_id: 1, decimals: 8 }, supply: { current: '1000', max: '0', decimals: 8 } }
        : notFound()),
    getBalances: () => ({ data: [{ tick: 'XCHAIN', amount: '50' }, { tick: 'JDOG', amount: '50' }], total: 2 }),
    getAction: () => notFound(),
};
const widthErrors = (r) => r.findings.filter((f) => f.code === 'AMOUNT_FORMAT_INVALID' && f.severity === 'error'
    && f.data && f.data.limit === 250);

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('STAKE (AMOUNT wider than the stake amount column)', function () {
        const wires = (amount) => [
            'STAKE|1|' + amount + '|' + KEY,
            'STAKE|2|' + amount + '|' + KEY,
            'STAKE|3|' + amount + '|' + KEY + '|5|JDOG',
        ];

        for (const wire of wires('0'.repeat(250) + '1')) {
            it(`refuses a 251-character AMOUNT on ${wire.slice(0, 7)} as a non-overridable error`, async function () {
                const r = await reportFor(wire, SPEC);
                const found = widthErrors(r);
                expect(found, wire.slice(0, 7)).to.have.length(1);
                expect(found[0].overridable).to.equal(false);
                expect(found[0].message).to.include('invalid: AMOUNT (format)');
                expect(found[0].data.width).to.equal(251);
            });
        }

        for (const wire of wires('0'.repeat(249) + '1')) {
            it(`keeps a 250-character AMOUNT on ${wire.slice(0, 7)} clear of the width refusal`, async function () {
                const r = await reportFor(wire, SPEC);
                expect(widthErrors(r)).to.deep.equal([]);
            });
        }

        it('does not also judge the balance of an AMOUNT already refused on width', async function () {
            const r = await reportFor('STAKE|1|' + '9'.repeat(251) + '|' + KEY, SPEC);
            expect(widthErrors(r)).to.have.length(1);
            expect(r.findings.some((f) => f.code === 'BALANCE_INSUFFICIENT')).to.equal(false);
        });
    });
});
