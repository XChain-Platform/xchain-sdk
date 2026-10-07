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
// xchain-documentation/protocol/action-manifest.json (vendored here).
//
// The guard asserts the SDK Formats match the manifest at TWO depths:
//   1. ACTION level: Formats keys equal the manifest userEncodable slice.
//   2. VERSION level: each Formats[ACTION] version set equals that action's
//      manifest userEncodableVersions array.
// Depth 2 exists because userEncodable is an action-level boolean, so before it
// a system-only VERSION could be added to an authorable action's Formats and
// every guard stayed green: VOTE v2 (finalize) and PRICE v0 (validator PBFT
// snapshot) are parsed by the indexer but rejected from a user broadcast, and
// nothing but a code comment stood between them and an SDK Format that builds a
// command guaranteed to be rejected on arrival.

const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const VENDORED = path.join(__dirname, '../..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));
const Formats  = require('../../../src/protocol/formats.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const SETTLEMENT_ANCHORS = ['LIST_SHARE', 'XPOLICY'];

const EDIT_HINT = 'Edit xchain-documentation/protocol/action-manifest.json, re-vendor with ' +
                  'bin/sync-action-manifest.sh, or change src/protocol/formats.js.';

function manifestSlice(flag) {
    return Object.entries(MANIFEST.actions).filter(([, v]) => v[flag]).map(([k]) => k).sort();
}
function localSdkSet() {
    return Object.keys(Formats).filter(k => /^[A-Z_]+$/.test(k)).sort();
}
// Version keys are JS object keys (strings) on the SDK side and JSON numbers in
// the manifest; both sides normalize to sorted numbers so the comparison is on
// the versions themselves, not on their spelling.
function sdkVersions(action) {
    return Object.keys(Formats[action]).map(Number).sort((a, b) => a - b);
}
function manifestVersions(action) {
    return (MANIFEST.actions[action].userEncodableVersions || []).slice().sort((a, b) => a - b);
}
// missing = manifest allows the version, SDK has no Format for it.
// extra   = SDK builds the version, the manifest does not allow it.
function diffVersions(expected, actual) {
    return {
        missing: expected.filter(v => !actual.includes(v)),
        extra:   actual.filter(v => !expected.includes(v))
    };
}

describe('ACTION manifest conformance: sdk userEncodable set @regression', function () {
    it('keeps settlement anchors explorer-only and outside SDK Formats', function () {
        assert.strictEqual(typeof MANIFEST.categories['settlement-anchor'], 'string');
        const members = Object.keys(MANIFEST.actions)
            .filter(action => MANIFEST.actions[action].category === 'settlement-anchor')
            .sort();
        assert.deepStrictEqual(members, SETTLEMENT_ANCHORS);
        for (const action of SETTLEMENT_ANCHORS) {
            assert.deepStrictEqual(MANIFEST.actions[action], {
                category: 'settlement-anchor',
                explorerRender: true
            });
            assert.strictEqual(Formats[action], undefined,
                action + ' is an indexer-minted settlement anchor, not an SDK-authored action');
        }
    });

    it('Formats keys exactly equal the manifest userEncodable slice', function () {
        const expected = manifestSlice('userEncodable');
        const actual   = localSdkSet();
        const missing = expected.filter(a => !actual.includes(a)); // manifest says encodable, SDK forgot
        const extra   = actual.filter(a => !expected.includes(a));  // SDK encodes, manifest unaware
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
            'sdk Formats drifted from action-manifest.json userEncodable set. ' +
            'MISSING (in manifest, no SDK Format -> users cannot author it): ' + JSON.stringify(missing) +
            '. EXTRA (SDK Format, not in manifest): ' + JSON.stringify(extra) +
            '. ' + EDIT_HINT);
    });

    registerUserEncodableVersionsShapeTests();

    it('each Formats[ACTION] version set exactly equals its manifest userEncodableVersions', function () {
        const drift = {};
        for (const action of manifestSlice('userEncodable')) {
            if (!Formats[action]) continue; // already reported by the action-level assertion
            const { missing, extra } = diffVersions(manifestVersions(action), sdkVersions(action));
            if (missing.length || extra.length) drift[action] = { missing, extra };
        }
        assert.deepStrictEqual(drift, {},
            'sdk Formats drifted from action-manifest.json userEncodableVersions: ' + JSON.stringify(drift) +
            '. MISSING = the manifest says a user may author that VERSION and the SDK has no Format for it. ' +
            'EXTRA = the SDK builds a VERSION the manifest does not list as user-authorable, which for a ' +
            'system-only version (VOTE v2, PRICE v0) means composing a command the indexer rejects on arrival. ' +
            EDIT_HINT);
    });

    // The comparison above only protects anything if it actually reports a
    // system-only version appearing in the SDK, which is the case that used to
    // pass silently. Pin that on synthetic inputs so a future refactor of the
    // guard cannot quietly turn it into a no-op that is green for both reasons.
    it('the version comparison flags a system-only version added to an authorable action', function () {
        assert.deepStrictEqual(diffVersions([0, 1, 3], [0, 1, 2, 3]), { missing: [], extra: [2] },
            'VOTE v2 added to Formats must report as extra');
        assert.deepStrictEqual(diffVersions([1], [0, 1]), { missing: [], extra: [0] },
            'PRICE v0 added to Formats must report as extra');
        assert.deepStrictEqual(diffVersions([0, 1], [0]), { missing: [1], extra: [] },
            'a newly authorable version the SDK lacks must report as missing');
        assert.deepStrictEqual(diffVersions([0, 1], [0, 1]), { missing: [], extra: [] },
            'a matching version set must report clean');
    });

    registerIndexerHandlerAuditTests();

    describe('byte-identity to canonical manifest', function () {
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '../..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        // Refuses an absent docs checkout and a lane symlink into a live main checkout alike.
        before(function () { const docs = siblingCheckout(__dirname, CANON); if (!docs.usable) skipOrFail(this, docs, 'the canonical action-manifest.json byte-identity guard'); });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });
});

// The version arrays are only load-bearing if they are present and shaped
// right on exactly the authorable actions; a missing or malformed array
// would otherwise degrade the per-version check into a silent no-op.
function registerUserEncodableVersionsShapeTests() {
    describe('userEncodableVersions shape', function () {
        it('every userEncodable action carries a sorted, unique, non-empty version array', function () {
            const bad = [];
            for (const action of manifestSlice('userEncodable')) {
                const v = MANIFEST.actions[action].userEncodableVersions;
                if (!Array.isArray(v) || v.length === 0) { bad.push(action + ': missing or empty'); continue; }
                if (!v.every(n => Number.isInteger(n) && n >= 0)) { bad.push(action + ': non-integer version'); continue; }
                if (new Set(v).size !== v.length) { bad.push(action + ': duplicate version'); continue; }
                if (v.some((n, i) => i > 0 && n <= v[i - 1])) bad.push(action + ': not ascending');
            }
            assert.deepStrictEqual(bad, [],
                'action-manifest.json userEncodableVersions is malformed: ' + JSON.stringify(bad) +
                '. Every userEncodable action needs one ascending array of the FORMAT versions a user may author.');
        });

        it('no non-userEncodable action carries a version array', function () {
            const stray = Object.entries(MANIFEST.actions)
                .filter(([, v]) => !v.userEncodable && v.userEncodableVersions !== undefined)
                .map(([k]) => k);
            assert.deepStrictEqual(stray, [],
                'userEncodableVersions on an action that is not userEncodable: ' + JSON.stringify(stray) +
                '. Either flip userEncodable or drop the array; a version list on a non-authorable action ' +
                'claims an authoring surface no guard checks.');
        });
    });
}

// Cross-check the audit itself against the indexer when the sibling is on
// disk. The manifest arrays were hand-audited against xchain-indexer's
// handlers, and a wrong entry fakes drift in this repo forever; this catches
// the mechanically checkable half, a version listed as authorable that the
// indexer cannot parse at all. The other half (a version the indexer parses
// but only accepts when it synthesized it, e.g. VOTE v2) stays a documented
// hand audit, recorded in the manifest notes.
// The indexer loader accepts flat handler modules and feature directories
// whose entry is index.js. Resolving both forms keeps the audit aligned
// with the loader and prevents false unsupported-action reports.
function handlerFile(actionsDir, action) {
    const base = path.join(actionsDir, action.toLowerCase());
    for (const candidate of [base + '.js', path.join(base, 'index.js')])
        if (fs.existsSync(candidate)) return candidate;
    return null;
}

// A handler may keep every format in one file or split them across a
// same-named companion directory (list.js beside list/); the companion is
// optional. Formats are declared either as this.formats[N] literals or as
// { format: N, fields: ... } specs.
function declaredFormats(actionsDir, action) {
    const file = handlerFile(actionsDir, action);
    if (!file) return null;
    const files = new Set([file]);
    const companion = path.join(actionsDir, action.toLowerCase());
    if (fs.existsSync(companion) && fs.statSync(companion).isDirectory()) {
        for (const name of fs.readdirSync(companion).sort())
            if (name.endsWith('.js')) files.add(path.join(companion, name));
    }
    const declared = new Set();
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/this\.formats\[(\d+)\]/g)) declared.add(Number(m[1]));
        for (const m of src.matchAll(/\bformat:\s*(\d+),\s*fields:/g)) declared.add(Number(m[1]));
    }
    return declared;
}

