/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Drift guard: docs/openrpc.json must list exactly the methods exposed by
 * the controller in src/api.js. Regenerate with: node docs/openrpc.build.js
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

describe('openrpc.json method coverage', () => {

    const src  = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/openrpc.json'), 'utf8'));

    const block = src.slice(src.indexOf('const controller = {'), src.indexOf('jsonRouter('));
    const controllerMethods = [...block.matchAll(/^\s{8}async\s+([a-z][a-z0-9_]*)\s*\(/gm)].map((m) => m[1]);

    it('extracts a sane controller method list', () => {
        assert.ok(controllerMethods.includes('ping') && controllerMethods.includes('create_action'),
            `extraction broken: ${controllerMethods.join(', ')}`);
    });

    it('spec methods === controller methods', () => {
        assert.deepStrictEqual(spec.methods.map((m) => m.name).sort(), [...controllerMethods].sort());
    });

    it('every method except ping declares Bearer auth', () => {
        for (const m of spec.methods) {
            if (m.name === 'ping') assert.ok(!m['x-auth'], 'ping must be open');
            else assert.ok(m['x-auth'], `${m.name} must declare x-auth`);
            assert.ok(m.summary && m.summary.length, `${m.name} summary`);
        }
    });
});
