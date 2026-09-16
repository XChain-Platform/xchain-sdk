'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor, unverified } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('BROADCAST / MESSAGE (no chain-state preconditions)', function () {
        // An action with nothing to check must not file an "unverified"
        // entry: the wallet renders that list under "Could not verify", and a
        // sentence saying there was nothing to verify reads there as a
        // failure. The first testnet user to meet it reported it as an error.
        it('BROADCAST emits no unverified state entry', async function () {
            const r = await reportFor('BROADCAST|0|hello|100', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(unverified(r, 'BROADCAST_STATE')).to.equal(false);
        });

        it('MESSAGE emits no unverified state entry', async function () {
            const r = await reportFor('MESSAGE|3|BTC|addr|hello', {});
            expect(unverified(r, 'MESSAGE_STATE')).to.equal(false);
        });

        it('an action with no dedicated module and no note still declares itself unverified', async function () {
            const r = await reportFor('STAKE|1|500', {});
            expect(unverified(r, 'STAKE_STATE')).to.equal(true);
        });
    });
});
