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
const VM_COMMIT = 'b9768df225b789ae8389afc22347660d6461753b';
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

const FILES = [
    'lint-core.js',
    'lint-core/banned_globals.js',
    'lint-core/banned_syntax.js',
    'lint-core/banned_with.js',
    'lint-core/constants.js',
    'lint-core/contract_analysis.js',
    'lint-core/nesting_depth.js',
    'lint-core/result_composition.js',
    'lint-core/scope_analysis.js'
];

const VENDOR_PATHS = [
    'src/lint-core.js',
    'src/metering.js',
    'src/stripped-globals.js',
    'src/lint-core',
    'src/metering'
];

function canonicalWorktree() {
    if (!fs.existsSync(DEFAULT_VM_DIR)) return DEFAULT_VM_DIR;
    try {
        const records = childProcess.execFileSync(
            'git',
            ['-C', DEFAULT_VM_DIR, 'worktree', 'list', '--porcelain'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim().split(/\n\n+/);
        for (const record of records) {
            const lines = record.split('\n');
            const worktree = lines.find((line) => line.startsWith('worktree '));
            if (!worktree) continue;
            const worktreeDir = worktree.slice('worktree '.length);
            const unchanged = childProcess.spawnSync(
                'git',
                ['-C', worktreeDir, 'diff', '--quiet', VM_COMMIT, '--'].concat(VENDOR_PATHS),
                { stdio: 'ignore' }
            );
            if (unchanged.status !== 0) continue;
            return worktreeDir;
        }
    } catch (_) {
    }
    return DEFAULT_VM_DIR;
}

const VM_DIR = canonicalWorktree();
if (VM_DIR !== DEFAULT_VM_DIR) process.env.XCHAIN_VM_DIR = VM_DIR;

function hasCanonicalCommit() {
    return childProcess.spawnSync(
        'git',
        ['-C', VM_DIR, 'cat-file', '-e', VM_COMMIT + '^{commit}'],
        { stdio: 'ignore' }
    ).status === 0;
}

// CI clones each sibling with --depth 1, so the pinned commit is absent there
// even when it is an ancestor of the sibling's tip. Fetch that one commit into
// a shallow clone, once per run, rather than reading the ambient tip instead.
let canonicalCommitReadable = null;
function canonicalCommitAvailable() {
    if (canonicalCommitReadable !== null) return canonicalCommitReadable;
    canonicalCommitReadable = hasCanonicalCommit();
    if (!canonicalCommitReadable) {
        const shallow = childProcess.spawnSync(
            'git',
            ['-C', VM_DIR, 'rev-parse', '--is-shallow-repository'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        if (shallow.status === 0 && shallow.stdout.trim() === 'true') {
            childProcess.spawnSync(
                'git',
                ['-C', VM_DIR, 'fetch', '--quiet', '--no-tags', '--depth', '1', 'origin', VM_COMMIT],
                { stdio: 'ignore', timeout: 60000 }
            );
            canonicalCommitReadable = hasCanonicalCommit();
        }
    }
    return canonicalCommitReadable;
}

function requireSibling(ctx) {
    if (fs.existsSync(VM_DIR) && canonicalCommitAvailable()) return true;
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

describe('vendored deploy-lint: pinned lint-core byte parity', function () {
    before(function () {
        this.timeout(90000);
        if (fs.existsSync(VM_DIR)) canonicalCommitAvailable();
    });

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
