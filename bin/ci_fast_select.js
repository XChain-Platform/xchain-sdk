#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const GROUPS = [
    {
        name: 'unit',
        prefix: 'test/unit/',
        args: ['--timeout', '5000', '--recursive', '--exit'],
    },
    {
        name: 'security',
        prefix: 'test/security/',
        args: ['--timeout', '10000', '--recursive', '--exit'],
    },
    {
        name: 'regression',
        prefix: 'test/regression/',
        args: ['--timeout', '30000', '--recursive', '--exit'],
    },
];

const CONSENSUS = [
    'src/protocol/',
    'src/formats.js',
    'src/formatSelector.js',
    'src/actions/',
    'src/actions.js',
    'src/coins/',
    'src/consensus/',
    'src/contract/',
    'src/checkpoint.js',
    'src/merkle.js',
    'src/merkle/',
    'src/carrier/',
    'src/compression.js',
    'src/batchLimits.js',
    'src/addressRefFields.js',
    'src/chunkHelper.js',
    'src/musig2.js',
    'src/cosigner/',
    'src/wallet.js',
    'src/walletSession.js',
    'src/networks.js',
    'src/validator.js',
    'src/preflight/',
    'src/decoder/',
    'src/observability/',
    'bin/pins/',
    'bin/check-preflight-drift.js',
    'bin/preflight_handler_dirs.js',
    'bin/preflight_indexer_root.js',
];
const WIDEN = ['test/helpers/', 'test/fixtures/'];
const CONTROL_FILES = ['package.json', 'package-lock.json'];
const ALWAYS = [];

