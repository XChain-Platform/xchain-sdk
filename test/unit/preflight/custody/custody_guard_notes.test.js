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

    // The hashes follow the latest reviewed re-pin of each handler row (the 2026-10-15 NOT NULL
    // row key review); the custody note itself is unchanged by that review.
    const mapCases = [
        ['DEPOSIT', 'deposit', '3e1dd1918d920b6deba4511bf005b62c4a8dba819800ffa37f4416d49904375f'],
        ['WITHDRAW', 'withdraw', '99cae8fa45badbe03837b29aaf9baf167931724794c8548016c575bc7a6b6d35'],
    ];

    for (const [action, handler, hash] of mapCases) {
        it(`${action} maps its custody note to the landed indexer handler`, function () {
            const row = `| \`checks/misc.js\` (${action}) | \`src/actions/${handler}.js\` | \`${hash}\` |`;

            expect(indexerMap).to.include(row);
        });
    }
});
