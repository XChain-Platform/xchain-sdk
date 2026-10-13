// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pins the XChainSDK fee and capability-threshold declarations in index.d.ts
// to the runtime methods and to the services that produce their answers.
//
// Two layers, the same split as explorer_response_types.test.js:
//   1. checks that run everywhere: each declared method exists at runtime and
//      returns its named type, and the pinned interface fields are declared; and
//   2. a read of the sibling hub and indexer sources, which proves the pinned
//      fields are still produced. It skips when a sibling is absent, and
//      XCHAIN_REQUIRE_SIBLINGS=1 turns that skip into a failure.
//
// The package has no TypeScript toolchain, so index.d.ts is read as text.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const XChainSDK = require('../../../src/XChainSDK.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const DTS       = path.join(REPO_ROOT, 'index.d.ts');
const SIBLINGS  = path.dirname(REPO_ROOT);

// XChainSDK method -> the type its declaration must resolve to.
const SDK_METHODS = {
    quoteNativeFee:          'NativeFeeQuote',
    getFeeQuote:             'FeeQuote',
    getCapabilityThresholds: 'CapabilityThreshold[] | null',
    getFeeSchedule:          'FeeSchedule',
    nativeFeeOutputs:        'CustomOutput[]',
};

// CapabilityThreshold: field -> declared type, matching the hub's row exactly.
const THRESHOLD_FIELDS = {
    capability: 'string',
    min_stake:  'string | null',
    disabled:   'boolean',
};

// FeeQuote fields the SDK's own fee path reads; `supported` is the one it requires.
const FEE_QUOTE_READS = ['supported', 'valid', 'error', 'requiredFeeSats', 'feeDestination', 'busy', 'retryable'];

// Producer file -> fields its returned objects must still carry.
const PRODUCERS = [
    { file: ['xchain-hub', 'src', 'api', 'rpc', 'system.js'], fields: Object.keys(THRESHOLD_FIELDS) },
    { file: ['xchain-indexer', 'src', 'actions', 'actions_class', 'quote_answers.js'], fields: ['supported', 'feeDestination', 'busy', 'retryable'] },
    { file: ['xchain-indexer', 'src', 'actions', 'actions_class', 'fee_pricing.js'], fields: ['valid', 'error', 'requiredFeeSats', 'requiredFeeNative'] },
    { file: ['xchain-indexer', 'src', 'actions', 'actions_class', 'quote_surfaces.js'], fields: ['staticQuote', 'validated'] },
];

// The body of `export interface <name> ...{ ... }`, up to its closing brace at column 0.
function interfaceBody(dts, name) {
    const start = dts.search(new RegExp('export interface ' + name + '\\b[^{]*\\{'));
    assert.ok(start >= 0, 'index.d.ts declares no `export interface ' + name + '`');
    const end = dts.indexOf('\n}', start);
    assert.ok(end > start, 'unterminated interface ' + name);
    return dts.slice(start, end);
}

// Top-level properties of an interface body: four-space indent, one per line.
function topLevelProps(body) {
    const out = {};
    const re  = /^ {4}(\w+)(\??):\s*(.+?);?$/gm;
    let m;
    while ((m = re.exec(body)) !== null) out[m[1]] = { optional: m[2] === '?', type: m[3] };
    return out;
}