function lines(value) {
    return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function runGit(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function resolveBase({ env = process.env, git = runGit } = {}) {
    const candidate = env.PROM_CI_BASE_SHA;
    if (candidate) {
        try {
            git(['cat-file', '-e', `${candidate}^{commit}`]);
            return candidate;
        } catch (_) {
            // Fall through to the repository merge base when the venue SHA is unavailable.
        }
    }
    try {
        const base = String(git(['merge-base', 'HEAD', 'origin/develop'])).trim();
        return base || null;
    } catch (_) {
        return null;
    }
}

function groupFor(file) {
    return GROUPS.find((group) => file.startsWith(group.prefix) && file.endsWith('.test.js'));
}

function normaliseFiles(files) {
    return [...new Set((files || []).map((file) => String(file).replaceAll('\\', '/')))].sort();
}

function isConsensusPath(file, consensusPrefixes = CONSENSUS) {
    return [...consensusPrefixes, ...WIDEN, ...CONTROL_FILES]
        .some((prefix) => file.startsWith(prefix));
}

function importerRecord(hit) {
    if (typeof hit === 'string') return { file: hit.split(':')[0] };
    return hit || {};
}

function resolvedRequires(file, content) {
    const resolved = [];
    const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
        const base = path.resolve(path.dirname(file), match[1]);
        resolved.push(base, `${base}.js`, path.join(base, 'index.js'));
    }
    return resolved.map((filePath) => path.relative(process.cwd(), filePath).replaceAll('\\', '/'));
}

function consensusImporters(changedFiles, findRequirers, consensusPrefixes = CONSENSUS) {
    const changedSrc = new Set(changedFiles.filter((file) => file.startsWith('src/')));
    const importers = [];
    for (const changed of changedSrc) {
        const basename = path.basename(changed, path.extname(changed));
        for (const rawHit of findRequirers(basename) || []) {
            const hit = importerRecord(rawHit);
            if (!hit.file || !consensusPrefixes.some((prefix) => hit.file.startsWith(prefix))) continue;
            let content = hit.content;
            if (content === undefined) {
                try { content = fs.readFileSync(hit.file, 'utf8'); } catch (_) { continue; }
            }
            if (resolvedRequires(hit.file, content).includes(changed)) importers.push(hit.file);
        }
    }
    return normaliseFiles(importers);
}

function mappedTestsForSource(source, tests, findRequirers) {
    const relative = source.slice('src/'.length);
    const extension = path.extname(relative);
    const withoutExtension = extension ? relative.slice(0, -extension.length) : relative;
    const basename = path.basename(withoutExtension);
    const directory = path.dirname(withoutExtension) === '.' ? '' : path.dirname(withoutExtension);
    const selected = new Set();

    for (const test of tests) {
        const group = groupFor(test);
        if (!group) continue;
        const withinTier = test.slice(group.prefix.length);
        if (basename !== 'index' && path.basename(test) === `${basename}.test.js`) selected.add(test);
        if (basename !== 'index' && test.includes(`/${basename}.test/`)) selected.add(test);
        if (path.dirname(withinTier) === (directory || '.')) selected.add(test);
    }
    for (const rawHit of findRequirers(`src/${withoutExtension}`) || []) {
        const hit = importerRecord(rawHit).file;
        if (hit && groupFor(hit) && tests.includes(hit)) selected.add(hit);
    }
    return selected;
}

function selectFastTests(
    changedFiles,
    { listTests = () => [], findRequirers = () => [] } = {},
    { consensusPrefixes = CONSENSUS } = {}
) {
    const changed = normaliseFiles(changedFiles);
    const reasons = [];
    for (const file of changed) {
        if (isConsensusPath(file, consensusPrefixes)) reasons.push(`consensus: ${file}`);
    }
    for (const file of consensusImporters(changed, findRequirers, consensusPrefixes)) {
        reasons.push(`consensus importer: ${file}`);
    }
    const consensus = reasons.length > 0;
    if (consensus) return { consensus, reasons: normaliseFiles(reasons), tests: [] };

    const available = normaliseFiles(listTests()).filter((file) => groupFor(file));
    const selected = new Set(ALWAYS.filter((file) => available.includes(file)));
    for (const file of changed) {
        const group = groupFor(file);
        if (group && available.includes(file)) selected.add(file);
        else if (file.startsWith('test/') && file.endsWith('.js')) reasons.push(`deferred: ${file}`);
        if (!file.startsWith('src/')) continue;
        for (const test of mappedTestsForSource(file, available, findRequirers)) selected.add(test);
    }
    const tests = [...selected].sort().map((file) => ({ group: groupFor(file).name, file }));
    return { consensus, reasons: normaliseFiles(reasons), tests };
}

function listTrackedTests() {
    return lines(runGit(['ls-files', 'test'])).filter((file) => file.endsWith('.test.js'));
}

function gitGrepFiles(needle) {
    const result = spawnSync('git', ['grep', '-l', '-F', '-e', needle], {
        encoding: 'utf8',
    });
    if (result.status === 1) return [];
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(String(result.stderr || `git grep exited ${result.status}`).trim());
    return lines(result.stdout);
}

function withoutConsensusPrefixes(prefixes) {
    const removed = new Set(prefixes.flatMap((prefix) => {
        const trimmed = prefix.trim();
        if (!trimmed) return [];
        return [trimmed, trimmed.endsWith('/') ? trimmed.slice(0, -1) : `${trimmed}/`];
    }));
    return CONSENSUS.filter((prefix) => !removed.has(prefix));
}

function changedFilesForCommit(commit) {
    const revision = lines(runGit(['rev-list', '--parents', '-n', '1', commit]))[0];
    const [, parent] = revision.split(' ');
    if (parent) return lines(runGit(['diff', '--name-only', `${parent}..${commit}`]));
    return lines(runGit(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]));
}

function emptyReplayCounts() {
    return { wholeUnit: 0, changedTests: 0, testOnly: 0, noTests: 0 };
}

function countReplayPlan(counts, changed, plan) {
    if (plan.consensus) {
        counts.wholeUnit++;
    } else if (plan.tests.length && changed.every((file) => file.startsWith('test/'))) {
        counts.testOnly++;
    } else if (plan.tests.length) {
        counts.changedTests++;
    } else {
        counts.noTests++;
    }
}

function replayPlans(limit, narrowPrefixes) {
    const commits = lines(runGit([
        'log', '--first-parent', '-n', String(limit), '--format=%H', 'origin/develop',
    ]));
    const current = emptyReplayCounts();
    const narrowed = emptyReplayCounts();
    const consensusPrefixes = withoutConsensusPrefixes(narrowPrefixes);
    const dependencies = { listTests: listTrackedTests, findRequirers: gitGrepFiles };
    for (const commit of commits) {
        const changed = changedFilesForCommit(commit);
        countReplayPlan(current, changed, selectFastTests(changed, dependencies));
        countReplayPlan(narrowed, changed, selectFastTests(changed, dependencies, {
            consensusPrefixes,
        }));
    }
    return { commits, current, narrowed, consensusPrefixes, dependencies };
}

