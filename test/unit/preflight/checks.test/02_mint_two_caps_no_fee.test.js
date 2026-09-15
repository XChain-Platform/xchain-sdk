'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, has, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('MINT (two caps, no fee)', function () {
        it('over MAX_MINT per-tx is an error', async function () {
            const r = await reportFor('MINT|0|JDOG|1000', {
                getToken: () => ({ tick: 'JDOG', max_mint: '100', decimals: '0' }),
            });
            expect(has(r, 'MINT_OVER_MAX', 'error')).to.equal(true);
        });

        it('over remaining supply headroom is an error', async function () {
            const r = await reportFor('MINT|0|JDOG|50', {
                getToken: () => ({ tick: 'JDOG', max_supply: '100', supply: '80', decimals: '0' }),
            });
            expect(has(r, 'SUPPLY_EXCEEDED', 'error')).to.equal(true);
        });
    });
});
