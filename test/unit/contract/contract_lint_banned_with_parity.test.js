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
 **********************************************************************
 * Banned-with vendored-copy parity.
 ********************************************************************/
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SDK_CONTRACT_DIR = path.join(__dirname, '..', '..', '..', 'src', 'contract');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(SDK_CONTRACT_DIR, '..', '..', '..');
const VM_SRC_DIR = path.join(process.env.XCHAIN_VM_DIR || path.join(SIBLING_ROOT, 'xchain-vm'), 'src');
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

const FILES = [
    'lint-core.js',
    'lint-core/banned_with.js',
    'lint-core/constants.js',
    'lint-core/result_composition.js'
];

function requireSibling(ctx) {
    if (fs.existsSync(VM_SRC_DIR)) return true;
    if (SIBLING_REQUIRED) {
        throw new Error('banned-with parity guard cannot run: required sibling missing at ' + VM_SRC_DIR);
    }
    ctx.skip();
    return false;
}

describe('vendored deploy-lint: banned-with byte parity', function () {
    for (const relative of FILES) {
        it('src/contract/' + relative + ' matches xchain-vm/src/' + relative, function () {
            if (!requireSibling(this)) return;

            const vendored = path.join(SDK_CONTRACT_DIR, relative);
            const canonical = path.join(VM_SRC_DIR, relative);
            assert.ok(fs.existsSync(canonical), 'missing canonical xchain-vm file: ' + canonical);
            assert.strictEqual(
                Buffer.compare(fs.readFileSync(vendored), fs.readFileSync(canonical)),
                0,
                'vendored file differs byte for byte from xchain-vm: ' + relative
            );
        });
    }
});