function fraction(value, total) {
    return `${value}/${total}`;
}

function printReplayRow(name, total, counts) {
    console.log([
        name,
        total,
        fraction(counts.wholeUnit, total),
        fraction(counts.changedTests, total),
        fraction(counts.testOnly, total),
        fraction(counts.noTests, total),
    ].join(' '));
}

function parseList(value) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseMustSelect(value) {
    return parseList(value).map((pair) => {
        const separator = pair.indexOf(':');
        if (separator <= 0 || separator === pair.length - 1) {
            throw new Error(`invalid --must-select pair: ${pair}`);
        }
        return { source: pair.slice(0, separator), test: pair.slice(separator + 1) };
    });
}

function replayOptions(args) {
    const limit = Number(args[0]);
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('--replay requires a positive integer');
    }
    const options = { limit, narrowPrefixes: [], mustSelect: [] };
    for (let index = 1; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value || (flag !== '--narrow' && flag !== '--must-select')) {
            throw new Error(`invalid replay option: ${flag || ''}`.trim());
        }
        if (flag === '--narrow') options.narrowPrefixes.push(...parseList(value));
        else options.mustSelect.push(...parseMustSelect(value));
    }
    return options;
}

function runReplay(args) {
    try {
        const options = replayOptions(args);
        const result = replayPlans(options.limit, options.narrowPrefixes);
        console.log('plan commits consensus-1 changed-tests test-only no-tests');
        printReplayRow('current', result.commits.length, result.current);
        if (options.narrowPrefixes.length) {
            printReplayRow('narrowed', result.commits.length, result.narrowed);
        }
        let failed = false;
        for (const pair of options.mustSelect) {
            const plan = selectFastTests([pair.source], result.dependencies, {
                consensusPrefixes: result.consensusPrefixes,
            });
            const selected = plan.tests.some((test) => test.file === pair.test);
            console.log(`must-select ${selected ? 'PASS' : 'FAIL'} ${pair.source}:${pair.test}`);
            if (!selected) failed = true;
        }
        return failed ? 1 : 0;
    } catch (error) {
        console.error(`replay-error ${error.message}`);
        return 2;
    }
}

function planFromRepository() {
    const base = resolveBase();
    if (!base) return { noBase: 'no usable PROM_CI_BASE_SHA or origin/develop merge base' };
    const changed = lines(runGit(['diff', '--name-only', `${base}...HEAD`]));
    return selectFastTests(changed, { listTests: listTrackedTests, findRequirers: gitGrepFiles });
}

function printPlan(plan) {
    console.log(`consensus ${plan.consensus ? 1 : 0}`);
    for (const reason of plan.reasons) console.log(`reason ${reason}`);
    for (const test of plan.tests) console.log(`test ${test.group} ${test.file}`);
}

function runPlan(plan) {
    let failed = false;
    let ran = false;
    for (const group of GROUPS) {
        const files = plan.tests.filter((test) => test.group === group.name).map((test) => test.file);
        if (files.length === 0) continue;
        ran = true;
        const result = spawnSync('./node_modules/.bin/mocha', ['--no-config', ...group.args, ...files], {
            stdio: 'inherit',
        });
        if (result.error || result.status !== 0) failed = true;
    }
    if (!ran) console.log('ci:fast: no test maps to this push');
    return failed ? 1 : 0;
}

function main() {
    const mode = process.argv[2];
    if (mode === '--replay') return runReplay(process.argv.slice(3));
    if (mode !== '--plan' && mode !== '--run') {
        console.error('usage: node bin/ci_fast_select.js --plan|--run|--replay N ' +
            '[--narrow prefix,...] [--must-select file:testfile,...]');
        return 2;
    }
    let plan;
    try {
        plan = planFromRepository();
    } catch (error) {
        console.error(`selector-error ${error.message}`);
        return 2;
    }
    if (plan.noBase) {
        console.log(`no-base ${plan.noBase}`);
        return 3;
    }
    if (mode === '--plan') {
        printPlan(plan);
        return 0;
    }
    return runPlan(plan);
}

module.exports = { replayPlans, resolveBase, selectFastTests };

if (require.main === module) process.exitCode = main();
