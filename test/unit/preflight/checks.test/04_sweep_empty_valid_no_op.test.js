'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('SWEEP (empty is a valid no-op)', function () {
        it('never emits a balance error; state is unverified', async function () {
            const r = await reportFor('SWEEP|0|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(r.unverified.some(u => /SWEEP/.test(u.check))).to.equal(true);
        });
    });
});
