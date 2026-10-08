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
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const SDK_CONTRACT_DIR = path.join(__dirname, '..', '..', '..', 'src', 'contract');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(SDK_CONTRACT_DIR, '..', '..', '..');
const VM_DIR = process.env.XCHAIN_VM_DIR || path.join(SIBLING_ROOT, 'xchain-vm');
const VM_COMMIT = 'ea12b0b621d1269e2c8d56089a4b4697b22ae652';
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

const FILES = [
    'lint-core.js',
    'lint-core/banned_with.js',
    'lint-core/constants.js',
    'lint-core/result_composition.js'
];

function requireSibling(ctx) {
    if (fs.existsSync(VM_DIR)) {
        try {
            childProcess.execFileSync(
                'git',
                ['-C', VM_DIR, 'cat-file', '-e', VM_COMMIT + '^{commit}'],
                { stdio: 'ignore' }
            );
            return true;
        } catch (_) {
        }
    }
    if (SIBLING_REQUIRED) {
        throw new Error('banned-with parity guard cannot read canonical commit from sibling at ' + VM_DIR);
    }
    ctx.skip();
    return false;
}

function readCanonical(relative) {
    return childProcess.execFileSync(
        'git',
        ['-C', VM_DIR, 'show', VM_COMMIT + ':src/' + relative],
        { encoding: null, stdio: ['ignore', 'pipe', 'pipe'] }
    );
}

describe('vendored deploy-lint: banned-with byte parity', function () {
    for (const relative of FILES) {
        it('src/contract/' + relative + ' matches xchain-vm/src/' + relative, function () {
            if (!requireSibling(this)) return;

            const vendored = path.join(SDK_CONTRACT_DIR, relative);
            assert.strictEqual(
                Buffer.compare(fs.readFileSync(vendored), readCanonical(relative)),
                0,
                'vendored file differs byte for byte from xchain-vm: ' + relative
            );
        });
    }
});
