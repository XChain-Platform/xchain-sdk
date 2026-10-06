/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const { spawnSync } = require('node:child_process');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mocha = require.resolve('mocha/bin/mocha.js');
const FAMILIES = Object.freeze([
    { name: 'test:smoke', command: npm, args: ['run', 'test:smoke'] },
    { name: 'test:integration', command: npm, args: ['run', 'test:integration'] },
    { name: 'test:boundary', command: npm, args: ['run', 'test:boundary'] },
    { name: 'test:fuzz', command: npm, args: ['run', 'test:fuzz'] },
    { name: 'test:chaos', command: npm, args: ['run', 'test:chaos'] },
    {
        name: 'bin/test',
        command: process.execPath,
        args: [mocha, '--no-config', '--timeout', '30000', '--exit', 'bin/test/*.test.js'],
    },
    {
        name: 'scripts',
        command: process.execPath,
        args: [mocha, '--no-config', '--timeout', '30000', '--exit', 'scripts/*.test.js'],
    },
]);

function runFamily(family, spawn, write) {
    const result = spawn(family.command, family.args, { stdio: 'inherit' });
    const passed = result.status === 0 && !result.error;
    write(`${passed ? 'PASS' : 'FAIL'} ${family.name}`);
    return passed;
}

function runHermeticTests(options = {}) {
    const spawn = options.spawn || spawnSync;
    const write = options.write || console.log;
    let failed = false;
    for (const family of FAMILIES) {
        if (!runFamily(family, spawn, write)) failed = true;
    }
    return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = runHermeticTests();

module.exports = { FAMILIES, runHermeticTests };
