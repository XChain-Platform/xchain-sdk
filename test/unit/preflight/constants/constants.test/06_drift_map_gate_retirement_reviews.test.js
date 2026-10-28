'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate retirement reviews of the pre-flight drift map (spec §8.5). Each retirement that
// re-pins a mapped handler records a dated review entry; these cases pin the hashes that
// entry names and the entry's direction line. They live beside 01_drift_map.test.js,
// which is at the part-file line cap.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { parseMap } = require('../../../../../bin/check-preflight-drift.js');

const REAL_MAP = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');

function entryOf(text, heading) {
    const start = text.indexOf(heading);
    return text.slice(start, text.indexOf('\n### ', start + heading.length));
}

function dispenserPositivityReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    expect(rows.find((r) => r.handler === 'src/actions/dispenser/'), 'dispenser directory row').to.exist;
    expect(rows.find((r) => r.handler === 'src/actions/dispense/').hash)
        .to.equal('302ff0ba22c0ce8953db67b2eea23223162e4823302bd191ad8058ac52824cdc');
    const heading = '### 2026-10-18 - DISPENSER_AMOUNT_POSITIVITY gate is retired';
    expect(text).to.include(heading);
    expect(entryOf(text, heading)).to.include('**Direction: NEUTRAL.**');
}

function dispenserPinChainEnd() {
    const text = fs.readFileSync(REAL_MAP, 'utf8').replace(/\s+/g, ' ');
    const dispenser = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispenser/');
    expect(dispenser, 'dispenser directory row').to.exist;
    const moves = [...text.matchAll(/the `dispenser` pin moves from `([0-9a-f]{8})` to `([0-9a-f]{8})`/gi)];
    const live = dispenser.hash.slice(0, 8);
    expect(moves.map((move) => move[2]), 'review-log destination pins').to.include(live);
    expect(moves.map((move) => move[1]), 'superseded review-log pins').to.not.include(live);
}

function airdropFeeTallyReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/airdrop/').hash)
        .to.equal('4d7279d0707eb4c1719b0e4777dbf78bb3eef563ace5cd4006772d0691f200f7');
    const heading = '### 2026-10-18 - AIRDROP_NATIVE_FEE_TALLY gate is added';
    expect(text).to.include(heading);
    expect(entryOf(text, heading)).to.include('**Direction: TIGHTENING at the gate height only.**');
}

function sendHandoffRetirementReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/send/').hash)
        .to.equal('82c771685496157da6cd9beae176df3e7cd50fd25fa4dcbe0ad05c5e34579eb6');
    const heading = '### 2026-10-18 - GATED_HANDOFF_REF gate is retired';
    expect(text).to.include(heading);
    expect(entryOf(text, heading)).to.include('**Direction: NEUTRAL.**');
}

// The batch pin moves ahead of its indexer commit, so each entry must name the pairing.
function batchSnapshotReviews() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/batch/').hash)
        .to.equal('9a5147d0a4e121f10d9dd23a6d2f9602f8359ec5eca8f555111aea973a6321ad');
    const reviews = [
        ['### 2026-10-19 - BATCH probe sub-verdicts carry their own match snapshot', '`7e138a16` to `e7d7825d`'],
        ['### 2026-10-20 - a BATCH\'s own status is restored off the probe path too', '`e7d7825d` to `9f1e45a3`']
    ];
    for (const [heading, move] of reviews) {
        expect(text).to.include(heading);
        const entry = entryOf(text, heading).replace(/\s+/g, ' ');
        expect(entry).to.include('The `batch` pin moves from ' + move);
        expect(entry).to.include('cross-repo pairing exception');
        expect(entry).to.include('**Direction: NEUTRAL** for validity.');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    }
}

// The send, destroy and mint pins move ahead of their indexer commit, so the entry names the pairing.
function gasBalanceReadReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const moves = [
        ['send', '`ee30f903` to `0cbeede9`', '82c771685496157da6cd9beae176df3e7cd50fd25fa4dcbe0ad05c5e34579eb6'],
        ['destroy', '`597c2728` to `b172b6cc`', 'f6423fc8c16e8ad8d7721b7cf3703e9f852f2dd30b3d80bd8b91c50d47c9be40'],
        ['mint', '`f69fdb91` to `998c2d88`', '998c2d881eaecf00d0f350d5bb281ed6dabd7841fb37146fcad7b3e6fef26e48']
    ];
    const heading = '### 2026-10-20 - SEND, DESTROY and MINT read only the gas token\'s balance';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    for (const [name, move, hash] of moves) {
        expect(rows.find((r) => r.handler === 'src/actions/' + name + '/').hash).to.equal(hash);
        expect(entry).to.include('`' + name + '` from ' + move);
    }
    expect(entry).to.include('cross-repo pairing exception');
    expect(entry).to.include('**Direction: NEUTRAL** for validity.');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
}

