'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, has, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSER create pricing (amount-positivity mirror)', function () {
        // Format 0 wire: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW
        //   |GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS
        // An empty GET_TICK prices in the native coin; no FIAT_CODE and no
        // ORACLE_ADDRESS makes the dispenser self-priced.
        // Rule order follows the handler: the native-coin decimals check runs
        // first, and isValidAmountFormat is what rejects a leading '-', so a
        // negative native-coin price surfaces as the FORMAT warning. (The
        // universal wire-format rule already hard-blocks a negative amount on its
        // own; the mirror's job is the zero, empty and precision cases it misses.)
        it('a negative native-coin GET_AMOUNT is a format warning', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||-1', {});
            expect(has(r, 'AMOUNT_FORMAT_INVALID', 'warning')).to.equal(true);
        });

        it('a negative token-priced GET_AMOUNT reaches the positivity rule', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC|OTHER|-1', {});
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
        });

        it('a zero self-priced GET_AMOUNT reaches the positivity rule', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||0', {});
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
        });

        it('a self-priced dispenser with no GET_AMOUNT at all is warned', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||', {});
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
        });

        it('a native-coin GET_AMOUNT past the coin decimals is a format warning', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||0.123456789', {});
            expect(has(r, 'AMOUNT_FORMAT_INVALID', 'warning')).to.equal(true);
        });

        it('a well-formed positive self-priced GET_AMOUNT raises neither', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||0.5', {});
            expect(has(r, 'AMOUNT_NOT_POSITIVE')).to.equal(false);
            expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
        });

        it('a FIAT-priced dispenser is exempt from the GET_AMOUNT rules, as in the handler', async function () {
            const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||||USD|1', {});
            expect(has(r, 'AMOUNT_NOT_POSITIVE')).to.equal(false);
            expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
        });
    });
});
