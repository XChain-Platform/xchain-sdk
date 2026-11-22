'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The mandatory-native BATCH fee quote review of the pre-flight drift map (spec §8.5). It sits
// beside 06_drift_map_gate_retirement_reviews.test.js, which is at the part-file line cap, under
// the same suite name.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { parseMap } = require('../../../../../bin/check-preflight-drift.js');

const REAL_MAP = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');

function entryOf(text, heading) {
    const start = text.indexOf(heading);
    return text.slice(start, text.indexOf('\n### ', start + heading.length));
}

// Only computeFeeQuote's synthetic transaction lets EXECUTE through a BATCH and records its fee,
// so the batch pin moves, the anchor stays and no client check moves.
function batchFeeQuoteReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/batch/').hash)
        .to.equal('8047029e85b6f17bec53abed2d57c50a13ea46f41c51734e411b7e9bfe8554c4');
    const heading = '### 2026-11-22 - a mandatory-native BATCH fee quote dispatches EXECUTE';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `batch` pin moves from `1c42ba29` to `ed92d5a2`');
    expect(entry).to.include('`fea02d561`');
    expect(entry).to.include('BATCH_FEE_QUOTE');
    expect(text).to.include('**Pins taken at indexer commit:** `33fbabce2`');
    expect(text).to.include('(Not re-anchored 2026-11-22.');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
    expect(entry).to.include('**Direction: NEUTRAL for validity.**');
}

function batchMatchFeeReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const heading = '### 2026-11-22 - a filling BATCH offer reads its fee from the originating action';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `batch` pin moves from `ed92d5a2` to `8047029e`');
    expect(entry).to.include('`b89e4dc55`');
    expect(entry).to.include('96b78122449efed596ed53535d9aedc481350077728a7a958c3cbd2858fea76b probe.js');
    expect(entry).to.include('BATCH_FEE_QUOTE');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
    expect(entry).to.include('**Direction: NEUTRAL for validity.**');
}

describe('pre-flight constants + registry drift map (§8.5) gate retirement reviews', function () {
    it('pins and records the mandatory-native BATCH fee quote review', batchFeeQuoteReview);
    it('pins and records the filling-offer fee lookup review', batchMatchFeeReview);
});
