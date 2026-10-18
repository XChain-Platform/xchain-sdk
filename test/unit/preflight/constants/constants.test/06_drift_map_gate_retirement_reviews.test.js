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
        expect(rows.find((r) => r.handler === 'src/actions/dispenser/').hash)
            .to.equal('c99f7897a62954276b440a1ec6f090aeab87368704c27b6ea8a0e534ca3b3db8');
        expect(rows.find((r) => r.handler === 'src/actions/dispense/').hash)
            .to.equal('302ff0ba22c0ce8953db67b2eea23223162e4823302bd191ad8058ac52824cdc');
        const heading = '### 2026-10-18 - DISPENSER_AMOUNT_POSITIVITY gate is retired';
        expect(text).to.include(heading);
        expect(entryOf(text, heading)).to.include('**Direction: NEUTRAL.**');
    });
});
