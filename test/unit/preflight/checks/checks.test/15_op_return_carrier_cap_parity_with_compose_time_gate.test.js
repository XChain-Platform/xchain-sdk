'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { Actions, Utility, config, expect, has, reportFor } = require('./helpers/setup.js');

    // Pre-flight's whole contract is to report what compose would throw on, so
    // the two OP_RETURN gates must fire at the identical byte. They did not:
    // pre-flight compared raw bytes against 76 while compose measures the
    // COMPILED push, and a 76-byte action string returned a clean verdict and
    // then threw ENCODING_DATA_TOO_LARGE at submit time. Drive BOTH surfaces
    // across the boundary rather than pinning either one's constant.
describe('pre-flight Tier-2 per-action matrix', function () {

    describe('OP_RETURN carrier cap parity with the compose-time gate', function () {
        // 'BROADCAST|0|<message>|1' is 14 bytes of framing, so message length
        // n gives an action string of exactly n + 14 bytes.
        const actions = new Actions({ config: config.getConfig(), util: new Utility() });
        const wireFor = (bytes) => `BROADCAST|0|${'x'.repeat(bytes - 14)}|1`;

        function composeRejects(bytes) {
            try {
                actions.createAction({ action: 'BROADCAST',
                    params: { message: 'x'.repeat(bytes - 14), value: '1' },
                    encoder: { encoding: 'OP_RETURN' } });
                return false;
            } catch (e) { return e.code === 'ENCODING_DATA_TOO_LARGE'; }
        }

        for (const bytes of [74, 75, 76, 77]) {
            const overCap = bytes > 75;
            it(`a ${bytes}-byte action string: pre-flight and compose agree (${overCap ? 'both reject' : 'both accept'})`, async function () {
                const wire = wireFor(bytes);
                expect(Buffer.byteLength(wire, 'utf8'), 'fixture length').to.equal(bytes);
                const r = await reportFor(wire, {}, { encoding: 'OP_RETURN' });
                expect(has(r, 'ENCODING_TOO_LARGE', 'error'), 'pre-flight verdict').to.equal(overCap);
                expect(composeRejects(bytes), 'compose verdict').to.equal(overCap);
            });
        }
    });
});
