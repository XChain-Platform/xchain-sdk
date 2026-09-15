'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('EXECUTE (no method-existence check in handler)', function () {
        it('surfaces the runtime-revert-with-fee note as unverified, never a block', async function () {
            const r = await reportFor('EXECUTE|0|9|maybeBadMethod|arg', {});
            expect(r.findings.every(f => f.severity !== 'error')).to.equal(true);
            expect(r.unverified.some(u => u.check === 'EXECUTE_STATE')).to.equal(true);
        });
    });
});
