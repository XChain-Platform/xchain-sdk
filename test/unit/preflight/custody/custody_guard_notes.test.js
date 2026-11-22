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

    // The hashes follow the latest reviewed re-pin of each handler row (the 2026-11-18 guard
    // gas billing helper review); the custody note itself is unchanged by that review.
    const mapCases = [
        ['DEPOSIT', 'deposit', '2d8585841185d9948b841eb078f55c843ea6df0801206c6778005a51bf4bcf31'],
        ['WITHDRAW', 'withdraw', 'cb8b7bf31b80689ec2c7c53139082b7123f2c9af97becfbb64eb0cf3eb3671af'],
    ];

    for (const [action, handler, hash] of mapCases) {
        it(`${action} maps its custody note to the landed indexer handler`, function () {
            const row = `| \`checks/misc.js\` (${action}) | \`src/actions/${handler}.js\` | \`${hash}\` |`;

            expect(indexerMap).to.include(row);
        });
    }
});
