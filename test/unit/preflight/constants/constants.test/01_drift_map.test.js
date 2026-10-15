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
    // The issue hash moves with every later reviewed change to the handler; the 2026-10-14
    // supply bound review pins it now, and the 2026-10-08 entry stays the record of this one.
    it('pins and records the issue lazy distribution probe review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const issue = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/issue/');
        expect(issue, 'issue directory row').to.exist;
        expect(text).to.include('### 2026-10-08 - issue lazy distribution probe');
        expect(text).to.include('**Direction: NEITHER, no admission boundary moves.**');
    });
}

function registerOrderSwapRemoteTokenReviewTest() {
    // The hashes move with every later reviewed change to these handlers; the 2026-10-09
    // entry below stays the record of the remote token accept review.
    it('pins and records the ORDER and SWAP remote token accept review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        const order = rows.find((r) => r.handler === 'src/actions/order/');
        const swap = rows.find((r) => r.handler === 'src/actions/swap/');
        expect(order, 'order directory row').to.exist;
        expect(swap, 'swap directory row').to.exist;
        expect(order.hash).to.equal('79fdae31db05edea980aca9b52b70fd8a2c65bb53e9e785534229bdca0ffd8ec');
        expect(swap.hash).to.equal('9bb114863e30d2501bb36f6f2d5a541bbaf99320b860466708253555aded19cc');
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

function registerBatchDispatchAdmissionReviewTest() {
    it('pins and records the BATCH sub-command admission by dispatch coverage review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const batch = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/batch/');
        expect(batch, 'batch directory row').to.exist;
        expect(batch.hash).to.equal('7e138a16dc5eff43ac60c4cca83c2b35ccd865eb98df3ce57c8cbc8aebca85a6');
        const heading = '### 2026-10-10 - BATCH sub-command admission by dispatch coverage';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

function registerDispenserRefillPolicyReviewTest() {
    it('pins and records the DISPENSER refill token policy review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const dispenser = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispenser/');
        expect(dispenser, 'dispenser directory row').to.exist;
        expect(dispenser.hash).to.equal('6369bdf9bd39490c407c7f447be77bbaf275c081e67abf9d29f075e5d5a3e546');
        const heading = '### 2026-10-10 - DISPENSER refill token policy';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

function registerDispenseOwnershipBlockFieldsReviewTest() {
    it('pins and records the DISPENSE ownership-transfer block fields review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const dispense = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispense/');
        expect(dispense, 'dispense directory row').to.exist;
        expect(dispense.hash).to.equal('99116a2db059516f00dfa6c552bbb4617135dce390cc10e334e0e34895890ff0');
        const heading = '### 2026-10-14 - DISPENSE ownership-transfer block fields';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: SETTLE PATH ONLY.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

function registerSupplyBoundReviewTest() {
    it('pins and records the MINT and ISSUE total supply bound review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        const mint = rows.find((r) => r.handler === 'src/actions/mint/');
        const issue = rows.find((r) => r.handler === 'src/actions/issue/');
        expect(mint, 'mint directory row').to.exist;
        expect(issue, 'issue directory row').to.exist;
        expect(mint.hash).to.equal('f69fdb9192b703a928dc46028a569f0a4725ce136b394304e1ec00bab04629e9');
        expect(issue.hash).to.equal('8f29219d887e695408a8d9b405a795182550c3ed0e991ab74bd4941efe9d294c');
        const heading = '### 2026-10-14 - MINT and ISSUE total supply bound behind an activation';
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
        registerBatchDispatchAdmissionReviewTest();
        registerDispenserRefillPolicyReviewTest();
        registerDispenseOwnershipBlockFieldsReviewTest();
        registerSupplyBoundReviewTest();
    });
});
