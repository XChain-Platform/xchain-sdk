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

describe('pre-flight constants + registry drift map (§8.5) gate retirement reviews', function () {
    it('pins and records the DISPENSER and DISPENSE amount positivity gate retirement review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        const rows = parseMap(REAL_MAP);
        expect(rows.find((r) => r.handler === 'src/actions/dispenser/'), 'dispenser directory row').to.exist;
        expect(rows.find((r) => r.handler === 'src/actions/dispense/').hash)
            .to.equal('302ff0ba22c0ce8953db67b2eea23223162e4823302bd191ad8058ac52824cdc');
        const heading = '### 2026-10-18 - DISPENSER_AMOUNT_POSITIVITY gate is retired';
        expect(text).to.include(heading);
        expect(entryOf(text, heading)).to.include('**Direction: NEUTRAL.**');
    });

    it('the live dispenser pin is the end of the review-log pin chain', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8').replace(/\s+/g, ' ');
        const dispenser = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispenser/');
        expect(dispenser, 'dispenser directory row').to.exist;
        const moves = [...text.matchAll(/the `dispenser` pin moves from `([0-9a-f]{8})` to `([0-9a-f]{8})`/gi)];
        const live = dispenser.hash.slice(0, 8);
        expect(moves.map((move) => move[2]), 'review-log destination pins').to.include(live);
        expect(moves.map((move) => move[1]), 'superseded review-log pins').to.not.include(live);
    });

    it('pins and records the AIRDROP native fee tally gate review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/airdrop/').hash)
            .to.equal('b04e9b5e3b02e0a1f548c29bdf39fcba90ab21366336cf84011c448f8248dd9c');
        const heading = '### 2026-10-18 - AIRDROP_NATIVE_FEE_TALLY gate is added';
        expect(text).to.include(heading);
        expect(entryOf(text, heading)).to.include('**Direction: TIGHTENING at the gate height only.**');
    });

    it('pins and records the SEND gated handoff reference gate retirement review', function () {
        const text = fs.readFileSync(REAL_MAP, 'utf8');
        expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/send/').hash)
            .to.equal('ee30f9038d6ea9d78cac4ebca511275ca11e62aea2c0ac4c4ac1ed3f765dbca9');
        const heading = '### 2026-10-18 - GATED_HANDOFF_REF gate is retired';
        expect(text).to.include(heading);
        expect(entryOf(text, heading)).to.include('**Direction: NEUTRAL.**');
    });
});
