// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Drift guard: the SDK's contract-ABI extraction core is a byte-identical
// vendored copy of the canonical xchain-explorer implementation, so the SDK
// and the explorer can never disagree on what a contract's declared abi is
// (same pattern as the lint-core guard in contract_parity.test.js). Skipped
// when the sibling explorer checkout is absent (standalone clone); the root
// bin/ci-all.sh guard (xchain-explorer/bin/sync-abi-core.sh --check) covers
// the monorepo layout regardless.

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const EXPLORER  = path.join(__dirname, '..', '..', '..', 'xchain-explorer');
const VENDORED  = path.join(__dirname, '..', '..', 'src', 'contract', 'abi-core.js');

// The explorer is moving its canonical copy from src/abi-core.js to
// src/contract/abi_core.js, and the two repos push separately, so between the
// two pushes either spelling can be the one on disk. Newest first, and a
// checkout carrying NEITHER is a hard failure rather than a skip: skipping
// there would compare nothing and still read green, which is exactly the
// failure this guard exists to make impossible.
const CANONICAL_SPELLINGS = [
    path.join('src', 'contract', 'abi_core.js'),
    path.join('src', 'abi-core.js'),
];

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// The first spelling present, or null when the explorer carries none of them.
function resolveCanonical() {
    for (const rel of CANONICAL_SPELLINGS) {
        const candidate = path.join(EXPLORER, rel);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

describe('abi-core drift guard @regression', function () {
    it('src/contract/abi-core.js matches the canonical xchain-explorer/src/abi-core.js', function () {
        // Absence of the whole sibling checkout is the standalone-clone case the
        // header describes; XCHAIN_REQUIRE_SIBLINGS=1 turns it into a failure the
        // same way the explorer-route contract guard does.
        if (!fs.existsSync(path.join(EXPLORER, 'src'))) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling xchain-explorer checkout not found at ' + EXPLORER);
            }
            return this.skip();
        }
        const canonical = resolveCanonical();
        assert.ok(canonical,
            'sibling xchain-explorer checkout is present but carries no canonical abi core; tried ' +
            CANONICAL_SPELLINGS.join(' and ') + ' under ' + EXPLORER);
        assert.strictEqual(
            sha256(VENDORED), sha256(canonical),
            'VENDOR DRIFT: abi-core.js differs from the xchain-explorer canonical at ' +
            path.relative(EXPLORER, canonical) + '; ' +
            'edit the canonical there and run xchain-explorer/bin/sync-abi-core.sh.'
        );
    });

    it('ContractUtils.parseAbi delegates to the vendored core (same object out)', function () {
        const ContractUtils = require('../../src/contract/utils.js');
        const abiCore       = require('../../src/contract/abi-core.js');
        const src = `module.exports = {
            abi: { version: 1, methods: { run: { summary: 'Run', params: [{ name: 'x', type: 'string' }] } } },
            run: function(xchain){}
        };`;
        assert.deepStrictEqual(new ContractUtils().parseAbi(src), abiCore.parseAbi(src));
    });
});
