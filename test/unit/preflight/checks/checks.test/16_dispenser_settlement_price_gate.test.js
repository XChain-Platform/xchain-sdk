'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { dispenserAction, expect, reportFor, unverified } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSER settlement-price gate', function () {
        it('declares settlement-price availability unverified on a FIAT open', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC|BTC|1||USD|1', {});
            expect(unverified(r, 'DISPENSER_SETTLEMENT_PRICE')).to.equal(true);
        });

        it('declares settlement-price availability unverified on a FIAT refill', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction({ fiat_code: 'USD', fiat_amount: '1' }),
            });
            expect(unverified(r, 'DISPENSER_SETTLEMENT_PRICE')).to.equal(true);
        });

        it('does not declare settlement-price availability for a non-FIAT refill', async function () {
            const r = await reportFor('DISPENSER|2|42|100', {
                getAction: () => dispenserAction(),
            });
            expect(unverified(r, 'DISPENSER_SETTLEMENT_PRICE')).to.equal(false);
        });
    });
});
