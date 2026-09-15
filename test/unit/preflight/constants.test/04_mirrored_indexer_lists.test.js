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
const { checkListMirrors } = require('../../../../bin/check-preflight-drift.js');

function buildIndexerRoots(body) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-list-'));
    fs.mkdirSync(path.join(root, 'src', 'consensus'), { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(root, 'src', 'consensus', 'reservedRoots.js'), body);
    return root;
}

// The SDK's own list, re-emitted in the indexer's declaration shape.
function declareRoots(roots) {
    return 'const RESERVED_FUTURE_ROOTS = Object.freeze(['
        + roots.map((r) => `'${r}'`).join(', ') + ']);\n';
}

function liveRoots() {
    return [...constants.RESERVED_FUTURE_ROOTS];
}

function registerListComparisonTests(fakeIndexerRoots) {
    it('passes when the indexer list matches the SDK copy entry for entry', function () {
        expect(checkListMirrors(fakeIndexerRoots(declareRoots(liveRoots())))).to.equal(0);
    });

    it('fails when the indexer reserves a root the SDK does not know about', function () {
        // The live direction: a chain is added to the reserved set and the SDK stays
        // silent on a create the chain now refuses.
        expect(checkListMirrors(fakeIndexerRoots(declareRoots(liveRoots().concat('XYZW'))))).to.equal(1);
    });

    it('fails when the SDK carries a root the indexer has released', function () {
        expect(checkListMirrors(fakeIndexerRoots(declareRoots(liveRoots().slice(1))))).to.equal(1);
    });

    // Same members, different order: a set comparison passes this and the two copies
    // are pinned order-identical, so it is a finding.
    it('fails when the two lists agree on membership but not on order', function () {
        const reordered = liveRoots();
        reordered.push(reordered.shift());
        expect(checkListMirrors(fakeIndexerRoots(declareRoots(reordered)))).to.equal(1);
    });

    // A duplicate is what a set comparison structurally cannot see: it dedupes one
    // side down to the other's length and reports agreement.
    it('fails when one side repeats an entry', function () {
        const dupe = liveRoots();
        dupe.splice(1, 0, dupe[0]);
        expect(checkListMirrors(fakeIndexerRoots(declareRoots(dupe)))).to.equal(1);
    });
}

function registerListFailureTests(fakeIndexerRoots) {
    it('fails CLOSED when the indexer literal cannot be read exactly once', function () {
        expect(() => checkListMirrors(fakeIndexerRoots(
            "const RESERVED_ROOTS_V2 = Object.freeze(['ETH']);\n"))).to.throw(/exactly one/);
        expect(() => checkListMirrors(fakeIndexerRoots(
            declareRoots(['ETH']) + declareRoots(['SOL'])))).to.throw(/exactly one/);
    });

    // "Parsed as empty" must never land as "the two agree": an empty list would
    // compare equal against any other unreadable one.
    it('fails CLOSED when the list parses as empty', function () {
        expect(() => checkListMirrors(fakeIndexerRoots(
            'const RESERVED_FUTURE_ROOTS = Object.freeze([]);\n'))).to.throw(/EMPTY/);
    });

    it('fails when the indexer file declaring the list is absent', function () {
        expect(checkListMirrors(fakeIndexerRoots(null))).to.equal(1);
    });
}

/* The vendored-LIST seam, the third class no mapped hash can cover.
 *
 * RESERVED_FUTURE_ROOTS is declared in xchain-indexer/src/consensus/reservedRoots.js and read
 * by issue.js through a symbol, so every pinned handler hash stays green while the
 * reserved set moves underneath the SDK copy the ISSUE pre-flight judges a create
 * against. Driven against SYNTHETIC indexer fixtures, like the seams above, because
 * the live sibling is a moving target.
 */
function registerListTests() {
    describe('mirrored indexer lists', function () {
        let root;
        const fakeIndexerRoots = (body) => {
            root = buildIndexerRoots(body);
            return root;
        };

        afterEach(function () {
            if (root) fs.rmSync(root, { recursive: true, force: true });
            root = null;
        });

        registerListComparisonTests(fakeIndexerRoots);
        registerListFailureTests(fakeIndexerRoots);
    });
}

describe('pre-flight constants + registry', function () {
    describe('drift map (§8.5)', function () {
        registerListTests();
    });
});
