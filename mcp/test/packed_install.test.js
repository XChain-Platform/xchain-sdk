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
 *
 * Publish-shape check: pack both the SDK and the MCP package the way
 * `npm publish` would, install the tarballs into a scratch project with no
 * repo-relative escape hatch, and require the MCP package the way an
 * installer would - 'xchain-mcp/server.js' - not the in-repo relative path
 * mcp/server.js also supports for its own dev loop.
 *
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const mcpRoot = path.join(repoRoot, 'mcp');

function npm(args, options = {}) {
    const npmCli = process.env.npm_execpath;
    const command = npmCli ? process.execPath : 'npm';
    const commandArgs = npmCli ? [npmCli, ...args] : args;
    return execFileSync(command, commandArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
    });
}

function pack(packageRoot, destination) {
    const result = JSON.parse(npm([
        'pack',
        '--json',
        '--pack-destination', destination,
    ], {
        cwd: packageRoot,
        env: { ...process.env, npm_config_cache: path.join(destination, '.npm-cache') },
    }));
    assert.equal(result.length, 1);
    return path.join(destination, result[0].filename);
}

test('packed SDK and MCP packages load xchain-mcp/server.js after install', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-mcp-pack-'));
    try {
        const sdkTarball = pack(repoRoot, installRoot);
        const mcpTarball = pack(mcpRoot, installRoot);
        npm([
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            sdkTarball,
            mcpTarball,
        ], {
            cwd: installRoot,
            env: { ...process.env, npm_config_cache: path.join(installRoot, '.npm-cache') },
        });

        const loaded = execFileSync(process.execPath, ['-e', [
            "const server = require('xchain-mcp/server.js');",
            "const sdk = require('@dankest-llc/xchain-sdk/package.json');",
            "if (typeof server.buildServer !== 'function') process.exit(2);",
            'process.stdout.write(sdk.version);',
        ].join('')], {
            cwd: installRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        assert.equal(loaded, require('../../package.json').version);
    } finally {
        fs.rmSync(installRoot, { recursive: true, force: true });
    }
});
