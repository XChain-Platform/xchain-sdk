/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const {
    splitCommand,
    mochaArgsFor,
    compare,
} = require('../../../bin/suite-title-map.js');

function titleMap(file, key, titles) {
    return {
        titleSets: { [key]: titles },
        scripts: { test: { files: { [file]: key } } },
    };
}

describe('suite title map command splitting', function () {
    it('keeps quoted grep patterns and globs as single tokens', function () {
        assert.deepStrictEqual(
            splitCommand('mocha --grep "@x.*(a|b)" \'test/**/*.js\''),
            [
                { value: 'mocha', quoted: false },
                { value: '--grep', quoted: false },
                { value: '@x.*(a|b)', quoted: true },
                { value: 'test/**/*.js', quoted: true },
            ]
        );
    });
});

describe('suite title map mocha argument parsing', function () {
    it('separates leading environment assignments from mocha arguments', function () {
        assert.deepStrictEqual(
            mochaArgsFor("FUZZ_RUNS=1000 mocha --timeout 0 'test/fuzz/**/*.js'"),
            {
                args: ['--timeout', '0', 'test/fuzz/**/*.js'],
                env: { FUZZ_RUNS: '1000' },
            }
        );
    });

    it('extracts npm scripts from a composite command', function () {
        assert.deepStrictEqual(
            mochaArgsFor('npm run a && npm run b'),
            { composite: ['a', 'b'] }
        );
    });

    it('identifies a non-mocha command in the skip reason', function () {
        assert.deepStrictEqual(
            mochaArgsFor('node bin/something.js'),
            { skip: 'not a mocha command (runs node)' }
        );
    });
});

describe('suite title map flat path renames', function () {
    it('accepts an identical title set moved through the rename map', function () {
        const pin = titleMap('old.js', 'shared', ['suite title']);
        const fresh = titleMap('new.js', 'shared', ['suite title']);

        assert.deepStrictEqual(compare(pin, fresh, {
            'old.js': 'new.js',
        }), []);
    });
});

describe('suite title map structured renames', function () {
    const renames = {
        paths: { 'old.js': 'new.js' },
        titles: { 'new.js': { 'old title': 'new title' } },
    };

    it('accepts a declared path and title rename', function () {
        const pin = titleMap('old.js', 'old', ['old title']);
        const fresh = titleMap('new.js', 'fresh', ['new title']);

        assert.deepStrictEqual(compare(pin, fresh, renames), []);
    });

    it('reports an actual title that differs from the declared rename', function () {
        const pin = titleMap('old.js', 'old', ['old title']);
        const fresh = titleMap('new.js', 'fresh', ['unexpected title']);

        assert.deepStrictEqual(compare(pin, fresh, renames), [
            {
                script: 'test',
                kind: 'title_dropped',
                file: 'new.js',
                title: 'new title',
            },
            {
                script: 'test',
                kind: 'title_added',
                file: 'new.js',
                title: 'unexpected title',
            },
        ]);
    });
});
