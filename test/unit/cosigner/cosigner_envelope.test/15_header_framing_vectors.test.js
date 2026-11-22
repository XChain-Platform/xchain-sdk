/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseEnvelopeScript } = require('../../../../src/cosigner/envelope.js');

const DOCS = process.env.XCHAIN_DOCS_DIR || process.env.XCHAIN_DOCUMENTATION_DIR ||
    path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-documentation');
const VECTORS_PATH = path.join(DOCS, 'protocol', 'test-vectors', 'taproot_envelope.json');

describe('cosigner envelope header framing vectors', function () {
    let vectors;

    before(function () {
        if (!fs.existsSync(VECTORS_PATH)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error(`xchain-documentation sibling not found at ${VECTORS_PATH}`);
            this.skip();
        }
        vectors = require(VECTORS_PATH);
    });

    it('runs every framing vector against parseEnvelopeScript', function () {
        const expectedPayload = vectors.envelope_grammar.compiled_payload_hex;
        const expectedKey = vectors.envelope_grammar.internal_pubkey_xonly;
        const seen = new Set();
        for (const entry of vectors.header_framing.vectors) {
            const result = parseEnvelopeScript(Buffer.from(entry.envelope_script_hex, 'hex'));
            if (entry.expect === 'recognized') {
                assert.ok(result, `${entry.name} must be recognized`);
                assert.strictEqual(result.payload.toString('hex'), expectedPayload, entry.name);
                assert.strictEqual(result.checksigKey.toString('hex'), expectedKey, entry.name);
            } else if (entry.expect === 'not_recognized') {
                assert.strictEqual(result, null, entry.name);
            } else {
                assert.fail(`unknown header-framing expect ${entry.expect} for ${entry.name}`);
            }
            seen.add(entry.expect);
        }
        assert.ok(vectors.header_framing.vectors.length >= 5, 'header-framing corpus shrank');
        assert.deepStrictEqual([...seen].sort(), ['not_recognized', 'recognized']);
    });
});
