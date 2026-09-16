// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Contract identity (`meta`) - the static read and the deploy pre-flight.
//
// CONTRACT_META_REQUIRED makes meta.name and meta.description a consensus
// requirement (the DEPLOY action's CONTRACT_MANIFEST verdicts): the indexer answers
// `invalid: CONTRACT_MANIFEST (meta required)` and the deploy's fee is spent anyway.
// The SDK's job is to say so BEFORE the action is composed. Two halves are tested
// here: getExportedMeta (what the static walk can and cannot see) and the pre-flight
// branch on every deploy seam (sdk.deploy, walletSession.deploy/deployChunk, and the
// workflows built on them), including that a refusal happens with ZERO compose calls.

const assert = require('assert');
const sinon  = require('sinon');

const ContractUtils    = require('../../../src/contract/utils.js');
const XChainSDK        = require('../../../src/XChainSDK.js');
const Workflows        = require('../../../src/actions/workflows.js');
const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const WalletSession    = require('../../../src/utils/wallet_session.js');
const TEMPLATES        = require('../../../src/contract/templates.js');

const V = ContractUtils.META_VERDICTS;

function makeSDK(extra = {}) {
    return new XChainSDK(Object.assign({
        network:     'bitcoin-regtest',
        explorerUrl: 'http://localhost:8080',
        encoderUrl:  'http://localhost:3000',
        noHub:       true,
        retry:       false
    }, extra));
}

// A conforming contract, and the same contract with its identity removed.
const WITH_META = `module.exports = {
    meta: { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' },
    permissions: ['SEND'],
    release(xchain) { xchain.state.set('done', '1'); }
};`;
const NO_META = `module.exports = {
    permissions: ['SEND'],
    release(xchain) { xchain.state.set('done', '1'); }
};`;

// Silence the pre-flight's console.warn while still counting what it said.
function captureWarnings(fn) {
    const original = console.warn;
    const lines = [];
    console.warn = (msg) => lines.push(String(msg));
    try { return { value: fn(), lines }; }
    finally { console.warn = original; }
}

    /*
     *  getExportedMeta: present / absent / undecidable
     */
describe('contract identity (meta): static read + deploy pre-flight', function () {
    let utils;
    beforeEach(function () { utils = new ContractUtils(); });
    describe('getExportedMeta()', function () {
        it('reads the three string literals off a module.exports object', function () {
            const read = utils.getExportedMeta(WITH_META);
            assert.strictEqual(read.status, 'present');
            assert.strictEqual(read.name, 'Escrow');
            assert.strictEqual(read.description, 'Two-party escrow with an arbiter');
            assert.strictEqual(read.version, '1.0.0');
            assert.deepStrictEqual(read.computed, []);
            assert.deepStrictEqual(read.nonStringLiteral, []);
            assert.strictEqual(typeof read.line, 'number');
        });

        it('reads meta off a function export (fn.meta = {...}, spec R1)', function () {
            const read = utils.getExportedMeta(
                "function contract(xchain) { return 'ok'; }\n" +
                "contract.meta = { name: 'Ping', description: 'Returns ok' };\n" +
                'module.exports = contract;');
            assert.strictEqual(read.status, 'present');
            assert.strictEqual(read.name, 'Ping');
            assert.strictEqual(read.description, 'Returns ok');
            assert.strictEqual(read.version, null);
        });

        it('is ABSENT for an object export with no meta key', function () {
            assert.deepStrictEqual(utils.getExportedMeta(NO_META), { status: 'absent' });
        });

        it('is ABSENT for an identifier export with no <id>.meta assignment', function () {
            assert.deepStrictEqual(
                utils.getExportedMeta('function contract(xchain) { return 1; }\nmodule.exports = contract;'),
                { status: 'absent' });
        });

        it('separates a MISSING key (null) from a key present but non-literal (computed)', function () {
            const read = utils.getExportedMeta(
                "const suffix = '2';\n" +
                'module.exports = { meta: { name: ' + "'Escrow ' + suffix" + " }, run() {} };");
            assert.strictEqual(read.status, 'present');
            assert.strictEqual(read.name, null);          // no literal to read
            assert.deepStrictEqual(read.computed, ['name']);
            assert.strictEqual(read.description, null);   // genuinely absent
            assert.ok(!read.computed.includes('description'));
        });

        it('reports a literal that is not a string in nonStringLiteral', function () {
            const read = utils.getExportedMeta(
                "module.exports = { meta: { name: 'A', description: 'B', version: 1 }, run() {} };");
            assert.strictEqual(read.status, 'present');
            assert.strictEqual(read.version, null);
            assert.deepStrictEqual(read.nonStringLiteral, ['version']);
        });
    });
});

describe('contract identity (meta): static read + deploy pre-flight', function () {
    let utils;
    beforeEach(function () { utils = new ContractUtils(); });
    describe('getExportedMeta()', function () {
        it('is UNDECIDABLE for an inline function export, a spread, a computed key, a non-object meta and unparseable source', function () {
            const cases = [
                'module.exports = function (xchain) { return 1; };',
                "const base = { meta: { name: 'A' } };\nmodule.exports = { ...base, run() {} };",
                "const k = 'meta';\nmodule.exports = { [k]: { name: 'A' }, run() {} };",
                'module.exports = { meta: buildMeta(), run() {} };',
                'module.exports = { meta: { ...spread }, run() {} };',
                'module.exports = { meta: { name: "A" }, run() {'
            ];
            for (const src of cases)
                assert.deepStrictEqual(utils.getExportedMeta(src), { status: 'undecidable' }, src.slice(0, 40));
        });

        // Two module.exports assignments: the chain evaluates whichever runs LAST,
        // and this walk cannot prove which that is. Reading the FIRST one reported
        // valid metadata for a source whose evaluated export has none, and refused a
        // source whose evaluated export is fine, with the exact consensus string.
        it('is UNDECIDABLE when a source assigns module.exports more than once', function () {
            const META = "{ name: 'A', description: 'B' }";
            const first = 'module.exports = { meta: ' + META + ', run() {} };\nmodule.exports = { run() {} };';
            const reversed = 'module.exports = { run() {} };\nmodule.exports = { meta: ' + META + ', run() {} };';
            for (const src of [first, reversed])
                assert.deepStrictEqual(utils.getExportedMeta(src), { status: 'undecidable' }, src.slice(0, 40));
            // And the pre-flight advises rather than refusing either of them.
            for (const src of [first, reversed]) {
                const v = utils.checkExportedMeta(src);
                assert.strictEqual(v.error, null);
                assert.strictEqual(v.advisories.length, 1);
            }
        });

        it('is UNDECIDABLE when the function-export form assigns <id>.meta more than once', function () {
            const src = 'function c (xchain) { return 1; }\n' +
                "c.meta = { name: 'A', description: 'B' };\n" +
                "c.meta = { name: '', description: '' };\n" +
                'module.exports = c;';
            assert.deepStrictEqual(utils.getExportedMeta(src), { status: 'undecidable' });
        });

        it('never throws on junk input', function () {
            for (const src of ['', null, undefined, 42, '<<<'])
                assert.ok(['present', 'absent', 'undecidable'].includes(utils.getExportedMeta(src).status));
        });
    });
});
