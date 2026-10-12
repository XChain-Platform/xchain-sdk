'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('VOTE (re-vote legal; state unverified)', function () {
        it('never hard-blocks a cast ballot on re-vote grounds', async function () {
            const r = await reportFor('VOTE|1|55|1|memo', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(r.unverified.some(u => /VOTE/.test(u.check))).to.equal(true);
        });
    });
});
