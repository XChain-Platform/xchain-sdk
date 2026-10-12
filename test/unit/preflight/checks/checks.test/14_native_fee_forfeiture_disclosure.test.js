'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, has, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('native-fee forfeiture disclosure (FEE_CHARGING_ACTIONS)', function () {
        it('BET warns about native-fee forfeiture like every other fee-charging action', async function () {
            // bet.js calls createFeesObject and takes the paymentMode === 'native'
            // branch, so a BET paid in native coin forfeits it exactly as ORDER does.
            const r = await reportFor('BET|2|42|1|100|memo', {});
            expect(has(r, 'NATIVE_FEE_FORFEIT', 'warning')).to.equal(true);
        });

        it('an ORDER still warns (the identically-exposed control)', async function () {
            const r = await reportFor('ORDER|0|JDOG|10|XCHAIN|20|100', {});
            expect(has(r, 'NATIVE_FEE_FORFEIT', 'warning')).to.equal(true);
        });

        it('a non-fee action (SEND) still says nothing about forfeiture', async function () {
            const r = await reportFor('SEND|0|JDOG|1|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '5' }],
            });
            expect(has(r, 'NATIVE_FEE_FORFEIT')).to.equal(false);
        });
    });
});
