'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { ASPECT_NOTES } = require('../../../src/preflight/checks/misc.js');

describe('pre-flight custody guard notes', function () {
    const cases = [
        ['DEPOSIT', 'contract active-state resolves server-side', 'depositor'],
        ['WITHDRAW', 'deployer-only gate and contract credit resolve server-side', 'withdrawer'],
    ];

    for (const [action, currentClause, party] of cases) {
        it(`${action} names both custody guards and server-side resolution`, function () {
            const note = ASPECT_NOTES[action];

            expect(note).to.include(currentClause);
            expect(note).to.include('CONTROLLER_CUSTODY_GUARD');
            expect(note).to.include("token's transfer or all controller");
            expect(note).to.include(`SOURCE's own address controller (the ${party})`);
            expect(note).to.include('both guards and their gas resolve server-side');
        });
    }
});