// The body of the XChainSDK class declaration.
function sdkClassBody(dts) {
    const start = dts.indexOf('export declare class XChainSDK {');
    assert.ok(start >= 0, 'index.d.ts declares no XChainSDK class');
    return dts.slice(start, dts.indexOf('\n}', start));
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('XChainSDK fee and threshold types in index.d.ts', function () {
    const dts = fs.readFileSync(DTS, 'utf8');
    const cls = sdkClassBody(dts);

    describe('declared methods', function () {
        for (const [name, type] of Object.entries(SDK_METHODS)) {
            it(name + ' is declared on XChainSDK and resolves to ' + type, function () {
                const re = new RegExp('^ {4}' + name + '\\(.*\\): Promise<' + escapeRe(type) + '>;$', 'm');
                assert.match(cls, re);
            });

            it(name + ' exists on the runtime XChainSDK prototype', function () {
                assert.strictEqual(typeof XChainSDK.prototype[name], 'function', name + ' is declared but not implemented');
            });
        }
    });

    describe('CapabilityThreshold', function () {
        it('declares exactly the hub row fields, each required, with the pinned type', function () {
            const props = topLevelProps(interfaceBody(dts, 'CapabilityThreshold'));
            assert.deepStrictEqual(Object.keys(props).sort(), Object.keys(THRESHOLD_FIELDS).sort());
            for (const [name, type] of Object.entries(THRESHOLD_FIELDS)) {
                assert.strictEqual(props[name].optional, false, name + ' must be required');
                assert.strictEqual(props[name].type, type, name + ' type drifted');
            }
        });
    });

    describe('FeeQuote', function () {
        it('declares every field the SDK fee path reads, with supported required', function () {
            const props = topLevelProps(interfaceBody(dts, 'FeeQuote'));
            for (const name of FEE_QUOTE_READS) assert.ok(props[name], name + ' is read by the SDK but undeclared');
            assert.strictEqual(props.supported.optional, false);
            assert.strictEqual(props.supported.type, 'boolean');
        });

        it('NativeFeeQuote extends FeeQuote with the priced action string', function () {
            assert.match(dts, /export interface NativeFeeQuote extends FeeQuote \{/);
            assert.strictEqual(topLevelProps(interfaceBody(dts, 'NativeFeeQuote')).actionString.type, 'string');
        });
    });

    describe('fee schedule declarations', function () {
        it('declares OracleFeeQuote, FeeSchedule and ExplorerClient', function () {
            for (const n of ['OracleFeeQuote', 'FeeSchedule', 'ExplorerClient'])
                assert.match(dts, new RegExp('export interface ' + n + '\\b'));
        });

        it('ExplorerClient declares the fee reads the runtime client implements', function () {
            const ExplorerClient = require('../../../src/clients/explorer.js');
            const props = topLevelProps(interfaceBody(dts, 'ExplorerClient'));
            for (const name of ['getFeeQuote', 'getFeeSchedule']) {
                assert.match(interfaceBody(dts, 'ExplorerClient'), new RegExp('^ {4}' + name + '\\(', 'm'));
                assert.strictEqual(typeof ExplorerClient.prototype[name], 'function', name + ' is declared but not implemented');
            }
            assert.ok(props);
        });

        it('PreflightVerdict stays pass | warn | fail', function () {
            assert.match(dts, /export type PreflightVerdict = 'pass' \| 'warn' \| 'fail';/);
        });
    });

    describe('producers', function () {
        for (const p of PRODUCERS) {
            const rel = p.file.join('/');
            it(rel + ' still produces the pinned fields', function () {
                const file = path.join(SIBLINGS, ...p.file);
                if (!fs.existsSync(file)) {
                    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + file + ' is missing');
                    return this.skip();
                }
                const src = fs.readFileSync(file, 'utf8');
                // A field is produced as an object-literal key or as an assignment onto the answer.
                for (const f of p.fields) assert.match(src, new RegExp('\\b' + f + ':|\\.' + f + '\\s*='), rel + ' no longer produces ' + f);
            });
        }
    });
});

describe('XChainSDK.getFeeQuote', function () {
    function sdkWithQuote(answer) {
        const sdk = new XChainSDK({ network: 'bitcoin-regtest', explorerUrl: 'http://localhost:8080', retry: false });
        sinon.stub(sdk.explorer, 'getFeeQuote').resolves(answer);
        return sdk;
    }

    it('returns the explorer quote for the request it was given', async function () {
        const sdk   = sdkWithQuote({ supported: true, valid: true, requiredFeeSats: 1200 });
        const req   = { action: 'SEND', params: ['XCHAIN', '1'], source: 'addr' };
        const quote = await sdk.getFeeQuote(req);
        assert.strictEqual(quote.requiredFeeSats, 1200);
        assert.deepStrictEqual(sdk.explorer.getFeeQuote.firstCall.args[0], req);
    });

    it('refuses an answer that is not a quote', async function () {
        const sdk = sdkWithQuote({ error: 'indexer not ready' });
        await assert.rejects(sdk.getFeeQuote({ action: 'SEND' }), (e) => e.code === 'EXPLORER_BAD_FEEQUOTE');
    });
});
