'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { dispenserAction, expect, has, reportFor, unverified } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSER refill (refill cap + oracle fee)', function () {
        it('declares the refill cap unverified: no endpoint exposes per-edit escrow', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction(),
            });
            expect(has(r, 'DISPENSER_MAX_REFILLS')).to.equal(false);
            expect(unverified(r, 'DISPENSER_MAX_REFILLS')).to.equal(true);
        });

        it('an edit that does not top up escrow is not refill-checked at all', async function () {
            const r = await reportFor('DISPENSER|2|42||1799999999', {
                getAction: () => dispenserAction(),
            });
            expect(unverified(r, 'DISPENSER_MAX_REFILLS')).to.equal(false);
        });

        it('declares the oracle usage fee unverified on a Mode B open', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC|BTC|1||USD||orc1', {});
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(true);
        });

        it('says nothing about an oracle fee on a Mode A dispenser', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC|BTC|1||USD|1', {});
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(false);
        });

        // A v2 refill never restates the oracle, so it has to come off the
        // dispenser being refilled.
        it('declares the oracle fee unverified on a Mode B refill', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction({ oracle_address: 'orc1' }),
            });
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(true);
        });

        it('says nothing about an oracle fee when refilling a Mode A dispenser', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction(),
            });
            expect(unverified(r, 'DISPENSER_ORACLE_FEE')).to.equal(false);
        });
    });
});
