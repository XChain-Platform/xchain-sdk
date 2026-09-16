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
// This exists because the pre-flight dispenser resolvers looked dispensers
// up with `getDispensers(idx, 'action_index')` and their lifecycle
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
    __dirname, '../..', '..', '..', 'xchain-explorer', 'src', 'explorer', 'routes', 'api_methods.js');
const SRC = path.join(__dirname, '../..', '..', 'src');
const MCP_SERVER = path.join(__dirname, '../..', '..', 'mcp', 'server.js');

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

// The MCP tool surface is a SECOND way to name a query type, and the scanner above
// cannot see it: the tools pass `type` through as a variable, so every call site
// under mcp/ is a computed type. The value an agent may supply is fixed by the zod
// enum in the tool's own schema, so that is what gets compared against the route.
// `search_tokens` advertised `nft`, which is on neither /tokens route, so the tool
// documented a filter that 404'd on every call - and a 404 reads as "nothing found",
// which is the same shape of confident-wrong answer the CALL scanner exists for.
//
// Each tool block is split off at its own `tool(` so the `sdkFor(coin).<method>(`
// picked up is the one that belongs to the enum. Tools whose type is not a z.enum,
// or which call no sdk method by name, are simply not checked.
// SDK method -> route-table method, for the handful whose names differ. `search`
// is the only one today, and it is exactly the tool whose type was optional, so a
// guard without this map would have checked every tool but that one.
const SDK_TO_ROUTE_METHOD = { search: 'getSearch' };

function parseMcpTypeEnums(source) {
    const out = [];
    for (const chunk of source.split(/\n\s*tool\(/).slice(1)) {
        const name   = /^'([\w]+)'/.exec(chunk);
        const values = /\btype:\s*z\.enum\(\[([^\]]*)\]\)(\.[\w().'"\s]*)?/.exec(chunk);
        const call   = /sdkFor\(coin\)\.(\w+)\(/.exec(chunk);
        if (!name || !values || !call) continue;
        const suffix = values[2] || '';
        const query  = /\bquery:\s*z\.string\(\)(\.[\w().'"\s]*)?/.exec(chunk);
        out.push({
            queryRequired: !!query && !/\.optional\(/.test(query[1] || ''),
            tool: name[1],
            method: SDK_TO_ROUTE_METHOD[call[1]] || call[1],
            values: values[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean),
            optional: /\.optional\(/.test(suffix),
            hasDefault: /\.default\(/.test(suffix),
        });
    }
    return out;
}

function loadRouteTable(ctx) {
    if (!fs.existsSync(EXPLORER_ROUTES)) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
            throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling xchain-explorer checkout not found at ' + EXPLORER_ROUTES);
        }
        return ctx.skip();
    }
    const table = parseRouteTable(fs.readFileSync(EXPLORER_ROUTES, 'utf8'));
    assert.ok(Object.keys(table).length > 20,
        'route table parsed as ' + Object.keys(table).length + ' entries; the parser has drifted from api_methods.js');
    return table;
}

describe('explorer route contract @regression', function () {
    let table;

    before(function () {
        table = loadRouteTable(this);
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
                        path.relative(path.join(__dirname, '../..', '..'), file) +
                        ': ' + method + "(_, '" + type + "') - route accepts " + allowed.join(', '));
                }
            }
        }

        assert.ok(checked > 0, 'no typed explorer calls found; the scanner regex has drifted');
        assert.deepStrictEqual(violations, [],
            'explorer calls using a query type the route does not accept (these 404 at runtime, ' +
            'and a 404 is read as "this resource does not exist"):\n  ' + violations.join('\n  '));
    });
});

describe('explorer route contract @regression', function () {
    let table;

    before(function () {
        table = loadRouteTable(this);
    });

    // ExplorerClient reaches every one of these through /{coin}/api/, so the api-only
    // route table above is the right comparison. `search` is the single method that
    // uses the /explorer/ mirror, and that mirror carries an identical TYPE list.
    it('every MCP tool type enum is a subset of its explorer route types', function () {
        const tools = parseMcpTypeEnums(fs.readFileSync(MCP_SERVER, 'utf8'));
        assert.ok(tools.length >= 4,
            'parsed ' + tools.length + ' typed MCP tools; the mcp/server.js scanner has drifted');

        const violations = [];
        let checked = 0;
        for (const t of tools) {
            const allowed = table[t.method];
            if (!allowed) continue;        // not a {QUERY}/{TYPE} route
            checked++;
            for (const value of t.values) {
                if (!allowed.includes(value))
                    violations.push(t.tool + " advertises type '" + value + "', but " +
                        t.method + ' accepts ' + allowed.join(', '));
            }
            // An omitted type interpolates the string 'undefined' into the path, which
            // matches no route; a .default() is fine because the value is always sent.
            // Only checked where QUERY is itself required: a tool with an optional query
            // (get_attestations) has a second, typeless route it legitimately falls back
            // to, and which of the two it takes is a runtime branch this parser cannot
            // read. Those tools still carry the same hazard when a query is supplied
            // without a type, and that is a separate contract decision, not this guard's.
            if (t.queryRequired && t.optional && !t.hasDefault)
                violations.push(t.tool + ' leaves type optional, so an omitted type reaches ' +
                    t.method + ' as undefined and is interpolated into the URL');
        }

        assert.ok(checked > 0, 'no typed MCP tools matched a route method; the mapping has drifted');
        assert.deepStrictEqual(violations, [],
            'MCP tool schemas advertising a query type the explorer route cannot serve:\n  ' +
            violations.join('\n  '));
    });
});

describe('explorer route contract @regression', function () {
    let table;

    before(function () {
        table = loadRouteTable(this);
    });

    // Guards that guard: a parser that matched nothing, or a route table that happened
    // to contain every value, would pass above while checking nothing at all.
    it('the MCP enum scanner recognises an unserveable type and a missing one', function () {
        const sample = "\n    tool('search_tokens', 'x',\n" +
            "        { coin: coinParam, query: z.string(), type: z.enum(['token', 'nft']).optional() },\n" +
            "        ({ coin, query, type }) => sdkFor(coin).getTokens(query, type));\n";
        const parsed = parseMcpTypeEnums(sample);
        assert.strictEqual(parsed.length, 1, 'parser failed to match a known tool shape');
        assert.strictEqual(parsed[0].method, 'getTokens');
        assert.deepStrictEqual(parsed[0].values, ['token', 'nft']);
        assert.strictEqual(parsed[0].optional, true);
        assert.strictEqual(parsed[0].hasDefault, false);
        assert.strictEqual(parsed[0].queryRequired, true);
        assert.ok(!table.getTokens.includes('nft'),
            "'nft' is not a /tokens route type, so this must read as a violation");
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
