'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Registry + drift-gate suite (spec §8.5, §8.7). Every quantified
// constant and finding code lives in one module; the certified list
// is the single source (§4.4 error column == this list). The drift
// gate runs here so `npm test` exercises it when a sibling indexer
// checkout is present.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const constants = require('../../../../src/preflight/constants.js');
const { checkRegexMirrors } = require('../../../../bin/check-preflight-drift.js');

function buildIndexerDb(body, at) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-regex-'));
    const rel = at || 'src/db/shared.js';
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(root, rel), body);
    return root;
}

function registerRegexAssertions(fakeIndexerDb) {
    it('passes when the indexer literal matches the SDK constant', function () {
        const live = '/' + constants.CANONICAL_CARET_ID.source + '/'
            + constants.CANONICAL_CARET_ID.flags;
        expect(checkRegexMirrors(fakeIndexerDb(
            'const CANONICAL_CARET_ID = ' + live + ';\n'))).to.equal(0);
    });

    it('fails when the indexer widens the canonical caret-id rule', function () {
        // The live divergence this case must catch: `^0` and `^007` would
        // become resolvable on chain while the SDK still reports
        // CARET_REF_UNRESOLVABLE for them.
        expect(checkRegexMirrors(fakeIndexerDb(
            'const CANONICAL_CARET_ID = /^[0-9]+$/;\n'))).to.equal(1);
    });

    it('fails when only the regex FLAGS differ', function () {
        const live = constants.CANONICAL_CARET_ID.source;
        expect(checkRegexMirrors(fakeIndexerDb(
            'const CANONICAL_CARET_ID = /' + live + '/i;\n'))).to.equal(1);
    });

    it('fails CLOSED when the indexer literal cannot be read exactly once', function () {
        // A rename or a second declaration must never read as "it agrees" - the
        // same contract parseStringSet and parseIntLiteral hold.
        expect(() => checkRegexMirrors(fakeIndexerDb(
            'const CANONICAL_CARET_ID_V2 = /^[1-9][0-9]*$/;\n'))).to.throw(/exactly one/);
        expect(() => checkRegexMirrors(fakeIndexerDb(
            'const CANONICAL_CARET_ID = /^a$/;\nconst CANONICAL_CARET_ID = /^b$/;\n')))
            .to.throw(/exactly one/);
    });

    it('fails when the indexer file declaring the rule is absent', function () {
        expect(checkRegexMirrors(fakeIndexerDb(null))).to.equal(1);
    });

    it('fails when the rule sits at src/db.js rather than the declared path', function () {
        // The gate follows the declared path, it does not search for the rule. An
        // indexer whose declaration sits anywhere else is one this SDK is not
        // pinned against, and reading that as agreement is the false-green way.
        const live = '/' + constants.CANONICAL_CARET_ID.source + '/'
            + constants.CANONICAL_CARET_ID.flags;
        expect(checkRegexMirrors(fakeIndexerDb(
            'const CANONICAL_CARET_ID = ' + live + ';\n', 'src/db.js'))).to.equal(1);
    });
}

/* The regex-mirror seam, which no mapped hash can cover either.
 *
 * CANONICAL_CARET_ID is declared in xchain-indexer/src/db/shared.js, and the map's
 * rows are `src/actions/*.js` only, so without this leg every pinned hash stays
 * green while the rule the SDK judges `^<id>` references against moves underneath
 * it. Driven against SYNTHETIC indexer fixtures for the same reason the seams
 * above are: the live sibling is a moving target.
 */
function registerRegexTests() {
    describe('mirrored regex rules', function () {
        let root;
        // The path is spelled out rather than read back from REGEX_MIRRORS: pinning
        // the fixture to the table would make every case pass whatever the table
        // said, which is the one thing this leg must not do.
        const fakeIndexerDb = (body, at) => {
            root = buildIndexerDb(body, at);
            return root;
        };

        afterEach(function () {
            if (root) fs.rmSync(root, { recursive: true, force: true });
            root = null;
        });

        registerRegexAssertions(fakeIndexerDb);
    });
}

describe('pre-flight constants + registry', function () {
    describe('drift map (§8.5)', function () {
        registerRegexTests();
    });
});
