// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Parity guard: src/contract/utils/meta_literals.js is a hand-kept client mirror
// of the indexer's CONTRACT_META_REQUIRED grammar, and the SDK BLOCKS a deploy on
// its verdict by default. If the chain tightens the grammar the author gets a false
// green and pays for an on-chain CONTRACT_MANIFEST reject; if it loosens, the SDK
// refuses a deploy the chain accepts. This compares behaviour, not bytes, against
// xchain-indexer src/actions/deploy/contract_meta.js, so it goes red in both
// directions. Skipped when the sibling is absent; fails under XCHAIN_REQUIRE_SIBLINGS=1.

const assert = require('assert');
const path = require('path');

const sdk = require('../../../src/contract/utils/meta_literals.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_PATH
    || path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer');
const INDEXER_CONTRACT_META = path.join(INDEXER_ROOT, 'src', 'actions', 'deploy', 'contract_meta.js');

// Verdict rows only the isolate can judge (a static pre-flight cannot see them), so the SDK does not mirror them.
const ISOLATE_ONLY_VERDICTS = ['READ_FAILED', 'NOT_OBJECT', 'OVERSIZE'];

// Build the four placements a code point is judged in: alone, interior, leading, trailing.
function placements(ch) {
    return [ch, 'a' + ch + 'a', ch + 'a', 'a' + ch];
}

// Collect every input where the two implementations disagree, capped so a message stays readable.
function mismatches(indexer, inputs) {
    const out = [];
    for (const [s, maxBytes, allowLf] of inputs) {
        if (sdk.isValidMetaText(s, maxBytes, allowLf) !== indexer.isValidMetaText(s, maxBytes, allowLf)) {
            out.push(JSON.stringify(s).slice(0, 40) + ' max=' + maxBytes + ' allowLf=' + allowLf);
            if (out.length >= 20) break;
        }
    }
    return out;
}

// Name each disagreeing code point as U+XXXX with its placement and allowLf.
function sweepCodePoints(indexer) {
    const out = [];
    const where = ['alone', 'interior', 'leading', 'trailing'];
    for (let cp = 0; cp <= 0x10FFFF && out.length < 20; cp++) {
        if (cp >= 0xD800 && cp <= 0xDFFF) continue;
        const forms = placements(String.fromCodePoint(cp));
        for (const allowLf of [false, true]) {
            forms.forEach((s, i) => {
                if (sdk.isValidMetaText(s, 512, allowLf) !== indexer.isValidMetaText(s, 512, allowLf))
                    out.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0') + ' ' + where[i] + ' allowLf=' + allowLf);
            });
        }
    }
    return out;
}

// Build strings exactly at each field's byte cap and one character past it, for 1..4-byte characters.
function capBoundaryInputs() {
    const inputs = [['', 64, false], ['', 512, true]];
    for (const [cap, allowLf] of [[64, false], [512, true], [32, false]]) {
        for (const ch of ['a', 'é', '€', '\u{1F600}']) {
            const width = Buffer.byteLength(ch, 'utf8');
            const atCap = ch.repeat(Math.floor(cap / width));
            inputs.push([atCap, cap, allowLf], [atCap + ch, cap, allowLf]);
        }
    }
    return inputs;
}

describe('contract meta grammar parity (SDK mirror vs xchain-indexer contract_meta.js)', function () {
    let indexer = null;

    before(function () {
        const verdict = siblingCheckout(__dirname, INDEXER_CONTRACT_META);
        if (!skipOrFail(this, verdict, 'the contract meta grammar parity guard')) return;
        indexer = require(verdict.path);
    });

    it('mirrors every verdict string the static pre-flight can judge, byte for byte', function () {
        for (const [key, text] of Object.entries(sdk.META_VERDICTS)) {
            assert.strictEqual(text, indexer.VERDICTS[key], 'SDK META_VERDICTS.' + key + ' differs from the indexer verdict');
        }
    });

    it('the indexer verdict set is the SDK set plus the isolate-only rows', function () {
        const expected = Object.keys(sdk.META_VERDICTS).concat(ISOLATE_ONLY_VERDICTS).sort();
        assert.deepStrictEqual(Object.keys(indexer.VERDICTS).sort(), expected,
            'a CONTRACT_MANIFEST verdict row was added or removed on the indexer; decide whether the SDK pre-flight mirrors it');
    });

    it('mirrors the three byte caps', function () {
        for (const cap of ['META_NAME_MAX_BYTES', 'META_DESCRIPTION_MAX_BYTES', 'META_VERSION_MAX_BYTES']) {
            assert.strictEqual(sdk[cap], indexer[cap], cap + ' differs from the indexer');
        }
    });

    it('the indexer grammar still takes exactly (s, maxBytes, allowLf)', function () {
        assert.strictEqual(indexer.isValidMetaText.length, 3,
            'isValidMetaText gained or lost a parameter; a flag-gated rule would leave this sweep comparing only the old path');
    });

    it('agrees on every code point in every placement', function () {
        this.timeout(120000);
        const bad = sweepCodePoints(indexer);
        assert.deepStrictEqual(bad, [], 'SDK meta grammar disagrees with the indexer at: ' + bad.join(', '));
    });

    it('agrees at every byte-cap boundary and on non-string and ill-formed input', function () {
        const odd = [undefined, null, 0, 1, true, {}, [], '\uD800', '\uDC00', '\uDC00\uD800', 'ab\uD800cd'];
        const inputs = capBoundaryInputs().concat(odd.map((s) => [s, 64, false]));
        const bad = mismatches(indexer, inputs);
        assert.deepStrictEqual(bad, [], 'SDK meta grammar disagrees with the indexer on: ' + bad.join('; '));
    });
});
