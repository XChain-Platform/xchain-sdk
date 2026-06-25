// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-repo ACTION-manifest conformance guard. The SDK Formats are the
// user-encodable action set; a new user action missing here cannot be authored
// via the SDK. The authoritative set lives in
// xchain-documentation/protocol/action-manifest.json (vendored here). This guard
// asserts the SDK Formats keys equal the manifest's userEncodable slice.

const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const VENDORED = path.join(__dirname, '..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));
const Formats  = require('../../src/formats.js');

function manifestSlice(flag) {
    return Object.entries(MANIFEST.actions).filter(([, v]) => v[flag]).map(([k]) => k).sort();
}
function localSdkSet() {
    return Object.keys(Formats).filter(k => /^[A-Z_]+$/.test(k)).sort();
}

describe('ACTION manifest conformance: sdk userEncodable set @regression', function () {
    it('Formats keys exactly equal the manifest userEncodable slice', function () {
        const expected = manifestSlice('userEncodable');
        const actual   = localSdkSet();
        const missing = expected.filter(a => !actual.includes(a)); // manifest says encodable, SDK forgot
        const extra   = actual.filter(a => !expected.includes(a));  // SDK encodes, manifest unaware
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
            'sdk Formats drifted from action-manifest.json userEncodable set. ' +
            'MISSING (in manifest, no SDK Format -> users cannot author it): ' + JSON.stringify(missing) +
            '. EXTRA (SDK Format, not in manifest): ' + JSON.stringify(extra) +
            '. Edit xchain-documentation/protocol/action-manifest.json + re-vendor, or add the Format.');
    });

    describe('byte-identity to canonical manifest', function () {
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        before(function () { if (!fs.existsSync(CANON)) this.skip(); });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });
});
