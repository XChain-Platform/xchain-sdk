'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { dispenserAction, expect, has, notFound, reportFor, unverified } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSE (Tier 1 cannot validate; moves native coin)', function () {
        it('an open, funded dispenser is not blocked', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction(),
            });
            expect(has(r, 'DISPENSER_NOT_FOUND')).to.equal(false);
            expect(has(r, 'DISPENSER_NOT_OPEN')).to.equal(false);
            expect(has(r, 'DISPENSER_EMPTY')).to.equal(false);
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
        });

        it('dispenser not open is an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({}, { status: 'closed' }),
            });
            expect(has(r, 'DISPENSER_NOT_OPEN', 'error')).to.equal(true);
        });

        // Settlement half of dispenser_amount_positivity_activation: against a
        // self-priced dispenser the fill count is floor(payment / GET_AMOUNT), so a
        // stored price that is not positive fails every dispense after the coin moves.
        it('a self-priced dispenser storing a non-positive GET_AMOUNT is warned, never blocked', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({ get_amount: '-5' }),
            });
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
        });

        it('a stored GET_AMOUNT the divide cannot parse is warned the same way', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({ get_amount: 'abc' }),
            });
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
        });

        it('a positive stored GET_AMOUNT raises no positivity warning', async function () {
            const r = await reportFor('DISPENSE|0|42', { getAction: () => dispenserAction() });
            expect(has(r, 'AMOUNT_NOT_POSITIVE')).to.equal(false);
        });

        it('an oracle-priced dispenser is exempt from the stored-price rule, as in the handler', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({ get_amount: '0', oracle_address: 'orc1' }),
            });
            expect(has(r, 'AMOUNT_NOT_POSITIVE')).to.equal(false);
        });
    });
});

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSE (Tier 1 cannot validate; moves native coin)', function () {
        // The indexer keeps minting new terminal statuses (`empty`,
        // `max_dispenses_reached` from the refill caps). Gating on
        // anything-but-open is what keeps this from going stale each time.
        it('treats an unrecognised terminal status as not-open', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({}, { status: 'max_dispenses_reached' }),
            });
            expect(has(r, 'DISPENSER_NOT_OPEN', 'error')).to.equal(true);
        });

        it('drained dispenser (remaining < one fill) is an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({ give_amount: '25' }, { give_remaining: '10' }),
            });
            expect(has(r, 'DISPENSER_EMPTY', 'error')).to.equal(true);
        });

        // give_remaining on the action route already nets refills in
        // (explorer db.js: escrow + refills - dispenses), which is precisely
        // why it is read instead of rebuilt from the opening escrow.
        it('honours a give_remaining ABOVE the opening escrow (refilled)', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => dispenserAction({ give_escrow: '100' }, { give_remaining: '500' }),
            });
            expect(has(r, 'DISPENSER_EMPTY')).to.equal(false);
        });

        it('an action index that is not a dispenser does not exist', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => ({ action: 'SEND', action_index: '42' }),
            });
            expect(has(r, 'DISPENSER_NOT_FOUND', 'error')).to.equal(true);
        });

        it('a 404 on the lookup is an authoritative "does not exist"', async function () {
            const r = await reportFor('DISPENSE|0|42', { getAction: () => notFound() });
            expect(has(r, 'DISPENSER_NOT_FOUND', 'error')).to.equal(true);
        });

    });
});

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSE (Tier 1 cannot validate; moves native coin)', function () {
        // Degradation, not a verdict: an unreachable explorer must never
        // manufacture either a block or a pass (§4.2).
        it('an unreachable explorer is unverified, never an error', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => { throw new Error('explorer down'); },
            });
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(unverified(r, 'DISPENSER_NOT_FOUND')).to.equal(true);
        });

        // Silence would read as headroom on an action that moves native coin.
        it('declares status and give-remaining unverified when the state block is absent', async function () {
            const r = await reportFor('DISPENSE|0|42', {
                getAction: () => ({ action: 'DISPENSER', action_index: '42', give_amount: '25' }),
            });
            expect(has(r, 'DISPENSER_NOT_OPEN')).to.equal(false);
            expect(has(r, 'DISPENSER_EMPTY')).to.equal(false);
            expect(unverified(r, 'DISPENSER_NOT_OPEN')).to.equal(true);
            expect(unverified(r, 'DISPENSER_EMPTY')).to.equal(true);
        });
    });
});
