// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Unit coverage for src/tickRefFields.js, the canonical map of which ACTION
// params name an EXISTING token and which of those the SDK may compact to the
// `^<id>` wire form.
//
// The drift guard at the bottom is the point of the file. The list used to be
// hand-restated at each call site, so FILE.GATE_TICKER was a tick-bearing field
// no copy carried: nothing compared any of them to formats.js, which is where
// the field names actually come from.

'use strict';

const assert = require('assert');

const { TICK_REF_FIELDS, TICK_NO_COMPACT_FIELDS, TICK_EXISTENCE_FIELDS } = require('../../src/tickRefFields.js');
const formats = require('../../src/formats.js');

// Every field name in every ACTION format version whose name denotes a ticker.
// Read out of the format strings rather than hand-listed, so a tick-bearing
// field added to a format cannot land unclassified.
function tickBearingFormatFields() {
    const found = new Set();
    for (const action of Object.keys(formats)) {
        const versions = formats[action];
        for (const version of Object.keys(versions)) {
            const spec = versions[version];
            if (typeof spec !== 'string') continue;
            for (const field of spec.split('|'))
                if (/TICK(ER)?$/.test(field.trim())) found.add(field.trim());
        }
    }
    return Array.from(found).sort();
}

describe('tickRefFields', function () {
    it('classifies the five compactable tick-reference fields', function () {
        assert.deepStrictEqual([...TICK_REF_FIELDS].sort(),
            ['CALLBACK_TICK', 'DIVIDEND_TICK', 'GET_TICK', 'GIVE_TICK', 'TICK']);
    });

    // Compacting GATE_TICKER validates and then silently un-gates the file: the
    // indexer stores the value verbatim in gated_files.gate_ticker and enforces
    // gating with `WHERE gf.gate_ticker = ?`, keyed by ticker NAME, so a stored
    // `^1234` matches no lookup. This assertion is the thing standing between a
    // future reader and re-filing "GATE_TICKER is missing from the list".
    it('holds FILE.GATE_TICKER back from compaction but keeps it existence-checkable', function () {
        assert.ok(!TICK_REF_FIELDS.includes('GATE_TICKER'),
            'GATE_TICKER must never be compacted to ^<id>: the indexer joins gated_files.gate_ticker by literal string');
        assert.ok(TICK_NO_COMPACT_FIELDS.includes('GATE_TICKER'));
        assert.ok(TICK_EXISTENCE_FIELDS.includes('GATE_TICKER'));
    });

    it('the existence set is the union, with no field in both roles', function () {
        assert.deepStrictEqual([...TICK_EXISTENCE_FIELDS].sort(),
            [...TICK_REF_FIELDS, ...TICK_NO_COMPACT_FIELDS].sort());
        for (const field of TICK_NO_COMPACT_FIELDS)
            assert.ok(!TICK_REF_FIELDS.includes(field), field + ' cannot be both compactable and held back');
        assert.strictEqual(new Set(TICK_EXISTENCE_FIELDS).size, TICK_EXISTENCE_FIELDS.length);
    });

    it('the compaction resolver and the pre-flight existence check both derive from this module', function () {
        // No independent literal may survive at either call site: that is how the
        // two runtime copies drifted apart in the first place.
        const resolverSrc = require('fs').readFileSync(require.resolve('../../src/tickResolver.js'), 'utf8');
        const preflightSrc = require('fs').readFileSync(require.resolve('../../src/preflight/universal.js'), 'utf8');
        assert.ok(/require\(['"]\.\/tickRefFields\.js['"]\)/.test(resolverSrc),
            'tickResolver.js must take its field set from tickRefFields.js');
        assert.ok(/require\(['"]\.\.\/tickRefFields\.js['"]\)/.test(preflightSrc),
            'preflight/universal.js must take its field set from tickRefFields.js');

        const { TICK_FIELDS } = require('../../src/preflight/universal.js');
        assert.deepStrictEqual(TICK_FIELDS, TICK_EXISTENCE_FIELDS);
    });

    it('every tick-bearing field in formats.js is classified', function () {
        const inFormats = tickBearingFormatFields();
        const classified = [...TICK_EXISTENCE_FIELDS].sort();
        assert.deepStrictEqual(inFormats, classified,
            'a tick-bearing ACTION field is unclassified (or classified but gone from formats.js): ' +
            'add it to tickRefFields.js as compactable, or hold it back with the reason written down');
    });
});
