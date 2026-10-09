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
const { parseMap, checkAnchorConsistency } = require('../../../../../bin/check-preflight-drift.js');

const REAL_MAP = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');
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

function registerIssueLazyProbeReviewTest() {
    it('pins and records the issue lazy distribution probe review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const issue = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/issue/');
        expect(issue, 'issue directory row').to.exist;
        expect(issue.hash).to.equal('95dff217aeae8428578cf583b74bdeedf97731fd2c9242be6e8baf6763c816e9');
        expect(text).to.include('### 2026-10-08 - issue lazy distribution probe');
        expect(text).to.include('**Direction: NEITHER, no admission boundary moves.**');
    });
}

function registerOrderSwapRemoteTokenReviewTest() {
    it('pins and records the ORDER and SWAP remote token accept review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        const order = rows.find((r) => r.handler === 'src/actions/order/');
        const swap = rows.find((r) => r.handler === 'src/actions/swap/');
        expect(order, 'order directory row').to.exist;
        expect(swap, 'swap directory row').to.exist;
        expect(order.hash).to.equal('150f49fc260ca52f15b9744bb217aa8eb06837bbbaf740f3cb99fcb54940b78c');
        expect(swap.hash).to.equal('f04acff4651e7529a57e5acb527d0cf8fcad73273babaf584fc8e945c94b8503');
        const heading = '### 2026-10-09 - ORDER and SWAP remote token accept check';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

function registerSendGatedTotalReviewTest() {
    it('pins and records the SEND gated handoff totals by resolved tick id review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const send = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/send/');
        expect(send, 'send directory row').to.exist;
        expect(send.hash).to.equal('bf2126e339d34154a15fc294a0d07341a01798718ba3a5ea8afdff4d07ea3ab7');
        const heading = '### 2026-10-09 - send gated handoff totals by resolved tick id';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

describe('pre-flight constants + registry', function () {
    describe('drift map (§8.5)', function () {
        registerMapParsingTest();
        registerAnchorConsistencyTests();
        registerMapCoverageTest();
        registerIssueLazyProbeReviewTest();
        registerOrderSwapRemoteTokenReviewTest();
        registerSendGatedTotalReviewTest();
    });
});
