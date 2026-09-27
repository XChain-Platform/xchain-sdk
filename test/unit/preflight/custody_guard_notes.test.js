'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { ASPECT_NOTES } = require('../../../src/preflight/checks/misc.js');

const indexerMap = fs.readFileSync(path.join(__dirname, '../../../src/preflight/INDEXER-MAP.md'), 'utf8');

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
        ['DEPOSIT', 'deposit', 'cfd9837bc722773652e53b949ec938ba1757a295e470dba6c237a06ecf7667e3'],
        ['WITHDRAW', 'withdraw', '76fc627ad84da6a931e1d32b212b5764dd273cbf1a26a6ce746736ac29c5c669'],
    ];

    for (const [action, handler, hash] of mapCases) {
        it(`${action} maps its custody note to the landed indexer handler`, function () {
            const row = `| \`checks/misc.js\` (${action}) | \`src/actions/${handler}.js\` | \`${hash}\` |`;

            expect(indexerMap).to.include(row);
        });
    }
});
