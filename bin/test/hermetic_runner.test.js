/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('node:assert');
const { FAMILIES, runHermeticTests } = require('../../scripts/run-hermetic-tests.js');

describe('hermetic test runner', function () {
    it('runs every hermetic family in order', function () {
        const calls = [];
        const lines = [];
        const spawn = (command, args, options) => {
            calls.push({ command, args, options });
            return { status: 0 };
        };

        assert.strictEqual(runHermeticTests({ spawn, write: (line) => lines.push(line) }), 0);
        assert.strictEqual(FAMILIES.length, 7);
        assert.deepStrictEqual(FAMILIES.map((family) => family.name), [
            'test:smoke',
            'test:integration',
            'test:boundary',
            'test:fuzz',
            'test:chaos',
            'bin/test',
            'scripts',
        ]);
        assert.deepStrictEqual(calls.map((call) => call.args), FAMILIES.map((family) => family.args));
        assert(calls.every((call) => call.options.stdio === 'inherit'));
        assert.deepStrictEqual(lines, FAMILIES.map((family) => `PASS ${family.name}`));
    });

    it('finishes every family and exits nonzero when one is red', function () {
        const lines = [];
        let call = 0;
        const spawn = () => ({ status: call++ === 2 ? 1 : 0 });

        assert.strictEqual(runHermeticTests({ spawn, write: (line) => lines.push(line) }), 1);
        assert.strictEqual(call, FAMILIES.length);
        assert.strictEqual(lines[2], 'FAIL test:boundary');
        assert.strictEqual(lines.filter((line) => line.startsWith('FAIL ')).length, 1);
    });

    it('marks a family red when its process cannot start', function () {
        const lines = [];
        const spawn = () => ({ status: null, error: new Error('not found') });

        assert.strictEqual(runHermeticTests({ spawn, write: (line) => lines.push(line) }), 1);
        assert.strictEqual(lines.length, FAMILIES.length);
        assert(lines.every((line) => line.startsWith('FAIL ')));
    });
});
