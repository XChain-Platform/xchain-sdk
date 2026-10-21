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
        .to.equal('3fe395e025f8ab86fe60f5a31800860c9548eee33a69141fc13b916d13277a3f');
    const heading = '### 2026-10-18 - AIRDROP_NATIVE_FEE_TALLY gate is added';
    expect(text).to.include(heading);
    expect(entryOf(text, heading)).to.include('**Direction: TIGHTENING at the gate height only.**');
}

function sendHandoffRetirementReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/send/').hash)
        .to.equal('6bd08ac469d8a2ae2981e830a5278d5859786e86e5dd0a00113aee38f6a36302');
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
        ['send', '`ee30f903` to `0cbeede9`', '6bd08ac469d8a2ae2981e830a5278d5859786e86e5dd0a00113aee38f6a36302'],
        ['destroy', '`597c2728` to `b172b6cc`', '56a05750c8fc2eed6162b67a9202c54b9274effa46665bdea8bf702fe1d6f0e3'],
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

describe('pre-flight constants + registry drift map (§8.5) gate retirement reviews', function () {
    it('pins and records the DISPENSER and DISPENSE amount positivity gate retirement review', dispenserPositivityReview);
    it('the live dispenser pin is the end of the review-log pin chain', dispenserPinChainEnd);
    it('pins and records the AIRDROP native fee tally gate review', airdropFeeTallyReview);
    it('pins and records the SEND gated handoff reference gate retirement review', sendHandoffRetirementReview);
    it('pins and records the BATCH probe sub-verdict match snapshot review', batchSnapshotReviews);
    it('pins and records the SEND, DESTROY and MINT gas balance read review', gasBalanceReadReview);
});
