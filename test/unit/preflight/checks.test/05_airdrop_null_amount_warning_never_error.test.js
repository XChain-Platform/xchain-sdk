'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, has, notFound, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('AIRDROP (null AMOUNT is a warning, never an error)', function () {
        // A LIST is resolved by ACTION INDEX, so the lookup is the action-detail
        // route. /lists/ takes block or address only; keying it by action_index
        // 404'd, which made every airdrop against a real list read as an airdrop
        // against a missing one.
        it('null AMOUNT does not hard-block', async function () {
            const r = await reportFor('AIRDROP|0|JDOG||55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => ({ action: 'LIST', action_index: '55' }),
            });
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(has(r, 'AMOUNT_NOT_POSITIVE', 'warning')).to.equal(true);
        });

        it('an existing list is not reported missing', async function () {
            const r = await reportFor('AIRDROP|0|JDOG|1|55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => ({ action: 'LIST', action_index: '55' }),
            });
            expect(has(r, 'LIST_NOT_FOUND')).to.equal(false);
        });

        it('missing LIST is an error', async function () {
            const r = await reportFor('AIRDROP|0|JDOG|1|55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => notFound(),
            });
            expect(has(r, 'LIST_NOT_FOUND', 'error')).to.equal(true);
        });

        it('an action index that is not a LIST is an error', async function () {
            const r = await reportFor('AIRDROP|0|JDOG|1|55', {
                getToken: () => ({ tick: 'JDOG' }),
                getAction: () => ({ action: 'SEND', action_index: '55' }),
            });
            expect(has(r, 'LIST_NOT_FOUND', 'error')).to.equal(true);
        });
    });
});
