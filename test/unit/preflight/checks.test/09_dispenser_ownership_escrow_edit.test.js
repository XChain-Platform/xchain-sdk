'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { dispenserAction, expect, has, reportFor } = require('./helpers/setup.js');

    // An ownership dispenser never holds balance escrow, on edit as on create.
    // The create-time half is authoring-only and already lives in validator.js;
    // an EDIT never restates GIVE_OWNERSHIP, so only a state lookup can see it
    // (xchain-indexer src/actions/dispenser.js).
describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSER ownership-escrow edit', function () {
        it('warns when an edit tops up escrow on an ownership dispenser', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW', 'warning'),
                'an ownership dispenser cannot take escrow on edit').to.equal(true);
        });

        // Activation-gated on the chain (dispenser-family cohort) and pre-flight
        // has no height, so this can never be a hard block: protocol rule §4.2.
        it('never hard-blocks on it', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            const f = r.findings.find(x => x.code === 'DISPENSER_OWNERSHIP_ESCROW');
            expect(f.severity).to.not.equal('error');
        });

        // The handler guards with isNull, NOT isPositive, so a supplied zero is
        // still a supplied GIVE_ESCROW and still rejected. The refill path below
        // returns early on non-positive, which is why this sits ahead of it.
        it('fires on a supplied GIVE_ESCROW of 0, which the refill path ignores', async function () {
            const r = await reportFor('DISPENSER|2|42|0', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW', 'warning')).to.equal(true);
        });

        it('says nothing on an ordinary (non-ownership) dispenser refill', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction(),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW')).to.equal(false);
        });

        it('says nothing when the edit supplies no GIVE_ESCROW at all', async function () {
            const r = await reportFor('DISPENSER|2|42||1799999999', {
                getAction: () => dispenserAction({ give_ownership: 1 }),
            });
            expect(has(r, 'DISPENSER_OWNERSHIP_ESCROW')).to.equal(false);
        });
    });
});
