/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { resolveBase, selectFastTests } = require('../ci_fast_select.js');

function outputLines(value) {
    return String(value || '').split(/\r?\n/).filter(Boolean);
}

function listTests() {
    return outputLines(execFileSync('git', ['ls-files', 'test'], { encoding: 'utf8' }))
        .filter((file) => file.endsWith('.test.js'));
}

function findRequirers(needle) {
    const result = spawnSync('git', ['grep', '-l', '-F', '-e', needle], {
        encoding: 'utf8',
    });
    if (result.status === 1) return [];
    assert.strictEqual(result.status, 0, result.stderr);
    return outputLines(result.stdout);
}

function select(changedFiles) {
    return selectFastTests(changedFiles, { listTests, findRequirers });
}

function scratchGit(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeScratchFile(cwd, file, source) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
}

function scratchCommit(cwd, message, files) {
    scratchGit(cwd, ['add', '--', ...files]);
    scratchGit(cwd, [
        '-c', 'user.name=Selector Test',
        '-c', 'user.email=selector-test',
        'commit', '-m', message,
    ]);
}

describe('fast CI selector', function () {
    it('maps the address resolver to its unit test without widening', function () {
        const plan = select(['src/utils/address_resolver.js']);
        assert.strictEqual(plan.consensus, false);
        assert(plan.tests.some((test) => test.file === 'test/unit/utils/address_resolver.test.js'));
    });

    it('maps the explorer client to its unit test', function () {
        const plan = select(['src/clients/explorer.js']);
        assert.strictEqual(plan.consensus, false);
        assert(plan.tests.some((test) => test.file === 'test/unit/clients/explorer.test.js'));
    });

    it('widens protocol and cosigner changes to the full gate', function () {
        for (const file of ['src/protocol/validator.js', 'src/cosigner/client.js']) {
            const plan = select([file]);
            assert.strictEqual(plan.consensus, true);
            assert(plan.reasons.some((reason) => reason.includes(file)));
        }
    });

    it('widens a module required by a consensus path', function () {
        const plan = select(['src/utils/errors.js']);
        assert.strictEqual(plan.consensus, true);
        assert(plan.reasons.some((reason) => reason.includes('src/actions/')));
    });

    it('selects nothing for a documentation-only change', function () {
        assert.deepStrictEqual(select(['README.md']), { consensus: false, reasons: [], tests: [] });
    });

    it('widens package manifest changes', function () {
        const plan = select(['package.json']);
        assert.strictEqual(plan.consensus, true);
        assert(plan.reasons.some((reason) => reason.includes('package.json')));
    });

    it('defers a changed test outside the runner groups', function () {
        const integration = execFileSync('git', ['ls-files', 'test/integration'], { encoding: 'utf8' })
            .split(/\r?\n/).find((file) => file.endsWith('.test.js'));
        assert(integration, 'expected a tracked integration test');
        const plan = select([integration]);
        assert.deepStrictEqual(plan.tests, []);
        assert(plan.reasons.includes(`deferred: ${integration}`));
    });

    it('returns null when neither base candidate resolves', function () {
        const git = (args) => {
            if (args[0] === 'cat-file') throw new Error('unknown object');
            throw new Error('no merge base');
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: 'unknown' }, git }), null);
    });

    it('uses an accepted venue base SHA', function () {
        const calls = [];
        const git = (args) => {
            calls.push(args);
            return '';
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: 'abc123' }, git }), 'abc123');
        assert.deepStrictEqual(calls, [['cat-file', '-e', 'abc123^{commit}']]);
    });

    it('falls back to the develop merge base', function () {
        const git = (args) => {
            if (args[0] === 'cat-file') throw new Error('unknown object');
            return 'def456\n';
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: 'unknown' }, git }), 'def456');
    });

    it('keeps the selector guarded while retaining the full gate', function () {
        const script = fs.readFileSync('bin/ci-full.sh', 'utf8');
        assert(script.includes('ci_fast_select.js --plan'));
        assert(script.includes('[ "${CI_TIER:-full}" = "fast" ]'));
        assert(script.includes('run_tier "ci (test gate, siblings required)"'));
    });

    it('replays develop history, compares narrowing, and checks required selections', function () {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fast-select-replay-'));
        try {
            scratchGit(cwd, ['init', '--initial-branch=develop']);
            const initial = {
                'src/consensus/rule.js': "module.exports = 'rule';\n",
                'src/feature/plain.js': "module.exports = 'plain';\n",
                'test/unit/consensus/rule.test.js':
                    "require('../../../src/consensus/rule');\n",
                'test/unit/feature/plain.test.js': "require('../../../src/feature/plain');\n",
                'test/unit/only.test.js': "module.exports = 'only';\n",
                'test/unit/other/unrelated.test.js': "module.exports = 'unrelated';\n",
            };
            for (const [file, source] of Object.entries(initial)) {
                writeScratchFile(cwd, file, source);
            }
            scratchCommit(cwd, 'initial files', Object.keys(initial));

            const consensusFile = 'src/consensus/rule.js';
            fs.appendFileSync(path.join(cwd, consensusFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'consensus change', [consensusFile]);

            const plainFile = 'src/feature/plain.js';
            fs.appendFileSync(path.join(cwd, plainFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'plain source change', [plainFile]);

            const testFile = 'test/unit/only.test.js';
            fs.appendFileSync(path.join(cwd, testFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'test only change', [testFile]);
            scratchGit(cwd, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);

            const selector = path.resolve(__dirname, '../ci_fast_select.js');
            const mustSelect = [
                'src/consensus/rule.js:test/unit/consensus/rule.test.js',
                'src/feature/plain.js:test/unit/other/unrelated.test.js',
            ].join(',');
            const result = spawnSync(process.execPath, [
                selector,
                '--replay', '3',
                '--narrow', 'src/consensus/',
                '--must-select', mustSelect,
            ], { cwd, encoding: 'utf8' });

            assert.strictEqual(result.status, 1, result.stderr);
            const replayLines = result.stdout.trim().split(/\r?\n/);
            assert(replayLines.includes('plan commits consensus-1 changed-tests test-only no-tests'));
            assert(replayLines.includes('current 3 1/3 1/3 1/3 0/3'));
            assert(replayLines.includes('narrowed 3 0/3 2/3 1/3 0/3'));
            assert(replayLines.includes(
                'must-select PASS src/consensus/rule.js:test/unit/consensus/rule.test.js'));
            assert(replayLines.includes(
                'must-select FAIL src/feature/plain.js:test/unit/other/unrelated.test.js'));
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