// The three 2026-10-23 activations: AIRDROP and DIVIDEND move their pins for the reviewed
// settlement changes, while the equal-price ORDER ranking sits outside every mapped row.
function october23GatesReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    expect(rows.find((r) => r.handler === 'src/actions/airdrop/').hash)
        .to.equal('4d7279d0707eb4c1719b0e4777dbf78bb3eef563ace5cd4006772d0691f200f7');
    expect(rows.find((r) => r.handler === 'src/actions/dividend/').hash)
        .to.equal('7d66516b2584dcce47eecac80f62f90cabf98844ecc862195c03c65a7ff31065');
    expect(rows.find((r) => r.handler.startsWith('src/actions/order_match')), 'no ORDER_MATCH row').to.equal(undefined);
    const expected = [
        ['### 2026-10-23 - AIRDROP_ZERO_LEGS_OMITTED gate is wired into the AIRDROP settlement',
            'AIRDROP_ZERO_LEGS_OMITTED_ACTIVATION', '**Direction: NEUTRAL for validity; ledger rows change at the gate height only.**'],
        ['### 2026-10-23 - DIVIDEND_EMPTY_ALLOW_LIST_DENIES gate is wired into the DIVIDEND recipient set',
            'DIVIDEND_EMPTY_ALLOW_LIST_DENIES_ACTIVATION', '**Direction: NARROWS the recipient set at the gate height only.**'],
        ['### 2026-10-23 - ORDER matching takes equal-price makers oldest first behind an activation',
            'MATCH_EQUAL_PRICE_OLDEST_FIRST', '**Direction: NEUTRAL for validity, outside every mapped row.**'],
    ];
    for (const [heading, gate, direction] of expected) {
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry, heading).to.include(gate);
        expect(entry, heading).to.include(direction);
        expect(entry, heading).to.include('NO CLIENT CHECK MOVES');
    }
}

// The NOT NULL follow-up re-pins send, destroy and stake ahead of indexer dc4e4544f; one STAKE
// check moves, and the SEND and DESTROY legs stay with the server.
function notNullAmountWidthReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const moves = [
        ['send', '`6bd08ac4` to `82c77168`', '82c771685496157da6cd9beae176df3e7cd50fd25fa4dcbe0ad05c5e34579eb6'],
        ['destroy', '`56a05750` to `f6423fc8`', 'f6423fc8c16e8ad8d7721b7cf3703e9f852f2dd30b3d80bd8b91c50d47c9be40'],
        ['stake', '`eef1360e` to `b38ea784`', 'b38ea784128e91c87c0df0200696d2b0bac25105477c9111d929a420f30e6afc'],
    ];
    const heading = '### 2026-10-23 - SEND, DESTROY and STAKE refuse amounts their NOT NULL row columns cannot store';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    for (const [name, move, hash] of moves) {
        expect(rows.find((r) => r.handler === 'src/actions/' + name + '/').hash, name).to.equal(hash);
        expect(entry).to.match(new RegExp('`' + name + '` pin (moves )?from ' + move));
    }
    expect(entry).to.include('committed indexer lane tree `dc4e4544f`');
    expect(entry).to.include('cross-repo pairing exception');
    expect(entry).to.include('**Direction: WIDENS rejection of malformed wire input, no activation row.**');
    expect(entry).to.include('For SEND and DESTROY, NO CLIENT CHECK MOVES');
    expect(entry).to.include('checks.test/18_stake_amount_column_width.test.js');
    expect(entry).to.include('The anchor stays at `52a82367`.');
}

// The TICK_NORMALIZE gate re-pins issue ahead of indexer 32b4fa8f0; one ISSUE pre-flight warning
// moves, and the ticker key widening stays outside every mapped row.
function tickNormalizeReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/issue/').hash)
        .to.equal('c7d81c143f4f1ad242c9266487ff726102b7e6444a8cea4b374214ebf4d7deed');
    const heading = '### 2026-10-23 - ISSUE caret TICK ids must be canonical behind TICK_NORMALIZE';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `issue` pin moves from `be5cd48c` to `c7d81c14`');
    expect(entry).to.include('committed indexer lane tree `32b4fa8f0`');
    expect(entry).to.include('cross-repo pairing exception');
    expect(entry).to.include('tick_normalize_activation.TICK_NORMALIZE_ACTIVATION');
    expect(entry).to.include('XC_TICK_NORMALIZE_REGTEST_ACTIVATION');
    expect(entry).to.include('One client check moves.');
    expect(entry).to.include('checks.test/19_issue_caret_tick_normalize.test.js');
    expect(entry).to.include('**Direction: TIGHTENING at the gate height only.**');
    expect(entry).to.include('The anchor stays at `52a82367`.');
}

function sameTokenOfferReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const expected = {
        'src/actions/order/': '294bc04fdb4e48a0d59beccfc2800826acdb4da77643b6709d1e009dfc4b04e6',
        'src/actions/swap/': '1f77aa820a0d5ac2afffebc38ad456389b72e58eb9e67001529a14e60899a0d8',
    };
    for (const [handler, hash] of Object.entries(expected))
        expect(rows.find((row) => row.handler === handler).hash, handler).to.equal(hash);
    const heading = '### 2026-10-27 - same-chain ORDER and SWAP refuse offers of one resolved token';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading);
    expect(entry).to.include('invalid: cannot trade a token for itself');
    expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
}

describe('pre-flight constants + registry drift map (§8.5) gate retirement reviews', function () {
    it('pins and records the DISPENSER and DISPENSE amount positivity gate retirement review', dispenserPositivityReview);
    it('the live dispenser pin is the end of the review-log pin chain', dispenserPinChainEnd);
    it('pins and records the AIRDROP native fee tally gate review', airdropFeeTallyReview);
    it('pins and records the SEND gated handoff reference gate retirement review', sendHandoffRetirementReview);
    it('pins and records the BATCH probe sub-verdict match snapshot review', batchSnapshotReviews);
    it('pins and records the SEND, DESTROY and MINT gas balance read review', gasBalanceReadReview);
    it('pins and records the AIRDROP zero leg, DIVIDEND empty allow list and equal-price ORDER reviews', october23GatesReview);
    it('pins and records the SEND, DESTROY and STAKE NOT NULL amount width review', notNullAmountWidthReview);
    it('pins and records the ISSUE caret TICK canonical id review', tickNormalizeReview);
    it('pins and records the ORDER and SWAP same-token offer refusal review', sameTokenOfferReview);
});