function registerIndexerHandlerAuditTests() {
    describe('declaredFormats scan', function () {
        it('reads the handler file and its companion directory, and tolerates an absent one', function () {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-formats-'));
            try {
                fs.writeFileSync(path.join(dir, 'list.js'),
                    'this.formats[0] = a;\nthis.formats[1] = b;\n');
                assert.deepStrictEqual([...declaredFormats(dir, 'LIST')].sort(), [0, 1]);

                fs.mkdirSync(path.join(dir, 'list'));
                fs.writeFileSync(path.join(dir, 'list', 'share.js'),
                    'module.exports = () => ({ format: 2, fields: SHARE_FIELDS, gate });\n');
                assert.deepStrictEqual([...declaredFormats(dir, 'LIST')].sort(), [0, 1, 2]);

                fs.rmSync(path.join(dir, 'list', 'share.js'));
                assert.deepStrictEqual([...declaredFormats(dir, 'LIST')].sort(), [0, 1]);
                assert.strictEqual(declaredFormats(dir, 'MISSING'), null);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('audit against the indexer handlers', function () {
        const INDEXER = process.env.XCHAIN_INDEXER_DIR ||
                        path.join(__dirname, '../..', '..', '..', 'xchain-indexer');
        const ACTIONS_DIR = path.join(INDEXER, 'src', 'actions');
        // Refuses an absent indexer checkout and a lane symlink into a live main checkout alike.
        before(function () {
            const indexer = siblingCheckout(__dirname, ACTIONS_DIR);
            if (!indexer.usable) skipOrFail(this, indexer, 'the indexer-handler audit');
        });

        it('every userEncodableVersions entry is a FORMAT the indexer parses', function () {
            const unparsable = {};
            const unmapped   = [];
            for (const action of manifestSlice('userEncodable')) {
                const declared = declaredFormats(ACTIONS_DIR, action);
                if (!declared) { unmapped.push(action); continue; }
                const gap = manifestVersions(action).filter(v => !declared.has(v));
                if (gap.length) unparsable[action] = gap;
            }
            assert.deepStrictEqual(unmapped, [],
                'no indexer handler file for: ' + JSON.stringify(unmapped) +
                '. A user-encodable action the indexer does not handle cannot be authored to any effect.');
            assert.deepStrictEqual(unparsable, {},
                'action-manifest.json lists versions the indexer has no format for: ' + JSON.stringify(unparsable) +
                '. Such a version is rejected as "invalid: VERSION (unknown)" on arrival, so listing it as ' +
                'user-encodable would force an SDK Format that can only build dead transactions.');
        });
    });
}
