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
const VM_COMMIT = 'ecc7296f99a95c488e71dd5ebe9c3872880f18f3';
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

// Read the pinned blobs through the sibling itself (every worktree shares its object store), and
// never write XCHAIN_VM_DIR: the other parity guards read it at load and must see the sibling.
const VM_DIR = DEFAULT_VM_DIR;

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

// Find every test-module assignment to a sibling location variable (one file's write moves
// every guard that reads the variable at load onto a tree the run never named).
function siblingEnvWrites(root, dir = root) {
    const hits = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { hits.push(...siblingEnvWrites(root, full)); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const pattern = /process\.env(?:\.XCHAIN_\w*(?:DIR|PATH|ROOT)|\[\s*['"]XCHAIN_\w*(?:DIR|PATH|ROOT)['"]\s*\])\s*=(?!=)/;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            if (pattern.test(line)) hits.push(path.relative(root, full) + ':' + (i + 1));
        });
    }
    return hits;
}

describe('vendored deploy-lint: sibling location stays with the run', function () {
    it('no test module assigns an XCHAIN_ sibling directory, path or root variable', function () {
        const testRoot = path.join(__dirname, '..', '..');
        assert.deepStrictEqual(siblingEnvWrites(testRoot), [],
            'a test module rewrites a sibling location variable that other guards read at load');
    });
});
