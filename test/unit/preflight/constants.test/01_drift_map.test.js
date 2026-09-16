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
const { parseMap, checkAnchorConsistency } = require('../../../../bin/check-preflight-drift.js');

const REAL_MAP = path.join(__dirname, '..', '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');
let dir;

function fixture(text) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-consistency-'));
    const p = path.join(dir, 'INDEXER-MAP.md');
    fs.writeFileSync(p, text);
    return p;
}

function registerMapParsingTest() {
    // The SDK unit suite is hermetic: it must NOT compare INDEXER-MAP.md
    // hashes against the live xchain-indexer sibling, which a second coder
    // edits independently (a moving target would break this suite on every
    // unrelated handler change). The live-hash comparison lives in the
    // standalone bin/check-preflight-drift.js, run by the indexer's own CI
    // (spec §8.5: "CI on xchain-indexer"). Here we only assert the map is
    // well-formed so a malformed/empty map is still caught.
    it('INDEXER-MAP.md parses into well-formed rows', function () {
        const rows = parseMap(REAL_MAP);
        expect(rows.length, 'map has mapping rows').to.be.greaterThan(0);
        for (const { handler, hash } of rows) {
            expect(handler).to.match(/^src\/actions\/[\w-]+(?:\.js|\/$)/);
            expect(hash, handler + ' hash must be 64-hex').to.match(/^[0-9a-f]{64}$/);
        }
    });
}

/* The map's two halves must name one commit.
 *
 * The anchor line is machine-read; the review command below it is the human
 * baseline. They came apart twice - 2026-08-23 moved the table and missed the
 * line, 2026-08-25 moved the line and missed the command - and both times the
 * automated half stayed green because it reads the correct line. The REAL map is
 * asserted here (this is a pure text check over an in-repo file, so it stays
 * hermetic), and the failing direction is driven from temp fixtures.
 */
function registerAnchorConsistencyTests() {
    describe('anchor / review-command consistency', function () {
        afterEach(function () {
            if (dir) fs.rmSync(dir, { recursive: true, force: true });
            dir = null;
        });

        it('the shipped INDEXER-MAP.md anchors its review command on its own pin', function () {
            expect(checkAnchorConsistency(REAL_MAP)).to.equal(0);
        });

        it('fails when the review command names a different commit than the anchor line', function () {
            const real = fs.readFileSync(REAL_MAP, 'utf8');
            const stale = real.replace(/diff [0-9a-f]{7,40}\.\.HEAD/, 'diff 2d9cbbbf..HEAD');
            expect(stale, 'fixture must actually differ from the real map').to.not.equal(real);
            expect(checkAnchorConsistency(fixture(stale))).to.equal(1);
        });

        it('fails CLOSED when the review command is missing or unreadable', function () {
            const real = fs.readFileSync(REAL_MAP, 'utf8');
            const gutted = real.replace(/git -C \S*xchain-indexer diff [0-9a-f]{7,40}\.\.HEAD -- src\/actions\//,
                '(see the review log)');
            expect(gutted).to.not.equal(real);
            expect(checkAnchorConsistency(fixture(gutted))).to.equal(1);
        });

        it('fails CLOSED when the map records no anchor at all', function () {
            const real = fs.readFileSync(REAL_MAP, 'utf8');
            const anchorless = real.replace('**Pins taken at indexer commit:**', '**Pins were taken at:**');
            expect(anchorless).to.not.equal(real);
            expect(checkAnchorConsistency(fixture(anchorless))).to.equal(1);
        });
    });
}

function registerMapCoverageTest() {
    it('every checks/ action module is mapped (or intentionally misc-only)', function () {
        // Guard against adding a certified check without a drift-map entry.
        const mapped = new Set(parseMap(REAL_MAP)
            .map((r) => r.handler.replace('src/actions/', '').replace(/(?:\.js|\/)$/, '')));
        // The action groups whose checks carry certified error-capable logic.
        for (const h of ['send', 'destroy', 'mint', 'issue', 'dispenser', 'dispense', 'order', 'swap', 'airdrop', 'dividend', 'batch']) {
            expect(mapped.has(h), `${h} handler should be in INDEXER-MAP.md`).to.equal(true);
        }
    });
}

describe('pre-flight constants + registry', function () {
    describe('drift map (§8.5)', function () {
        registerMapParsingTest();
        registerAnchorConsistencyTests();
        registerMapCoverageTest();
    });
});
