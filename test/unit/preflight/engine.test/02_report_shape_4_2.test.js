'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight engine suite: modes, input normalization, report shape,
// tier precedence, and the severity/trust model (spec §4.1-4.3).

const { expect } = require('chai');
const { mockSdk } = require('../helpers/mock.js');

describe('pre-flight engine', function () {

    describe('report shape (§4.2)', function () {
        it('has every normative field', async function () {
            const sdk = mockSdk({ explorerSpec: null });
            const r = await sdk.preflight('MINT|0|JDOG|5', { source: 's', preflight: 'local' });
            expect(r).to.include.keys(['schemaVersion', 'verdict', 'restricted', 'checksRun', 'findings', 'unverified', 'quote', 'stateHeight', 'elapsedMs']);
            expect(r.schemaVersion).to.equal(1);
            expect(r.restricted).to.equal(false);
            expect(r.checksRun).to.be.an('array');
        });
    });
});
