/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * xchain-mcp publishes only the files its package.json allowlists. A file the
 * server requires by a './' path but the allowlist omits exists in the repo, so
 * every in-repo test loads it, while the installed package fails at module load.
 * mcp/test/packed_install.test.js proves the packed shape but needs the registry,
 * so it sits outside the default suite; this check runs offline in it.
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const MCP_ROOT = path.resolve(__dirname, '../../../mcp');
const AUTO_SHIPPED = new Set(['package.json', 'README.md', 'LICENSE.md']);
const LOCAL_REQUIRE = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;

// Local requires in the shipped entry files that the allowlist does not ship.
function unshippedLocalRequires(pkg, readSource) {
    const shipped = new Set([...(pkg.files || []), ...AUTO_SHIPPED].map((f) => path.posix.normalize(f)));
    const entries = new Set([
        ...(pkg.files || []).filter((f) => f.endsWith('.js')),
        pkg.main,
        ...Object.values(pkg.bin || {}),
    ].filter(Boolean).map((f) => path.posix.normalize(f)));
    const missing = [];
    for (const entry of entries) {
        if (!shipped.has(entry)) missing.push(`${entry} (entry point)`);
        const source = readSource(entry);
        if (source === null) continue;
        for (const match of source.matchAll(LOCAL_REQUIRE)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1]));
            if (!shipped.has(target)) missing.push(`${target} (required by ${entry})`);
        }
    }
    return missing;
}

function readMcpSource(rel) {
    const file = path.join(MCP_ROOT, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

describe('xchain-mcp publish allowlist', () => {
    it('ships every file the server and CLI require by a local path', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(MCP_ROOT, 'package.json'), 'utf8'));
        expect(unshippedLocalRequires(pkg, readMcpSource)).to.deep.equal([]);
    });

    it('reports a local require the allowlist omits', () => {
        const sources = {
            'server.js': "const d = require('./server_dependencies.js');",
            'cli.js': "require('./server.js');",
        };
        const pkg = { main: 'server.js', bin: { x: 'cli.js' }, files: ['cli.js', 'server.js'] };
        expect(unshippedLocalRequires(pkg, (rel) => sources[rel] ?? null))
            .to.deep.equal(['server_dependencies.js (required by server.js)']);
    });
});
