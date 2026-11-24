// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const AuthUtils = require('@dankest-llc/xchain-sdk/auth');
const DirectAuthUtils = require('../../../src/utils/auth.js');

describe('auth package entry', function () {
    it('exports the existing AuthUtils class with wallet callback methods installed', function () {
        assert.strictEqual(AuthUtils, DirectAuthUtils);
        for (const method of [
            'verifyLogin',
            'holdsAtLeast',
            'receiveCallback',
            'generateChallenge',
            'signMessage',
            'verifyMessage',
        ]) {
            assert.strictEqual(typeof AuthUtils.prototype[method], 'function', method);
        }
    });

    it('resolves the public subpath without loading the full SDK entry', function () {
        const script = [
            "const path = require('path');",
            "const AuthUtils = require('@dankest-llc/xchain-sdk/auth');",
            "const root = process.cwd();",
            "const loaded = Object.keys(require.cache);",
            "process.stdout.write(JSON.stringify({",
            "  isFunction: typeof AuthUtils === 'function',",
            "  loadedIndex: loaded.includes(path.join(root, 'index.js')),",
            "  loadedSDK: loaded.some((file) => file.endsWith(path.join('src', 'XChainSDK.js')))",
            "}));",
        ].join('\n');
        const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
            cwd: ROOT,
            encoding: 'utf8',
        }));

        assert.deepStrictEqual(result, {
            isFunction: true,
            loadedIndex: false,
            loadedSDK: false,
        });
    });
});

describe('auth package metadata', function () {
    it('exports the root, auth, package metadata, and compatible deep imports', function () {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

        assert.strictEqual(pkg.main, 'index.js');
        assert.strictEqual(pkg.types, 'index.d.ts');
        assert.deepStrictEqual(pkg.exports['.'], {
            types: './index.d.ts',
            require: './index.js',
            default: './index.js',
        });
        assert.deepStrictEqual(pkg.exports['./auth'], {
            types: './index.d.ts',
            require: './src/utils/auth_entry.d.ts',
            default: './src/utils/auth_entry.d.ts',
        });
        assert.strictEqual(pkg.exports['./package.json'], './package.json');
        assert.strictEqual(pkg.exports['./*'], './*');
    });
});
