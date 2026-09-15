'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, has, reportFor } = require('./helpers/setup.js');

describe('pre-flight Tier-2 per-action matrix', function () {

    describe('COINPAY (fee-exempt; Tier 1 gives no verdict)', function () {
        it('does not false-PASS on the feeExempt response', async function () {
            const r = await reportFor('COINPAY|0|42', {});
            // No DRYRUN_VALID should appear from a feeExempt response.
            expect(has(r, 'DRYRUN_VALID')).to.equal(false);
        });
    });
});
