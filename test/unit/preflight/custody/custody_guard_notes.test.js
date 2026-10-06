'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { ASPECT_NOTES } = require('../../../../src/preflight/checks/misc.js');

const indexerMap = fs.readFileSync(path.join(__dirname, '../../../../src/preflight/INDEXER-MAP.md'), 'utf8');

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

    const mapCases = [
        ['DEPOSIT', 'deposit', 'bbddd777d235e2da7b472d0e4ed993b598886202374f58ae2d46525079cb8f76'],
        ['WITHDRAW', 'withdraw', 'b68c873821cbcbe2e72082817f13eecbe87c12c2a99591d5d4b9085358b7fa75'],
    ];

    for (const [action, handler, hash] of mapCases) {
        it(`${action} maps its custody note to the landed indexer handler`, function () {
            const row = `| \`checks/misc.js\` (${action}) | \`src/actions/${handler}.js\` | \`${hash}\` |`;

            expect(indexerMap).to.include(row);
        });
    }
});
