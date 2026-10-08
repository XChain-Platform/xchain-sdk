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
const DEFAULT_VM_DIR = process.env.XCHAIN_VM_DIR || path.join(SIBLING_ROOT, 'xchain-vm');
const VM_COMMIT = 'f845c2e83bf5c1c18b82298de887a935ddee9054';
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

const FILES = [
    'lint-core.js',
    'lint-core/banned_with.js',
    'lint-core/constants.js',
    'lint-core/result_composition.js'
];

function canonicalWorktree() {
    if (process.env.XCHAIN_VM_DIR || !fs.existsSync(DEFAULT_VM_DIR)) return DEFAULT_VM_DIR;
    try {
        const records = childProcess.execFileSync(
            'git',
            ['-C', DEFAULT_VM_DIR, 'worktree', 'list', '--porcelain'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim().split(/\n\n+/);
        for (const record of records) {
            const lines = record.split('\n');
            const head = lines.find((line) => line.startsWith('HEAD '));
            if (!head) continue;
            const unchanged = childProcess.spawnSync(
                'git',
                ['-C', DEFAULT_VM_DIR, 'diff', '--quiet', VM_COMMIT, head.slice('HEAD '.length), '--']
                    .concat(FILES.map((relative) => 'src/' + relative)),
                { stdio: 'ignore' }
            );
            if (unchanged.status !== 0) continue;
            const worktree = lines.find((line) => line.startsWith('worktree '));
            if (worktree) return worktree.slice('worktree '.length);
        }
    } catch (_) {
    }
    return DEFAULT_VM_DIR;
}

const VM_DIR = canonicalWorktree();
if (!process.env.XCHAIN_VM_DIR && VM_DIR !== DEFAULT_VM_DIR) process.env.XCHAIN_VM_DIR = VM_DIR;

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
