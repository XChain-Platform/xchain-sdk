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
// (same pattern as the lint-core guard in contract-parity.test.js). Skipped
// when the sibling explorer checkout is absent (standalone clone); the root
// bin/ci-all.sh guard (xchain-explorer/bin/sync-abi-core.sh --check) covers
// the monorepo layout regardless.

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const VENDORED  = path.join(__dirname, '..', '..', 'src', 'contract', 'abi-core.js');
const CANONICAL = path.join(__dirname, '..', '..', '..', 'xchain-explorer', 'src', 'abi-core.js');

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('abi-core drift guard @regression', function () {
    it('src/contract/abi-core.js matches the canonical xchain-explorer/src/abi-core.js', function () {
        if (!fs.existsSync(CANONICAL)) return this.skip();
        assert.strictEqual(
            sha256(VENDORED), sha256(CANONICAL),
            'VENDOR DRIFT: abi-core.js differs from the xchain-explorer canonical; ' +
            'edit xchain-explorer/src/abi-core.js and run xchain-explorer/bin/sync-abi-core.sh.'
        );
    });

    it('ContractUtils.parseAbi delegates to the vendored core (same object out)', function () {
        const ContractUtils = require('../../src/contracts.js');
        const abiCore       = require('../../src/contract/abi-core.js');
        const src = `module.exports = {
            abi: { version: 1, methods: { run: { summary: 'Run', params: [{ name: 'x', type: 'string' }] } } },
            run: function(xchain){}
        };`;
        assert.deepStrictEqual(new ContractUtils().parseAbi(src), abiCore.parseAbi(src));
    });
});
