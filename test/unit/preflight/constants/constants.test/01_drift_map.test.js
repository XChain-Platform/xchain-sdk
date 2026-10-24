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
    // The hashes move with every later reviewed change to these handlers; the 2026-10-15
    // NOT NULL row key review pins them now, and the 2026-10-09 entry below stays the record of
    // the remote token accept review.
    it('pins and records the ORDER and SWAP remote token accept review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        const order = rows.find((r) => r.handler === 'src/actions/order/');
        const swap = rows.find((r) => r.handler === 'src/actions/swap/');
        expect(order, 'order directory row').to.exist;
        expect(swap, 'swap directory row').to.exist;
        const heading = '### 2026-10-09 - ORDER and SWAP remote token accept check';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

// The send hash moves with every later reviewed change to the handler; the 2026-10-15
// text amount refusal review pins it now, and the 2026-10-09 entry stays the record of this one.
function registerSendGatedTotalReviewTest() {
    it('pins and records the SEND gated handoff totals by resolved tick id review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const send = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/send/');
        expect(send, 'send directory row').to.exist;
                const heading = '### 2026-10-09 - send gated handoff totals by resolved tick id';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

// The 2026-10-19 probe sub-verdict review (06_drift_map_gate_retirement_reviews.test.js) pins the
// batch hash now; this entry stays the record of this review.
function registerBatchDispatchAdmissionReviewTest() {
    it('pins and records the BATCH sub-command admission by dispatch coverage review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const batch = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/batch/');
        expect(batch, 'batch directory row').to.exist;
        const heading = '### 2026-10-10 - BATCH sub-command admission by dispatch coverage';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

function registerDispenserRefillPolicyReviewTest() {
    // The pin-chain case in 06 guards the dispenser pin; the 2026-10-10 entry stays the
    // record of this review.
    it('pins and records the DISPENSER refill token policy review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const dispenser = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispenser/');
        expect(dispenser, 'dispenser directory row').to.exist;
        const heading = '### 2026-10-10 - DISPENSER refill token policy';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

function registerDispenseOwnershipBlockFieldsReviewTest() {
    // The dispense hash moves with every later reviewed change to the handler; the 2026-10-14
    // fiat pricing review pins it now, and its own entry stays the record of this one.
    it('pins and records the DISPENSE ownership-transfer block fields review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const dispense = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispense/');
        expect(dispense, 'dispense directory row').to.exist;
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
        expect(mint.hash).to.equal('998c2d881eaecf00d0f350d5bb281ed6dabd7841fb37146fcad7b3e6fef26e48');
        expect(issue.hash).to.equal('be5cd48c5d4aef365358cc296fa56b8621f8a627a09e0623d3c79e259e210762');
        const heading = '### 2026-10-14 - MINT and ISSUE total supply bound behind an activation';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

// The pin-chain case in 06 guards the dispenser pin; the 2026-10-14 entry stays the record
// of this review.
function registerFiatPricingReviewTest() {
    it('pins and records the DISPENSER and DISPENSE fiat pricing review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        const dispenser = rows.find((r) => r.handler === 'src/actions/dispenser/');
        const dispense = rows.find((r) => r.handler === 'src/actions/dispense/');
        expect(dispenser, 'dispenser directory row').to.exist;
        expect(dispense, 'dispense directory row').to.exist;
        expect(dispense.hash).to.equal('302ff0ba22c0ce8953db67b2eea23223162e4823302bd191ad8058ac52824cdc');
        const heading = '### 2026-10-14 - DISPENSER and DISPENSE fiat pricing behind an activation';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row, and SETTLE PATH.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

function registerTextAmountRefusalReviewTest() {
    it('pins and records the SEND, DESTROY and DIVIDEND text amount refusal review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        const send = rows.find((r) => r.handler === 'src/actions/send/');
        const destroy = rows.find((r) => r.handler === 'src/actions/destroy/');
        const dividend = rows.find((r) => r.handler === 'src/actions/dividend/');
        expect(send, 'send directory row').to.exist;
        expect(destroy, 'destroy directory row').to.exist;
        expect(dividend, 'dividend directory row').to.exist;
        expect(send.hash).to.equal('6bd08ac469d8a2ae2981e830a5278d5859786e86e5dd0a00113aee38f6a36302');
        expect(destroy.hash).to.equal('56a05750c8fc2eed6162b67a9202c54b9274effa46665bdea8bf702fe1d6f0e3');
        expect(dividend.hash).to.equal('7d66516b2584dcce47eecac80f62f90cabf98844ecc862195c03c65a7ff31065');
        const heading = '### 2026-10-15 - SEND, DESTROY and DIVIDEND refuse text amounts and unknown-tick legs';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection of malformed wire input, no activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

// The pin-chain case in 06 guards the dispenser pin; the 2026-10-17 supply prefetch review
// pins order and swap now, and the 2026-10-15 NOT NULL entry stays its own record.
function registerSupplyPrefetchReviewTest() {
    it('pins and records the DISPENSER, ORDER and SWAP supply prefetch review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        expect(rows.find((r) => r.handler === 'src/actions/dispenser/'), 'dispenser directory row').to.exist;
        const expected = {
            'src/actions/order/': '139612e79de1284ba40e9e428cb74bd9aea169413ed9664510738a887d02b7fc',
            'src/actions/swap/': '470d4c11820a52b6041f51015fba5247d6ddbec9d965d5f27f1331542fa104bf',
        };
        for (const [handler, hash] of Object.entries(expected)) {
            const row = rows.find((r) => r.handler === handler);
            expect(row, handler + ' row').to.exist;
            expect(row.hash, handler).to.equal(hash);
        }
        for (const name of ['DISPENSER', 'ORDER', 'SWAP']) {
            const heading = '### 2026-10-17 - ' + name + ' prefetch skips unused supply queries';
            expect(text).to.include(heading);
            const start = text.indexOf(heading);
            const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
            expect(entry).to.include('**Direction: NEUTRAL.**');
            expect(entry).to.include('{ supply: false }');
        }
    });
}

function registerGiveAmountGateReviewTest() {
    it('pins and records the DISPENSER give amount gate retirement review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const row = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispenser/');
        expect(row, 'dispenser directory row').to.exist;
        const heading = '### 2026-10-18 - DISPENSER give amount gate is retired';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: NEUTRAL.**');
    });
}

function registerConsolidationLegGateReviewTest() {
    it('pins and records the SEND and DESTROY consolidation leg gate retirement review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        expect(rows.find((r) => r.handler === 'src/actions/send/').hash).to.equal('6bd08ac469d8a2ae2981e830a5278d5859786e86e5dd0a00113aee38f6a36302');
        expect(rows.find((r) => r.handler === 'src/actions/destroy/').hash).to.equal('56a05750c8fc2eed6162b67a9202c54b9274effa46665bdea8bf702fe1d6f0e3');
        const heading = '### 2026-10-18 - CONSOLIDATION_LEG_AMOUNT gate is retired';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: NEUTRAL.**');
    });
}

function registerNotNullRowKeyReviewTest() {
    it('pins and records the ORDER, SWAP, DISPENSER, DEPOSIT and WITHDRAW NOT NULL row key review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        expect(rows.find((r) => r.handler === 'src/actions/dispenser/'), 'dispenser directory row').to.exist;
        const expected = {
            'src/actions/order/': '139612e79de1284ba40e9e428cb74bd9aea169413ed9664510738a887d02b7fc',
            'src/actions/swap/': '470d4c11820a52b6041f51015fba5247d6ddbec9d965d5f27f1331542fa104bf',
            'src/actions/deposit.js': '3e1dd1918d920b6deba4511bf005b62c4a8dba819800ffa37f4416d49904375f',
            'src/actions/withdraw.js': '99cae8fa45badbe03837b29aaf9baf167931724794c8548016c575bc7a6b6d35',
        };
        for (const [handler, hash] of Object.entries(expected)) {
            const row = rows.find((r) => r.handler === handler);
            expect(row, handler + ' row').to.exist;
            expect(row.hash, handler).to.equal(hash);
        }
        const heading = '### 2026-10-15 - ORDER, SWAP, DISPENSER, DEPOSIT and WITHDRAW refuse values a NOT NULL column stores as NULL';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('**Direction: WIDENS rejection of malformed wire input, no activation row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

// VOTE has no row: the gated TICK existence refusal is reviewed and recorded, and the
// client-side refusal it calls for is a named follow-up rather than a silent gap.
function registerVoteTickExistenceReviewTest() {
    it('records the VOTE v3 unknown TICK review with no VOTE row and the client follow-up', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const vote = parseMap(REAL_MAP).find((r) => r.handler.startsWith('src/actions/vote'));
        expect(vote, 'no VOTE row').to.equal(undefined);
        const heading = '### 2026-10-15 - VOTE v3 refuses an unknown TICK behind an activation';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('VOTE_V3_TICK_EXISTENCE_ACTIVATION');
        expect(entry).to.include('**Client follow-up.**');
        expect(entry).to.include('**Direction: WIDENS rejection behind an activation row, outside every mapped row.**');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    });
}

// ORDER_MATCH and SWAP_MATCH have no row: the gated open-origin requirement is reviewed and
// recorded, and the mapped ORDER and SWAP rows stay where they were.
function registerMatchOriginOpenReviewTest() {
    it('records the open match origin review with no ORDER_MATCH or SWAP_MATCH row', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        expect(rows.find((r) => r.handler.startsWith('src/actions/order_match')), 'no ORDER_MATCH row').to.equal(undefined);
        expect(rows.find((r) => r.handler.startsWith('src/actions/swap_match')), 'no SWAP_MATCH row').to.equal(undefined);
        const heading = '### 2026-10-15 - ORDER_MATCH and SWAP_MATCH require an open origin behind an activation';
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry).to.include('MATCH_ORIGIN_OPEN_ACTIVATION');
        expect(entry).to.include('**Client follow-up.**');
        expect(entry).to.include('**Direction: NARROWS matching behind an activation row, outside every mapped row.**');
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
        registerFiatPricingReviewTest();
        registerTextAmountRefusalReviewTest();
        registerNotNullRowKeyReviewTest();
        registerSupplyPrefetchReviewTest();
        registerGiveAmountGateReviewTest();
        registerConsolidationLegGateReviewTest();
        registerVoteTickExistenceReviewTest();
        registerMatchOriginOpenReviewTest();
    });
});
