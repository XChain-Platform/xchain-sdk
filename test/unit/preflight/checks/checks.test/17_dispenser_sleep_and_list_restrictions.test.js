'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { dispenserAction, expect, has, notFound, reportFor } = require('./helpers/setup.js');

const OPEN = 'DISPENSER|0|BTC|JDOG|1|0|100|BTC|BTC|1||USD|1';
const restriction = (r) => (r.unverified || []).filter((u) => u.check === 'DISPENSER_RESTRICTIONS');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('DISPENSER sleep and allow/block-list refusals are declared server-side', function () {
        it('an open declares SOURCE and GIVE_TICK sleep state and both list checks', async function () {
            const r = await reportFor(OPEN, {});
            const [entry] = restriction(r);
            expect(restriction(r)).to.have.length(1);
            expect(entry.reason).to.contain('GIVE_TICK').and.to.contain('GET_ADDRESS');
            expect(has(r, 'DISPENSER_RESTRICTIONS')).to.equal(false);
        });

        it('a refill names the give token rules behind the refill-policy activation', async function () {
            const r = await reportFor('DISPENSER|2|42|100', { getAction: () => dispenserAction() });
            const [entry] = restriction(r);
            expect(restriction(r)).to.have.length(1);
            expect(entry.reason).to.contain('refill-policy activation');
        });

        it('a cancel and a no-top-up edit declare SOURCE sleep state alone', async function () {
            for (const wire of ['DISPENSER|1|42', 'DISPENSER|2|42||1799999999']) {
                const r = await reportFor(wire, { getAction: () => dispenserAction() });
                const [entry] = restriction(r);
                expect(restriction(r), wire).to.have.length(1);
                expect(entry.reason, wire).to.contain('SOURCE sleep state');
                expect(entry.reason, wire).to.not.contain('refill-policy activation');
            }
        });

        it('stays declared when the dispenser lookup is unavailable or finds nothing', async function () {
            const unavailable = await reportFor('DISPENSER|2|42|100', {
                getAction: () => { throw new Error('endpoint down'); },
            });
            const missing = await reportFor('DISPENSER|1|42', { getAction: () => notFound() });
            expect(restriction(unavailable)).to.have.length(1);
            expect(restriction(missing)).to.have.length(1);
        });
    });
});
