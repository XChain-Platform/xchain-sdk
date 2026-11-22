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

    describe('shared stored-amount width rule', function () {
        const atLimit = '0'.repeat(249) + '1';
        const overLimit = '0'.repeat(250) + '1';
        const amountErrors = (r) => r.findings.filter((f) => f.code === 'AMOUNT_FORMAT_INVALID'
            && f.severity === 'error');

        for (const network of ['bitcoin-mainnet', 'bitcoin-regtest']) {
            it('refuses a 251-character MINT AMOUNT on ' + network, async function () {
                const r = await reportFor('MINT|0|JDOG|' + overLimit, SPEC, { network });
                expect(amountErrors(r)).to.have.length(1);
            });

            it('accepts a 250-character MINT AMOUNT on ' + network, async function () {
                const r = await reportFor('MINT|0|JDOG|' + atLimit, SPEC, { network });
                expect(amountErrors(r)).to.deep.equal([]);
            });
        }
    });
});

describe('pre-flight SEND and DESTROY leg width after consolidation', function () {
    const atLimit = '0'.repeat(249) + '1';
    const overLimit = '0'.repeat(250) + '1';
    const amountErrors = (r) => r.findings.filter((f) => f.code === 'AMOUNT_FORMAT_INVALID'
        && f.severity === 'error');
    const cases = [
        ['a lone 251-character SEND leg', 'SEND|0|JDOG|' + overLimit + '|r1', 1],
        ['a lone 250-character SEND leg', 'SEND|0|JDOG|' + atLimit + '|r1', 0],
        ['a wide SEND leg merged with a sibling on its destination and tick', 'SEND|1|JDOG|' + overLimit + '|r1|1|r1', 0],
        ['a wide SEND leg whose sibling has another destination', 'SEND|1|JDOG|' + overLimit + '|r1|1|r2', 1],
        ['a wide SEND leg whose only sibling is held out of the merge', 'SEND|1|JDOG|' + overLimit + '|r1|1.123456789|r1', 2],
        ['a wide SEND leg whose sibling names another tick', 'SEND|2|JDOG|' + overLimit + '|r1|XCHAIN|1|r1', 1],
        ['a lone 251-character DESTROY leg', 'DESTROY|0|JDOG|' + overLimit, 1],
        ['a wide DESTROY leg merged with a sibling under one memo', 'DESTROY|1|JDOG|' + overLimit + '|JDOG|1|m', 0],
        ['a wide DESTROY leg whose sibling has another memo', 'DESTROY|2|JDOG|' + overLimit + '|m1|JDOG|1|m2', 1],
        ['a wide DESTROY leg whose sibling shares its per-leg memo', 'DESTROY|2|JDOG|' + overLimit + '|m1|JDOG|1|m1', 0],
    ];

    for (const network of ['bitcoin-mainnet', 'bitcoin-regtest']) {
        for (const [title, wire, expected] of cases) {
            it(`raises ${expected} amount error(s) for ${title} on ${network}`, async function () {
                const r = await reportFor(wire, SPEC, { network });
                expect(amountErrors(r), wire.slice(0, 12)).to.have.length(expected);
            });
        }
    }

    it('refuses a lone wide SEND leg as a non-overridable width error', async function () {
        const r = await reportFor('SEND|0|JDOG|' + overLimit + '|r1', SPEC);
        const [found] = amountErrors(r);
        expect(found.overridable).to.equal(false);
        expect(found.message).to.include('invalid: AMOUNT (format)');
        expect(found.data).to.include({ tick: 'JDOG', width: 251, limit: 250 });
    });

    it('raises exactly one amount error for a 251-character STAKE, DEPOSIT or WITHDRAW', async function () {
        const wires = ['STAKE|1|' + overLimit + '|' + KEY, 'DEPOSIT|0|42|JDOG|' + overLimit,
            'WITHDRAW|0|42|JDOG|' + overLimit];
        for (const wire of wires) {
            const r = await reportFor(wire, SPEC);
            expect(amountErrors(r), wire.slice(0, 8)).to.have.length(1);
        }
    });
});
