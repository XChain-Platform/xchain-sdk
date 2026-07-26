// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Route contract: every `explorer.<method>(query, '<type>')` call in this repo
// must use a query TYPE the explorer route actually accepts.
//
// This exists because of . The pre-flight dispenser resolvers looked
// dispensers up with `getDispensers(idx, 'action_index')` and their lifecycle
// with `getDispenserCloses(idx, 'dispenser_action_index')`. Neither type is on
// either route: /dispensers/ takes block, address, source, destination, token,
// oracle, and the lifecycle routes take block, address. Every one of those
// calls 404'd, `ctx.fetch` correctly reads a 404 as authoritative "absent", and
// so every DISPENSE pre-flight reported a live, funded dispenser as
// nonexistent - a blanket false block on an action that moves native coin.
// The same defect sat in the AIRDROP list check and, in the wallet, in
// actionByTxid.
//
// It survived a full unit suite because the mocks were written to the same
// imagination as the calls: a stub named getDispensers returns whatever the
// author expected, no matter what type string it was handed. No amount of
// mock-based testing can catch a route that does not exist. Comparing against
// the explorer's own route table can, statically, in milliseconds.
//
// Skipped when the sibling xchain-explorer checkout is absent (standalone
// clone); XCHAIN_REQUIRE_SIBLINGS=1 turns that skip into a failure, and the
// drift-guards CI job (which already checks the explorer out for the abi-core
// guard) runs it that way.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const EXPLORER_ROUTES = path.join(
    __dirname, '..', '..', '..', 'xchain-explorer', 'src', 'XChainExplorer.js');
const SRC = path.join(__dirname, '..', '..', 'src');

/**
 * method name -> array of accepted {TYPE} values, parsed from the explorer's
 * own route table. Two shapes appear there:
 *   '/{COIN}/api/dispensers/{QUERY}/{TYPE}' : ['getDispensers', ['block', ...]]
 *   '/{COIN}/api/action/{QUERY}'            : ['getAction', 'action_index']
 */
function parseRouteTable(source) {
    const table = {};
    const multi = /'\/\{COIN\}\/api\/[^']*\/\{QUERY\}\/\{TYPE\}'\s*:\s*\[\s*'(\w+)'\s*,\s*\[([^\]]*)\]/g;
    let m;
    while ((m = multi.exec(source)) !== null) {
        table[m[1]] = m[2].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    }
    const single = /'\/\{COIN\}\/api\/[^']*\/\{QUERY\}'\s*:\s*\[\s*'(\w+)'\s*,\s*'(\w+)'/g;
    while ((m = single.exec(source)) !== null) {
        if (!table[m[1]]) table[m[1]] = [m[2]];
    }
    return table;
}

function jsFilesUnder(dir) {
    const out = [];
    (function walk(d) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.name.endsWith('.js')) out.push(p);
        }
    })(dir);
    return out;
}

// `explorer.getFoo(anything, 'type')` - only calls passing a LITERAL type are
// checkable, which is every one of them today. A computed type would be
// invisible here, so keep them literal.
const CALL = /explorer\.(get\w+)\(\s*[^,()]*,\s*'([a-z_]+)'/g;

describe('explorer route contract @regression', function () {
    let table;

    before(function () {
        if (!fs.existsSync(EXPLORER_ROUTES)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling xchain-explorer checkout not found at ' + EXPLORER_ROUTES);
            }
            return this.skip();
        }
        table = parseRouteTable(fs.readFileSync(EXPLORER_ROUTES, 'utf8'));
        assert.ok(Object.keys(table).length > 20,
            'route table parsed as ' + Object.keys(table).length + ' entries; the parser has drifted from XChainExplorer.js');
    });

    it('every typed explorer call uses a type its route accepts', function () {
        const violations = [];
        let checked = 0;

        for (const file of jsFilesUnder(SRC)) {
            const text = fs.readFileSync(file, 'utf8');
            let call;
            CALL.lastIndex = 0;
            while ((call = CALL.exec(text)) !== null) {
                const [, method, type] = call;
                const allowed = table[method];
                if (!allowed) continue;   // not a {QUERY}/{TYPE} route
                checked++;
                if (!allowed.includes(type)) {
                    violations.push(
                        path.relative(path.join(__dirname, '..', '..'), file) +
                        ': ' + method + "(_, '" + type + "') - route accepts " + allowed.join(', '));
                }
            }
        }

        assert.ok(checked > 0, 'no typed explorer calls found; the scanner regex has drifted');
        assert.deepStrictEqual(violations, [],
            'explorer calls using a query type the route does not accept (these 404 at runtime, ' +
            'and a 404 is read as "this resource does not exist"):\n  ' + violations.join('\n  '));
    });

    // Guards the guard: a scanner that silently matches nothing would pass
    // this suite forever while checking no code at all.
    it('the scanner recognises a violation when one is present', function () {
        const sample = "await ctx.sdk.explorer.getDispensers(idx, 'action_index');";
        CALL.lastIndex = 0;
        const m = CALL.exec(sample);
        assert.ok(m, 'scanner failed to match a known call shape');
        assert.strictEqual(m[1], 'getDispensers');
        assert.strictEqual(m[2], 'action_index');
        assert.ok(!table.getDispensers.includes('action_index'),
            'action_index is not a /dispensers/ type, so this must read as a violation');
    });
});
