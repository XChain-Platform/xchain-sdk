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

const ContractUtils    = require('../../src/contracts.js');
const XChainSDK        = require('../../src/XChainSDK.js');
const Workflows        = require('../../src/workflows.js');
const LifecycleManager = require('../../src/lifecycleManager.js');
const WalletSession    = require('../../src/walletSession.js');
const TEMPLATES        = require('../../src/contract/templates.js');

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

describe('contract identity (meta): static read + deploy pre-flight', function () {

    let utils;
    beforeEach(function () { utils = new ContractUtils(); });

    /*
     *  getExportedMeta: present / absent / undecidable
     */
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

        it('never throws on junk input', function () {
            for (const src of ['', null, undefined, 42, '<<<'])
                assert.ok(['present', 'absent', 'undecidable'].includes(utils.getExportedMeta(src).status));
        });
    });

    /*
     *  checkExportedMeta: the client-side mirror of the consensus grammar.
     *  Every refusal is the EXACT string the chain writes into the action status.
     */
    describe('checkExportedMeta()', function () {

        const wrap = (meta) => 'module.exports = { meta: ' + meta + ', run() {} };';

        it('passes a conforming meta with no advisories', function () {
            assert.deepStrictEqual(utils.checkExportedMeta(WITH_META), { error: null, advisories: [] });
        });

        it('refuses an absent meta with the consensus REQUIRED string', function () {
            assert.strictEqual(utils.checkExportedMeta(NO_META).error,
                'invalid: CONTRACT_MANIFEST (meta required)');
        });

        it('refuses a missing name and a missing description with their own strings', function () {
            assert.strictEqual(utils.checkExportedMeta(wrap("{ description: 'D' }")).error, V.NAME);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'N' }")).error, V.DESCRIPTION);
        });

        it('judges the name by UTF-8 BYTES, not characters (64-byte cap)', function () {
            const okBytes  = 'e'.repeat(64);
            const overCap  = 'e'.repeat(65);
            const multibyte = 'é'.repeat(32);       // 64 bytes
            const multiOver = 'é'.repeat(33);       // 66 bytes
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: '" + okBytes + "', description: 'D' }")).error, null);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: '" + overCap + "', description: 'D' }")).error, V.NAME);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: '" + multibyte + "', description: 'D' }")).error, null);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: '" + multiOver + "', description: 'D' }")).error, V.NAME);
        });

        it('refuses a banned code point anywhere in the name (bidi override, zero width, control)', function () {
            for (const bad of ['‮', '​', '', '﻿', '⁩'])
                assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'Esc" + bad + "row', description: 'D' }")).error,
                    V.NAME, JSON.stringify(bad));
        });

        it('refuses edge whitespace (including U+00A0) at either end', function () {
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: ' Escrow', description: 'D' }")).error, V.NAME);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'Escrow ', description: 'D' }")).error, V.NAME);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: '　Escrow', description: 'D' }")).error, V.NAME);
        });

        it('refuses an empty string and a lone surrogate', function () {
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: '', description: 'D' }")).error, V.NAME);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: '\\ud800', description: 'D' }")).error, V.NAME);
        });

        it('allows LF inside a description but never inside a name', function () {
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'N', description: 'line one\\nline two' }")).error, null);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'a\\nb', description: 'D' }")).error, V.NAME);
        });

        it('judges version only when the key is present (optional field)', function () {
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'N', description: 'D' }")).error, null);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'N', description: 'D', version: '' }")).error, V.VERSION);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'N', description: 'D', version: 1 }")).error, V.VERSION);
            assert.strictEqual(utils.checkExportedMeta(wrap("{ name: 'N', description: 'D', version: '" + 'v'.repeat(33) + "' }")).error, V.VERSION);
        });

        it('reports the FIRST failing row, name before description', function () {
            assert.strictEqual(utils.checkExportedMeta(wrap('{ }')).error, V.NAME);
        });

        it('ADVISES, never refuses, a computed field (the chain evaluates it)', function () {
            const r = utils.checkExportedMeta(
                "module.exports = { meta: { name: 'Escrow ' + n, description: 'D' }, run() {} };");
            assert.strictEqual(r.error, null);
            assert.strictEqual(r.advisories.length, 1);
            assert.ok(/computed expression/.test(r.advisories[0]));
        });

        it('ADVISES, never refuses, an undecidable shape', function () {
            const r = utils.checkExportedMeta('module.exports = function (xchain) { return 1; };');
            assert.strictEqual(r.error, null);
            assert.strictEqual(r.advisories.length, 1);
        });

        it('accepts every template the SDK ships (row 5 gave all of them a meta)', function () {
            const names = Object.keys(TEMPLATES.templates);
            assert.ok(names.length > 0, 'no templates embedded');
            for (const name of names) {
                const src = Buffer.from(TEMPLATES.templates[name], 'base64').toString('utf8');
                const r = utils.checkExportedMeta(src);
                assert.strictEqual(r.error, null, name + ': ' + r.error);
                assert.strictEqual(utils.getExportedMeta(src).status, 'present', name);
            }
        });
    });

    /*
     *  sdk.deploy(): the lint seam's meta branch (block | warn | off)
     */
    describe('sdk.deploy() pre-flight', function () {

        let sdk, createAction;
        beforeEach(function () {
            sdk = makeSDK();
            // The compose seam: everything that costs a fee happens beyond it.
            createAction = sinon.stub(sdk, 'createAction').resolves({ action: 'DEPLOY' });
        });
        afterEach(function () { sinon.restore(); });

        it("block mode refuses a nameless contract with the consensus string and NEVER composes", async function () {
            let err = null;
            const { lines } = captureWarnings(() => {});
            await sdk.deploy({ CODE: NO_META, GAS_LIMIT: '100000' }).catch((e) => { err = e; });
            assert.ok(err, 'expected a refusal');
            assert.strictEqual(err.message, 'invalid: CONTRACT_MANIFEST (meta required)');
            assert.strictEqual(err.code, 'CONTRACT_META_REQUIRED');
            assert.strictEqual(err.details.verdict, 'invalid: CONTRACT_MANIFEST (meta required)');
            assert.strictEqual(createAction.callCount, 0, 'composed an action for a deploy the chain rejects');
            assert.strictEqual(lines.length, 0);
        });

        it('block mode refuses a failing name literal with the meta.name string', async function () {
            const src = "module.exports = { meta: { name: '" + 'x'.repeat(65) + "', description: 'D' }, run() {} };";
            let err = null;
            await sdk.deploy({ CODE: src }).catch((e) => { err = e; });
            assert.ok(err);
            assert.strictEqual(err.message, V.NAME);
            assert.strictEqual(err.code, 'CONTRACT_META_INVALID');
            assert.strictEqual(createAction.callCount, 0);
        });

        it('refuses the camelCase spelling too (deploy({ code }))', async function () {
            let err = null;
            await sdk.deploy({ code: NO_META, gasLimit: 100000 }).catch((e) => { err = e; });
            assert.ok(err, 'expected a refusal');
            assert.strictEqual(err.message, 'invalid: CONTRACT_MANIFEST (meta required)');
            assert.strictEqual(createAction.callCount, 0);
        });

        it('block mode passes a conforming contract through to compose', async function () {
            await sdk.deploy({ CODE: WITH_META, GAS_LIMIT: '100000' });
            assert.strictEqual(createAction.callCount, 1);
        });

        it('warn mode logs the same string and composes anyway', async function () {
            const original = console.warn;
            const lines = [];
            console.warn = (m) => lines.push(String(m));
            try {
                await sdk.deploy({ CODE: NO_META }, undefined, { lint: 'warn' });
            } finally { console.warn = original; }
            assert.strictEqual(createAction.callCount, 1);
            assert.ok(lines.some((l) => l.indexOf('invalid: CONTRACT_MANIFEST (meta required)') !== -1),
                'warn mode said nothing about the missing meta: ' + JSON.stringify(lines));
        });

        it('off mode neither refuses nor warns', async function () {
            const original = console.warn;
            const lines = [];
            console.warn = (m) => lines.push(String(m));
            try {
                await sdk.deploy({ CODE: NO_META }, undefined, { lint: 'off' });
            } finally { console.warn = original; }
            assert.strictEqual(createAction.callCount, 1);
            assert.strictEqual(lines.length, 0);
        });

        it('a computed meta only advises, and still composes in block mode', async function () {
            const src = "module.exports = { meta: { name: 'Escrow ' + n, description: 'D' }, run() {} };";
            const original = console.warn;
            const lines = [];
            console.warn = (m) => lines.push(String(m));
            try { await sdk.deploy({ CODE: src }); } finally { console.warn = original; }
            assert.strictEqual(createAction.callCount, 1);
            assert.ok(lines.some((l) => /computed expression/.test(l)));
        });
    });

    /*
     *  walletSession.deploy / deployChunk: the session seam, driven on a REAL SDK
     *  with only the broadcast layer stubbed.
     */
    describe('walletSession.deploy() pre-flight', function () {

        let sdk, session, submitAction;
        beforeEach(function () {
            sdk = makeSDK();
            const kp = sdk.wallet.generateKeyPair();
            session = sdk.session(kp.wif, { waitForIndexer: false });
            // submitAction is compose + sign + broadcast: nothing past this point is free.
            submitAction = sinon.stub(LifecycleManager.prototype, 'submitAction')
                .resolves({ txid: 'deadbeef', indexed: { action_index: 7 } });
            // The session pulls its UTXO view before composing; there is no encoder here.
            sinon.stub(WalletSession.prototype, 'refreshUTXOs').resolves([]);
        });
        afterEach(function () { sinon.restore(); });

        it('refuses a nameless deploy with the consensus string and NEVER submits', async function () {
            let err = null;
            await session.deploy({ code: NO_META, gasLimit: 100000 }).catch((e) => { err = e; });
            assert.ok(err, 'expected a refusal');
            assert.strictEqual(err.message, 'invalid: CONTRACT_MANIFEST (meta required)');
            assert.strictEqual(submitAction.callCount, 0, 'broadcast a deploy the chain rejects');
        });

        it('refuses a base64 codeEncoding whose decoded source has no meta', async function () {
            let err = null;
            await session.deploy({ codeEncoding: Buffer.from(NO_META, 'utf8').toString('base64') })
                .catch((e) => { err = e; });
            assert.ok(err);
            assert.strictEqual(err.message, 'invalid: CONTRACT_MANIFEST (meta required)');
            assert.strictEqual(submitAction.callCount, 0);
        });

        it("preflight:'off' and preflight:false submit the same nameless deploy", async function () {
            await session.deploy({ code: NO_META }, {}, { preflight: 'off' });
            await session.deploy({ code: NO_META }, {}, { preflight: false });
            assert.strictEqual(submitAction.callCount, 2);
        });

        it("preflight:'warn' logs and submits", async function () {
            const original = console.warn;
            const lines = [];
            console.warn = (m) => lines.push(String(m));
            try { await session.deploy({ code: NO_META }, {}, { preflight: 'warn' }); }
            finally { console.warn = original; }
            assert.strictEqual(submitAction.callCount, 1);
            assert.ok(lines.some((l) => l.indexOf('invalid: CONTRACT_MANIFEST (meta required)') !== -1));
        });

        it('submits a conforming deploy, and one built from a shipped template', async function () {
            await session.deploy({ code: WITH_META, gasLimit: 100000 });
            const escrow = Buffer.from(TEMPLATES.templates.escrow, 'base64').toString('utf8');
            await session.deploy({ code: escrow, gasLimit: 100000 });
            assert.strictEqual(submitAction.callCount, 2);
        });

        it('deployChunk refuses a nameless inline source and passes a carrier slice through', async function () {
            let err = null;
            await session.deployChunk({ code: NO_META }).catch((e) => { err = e; });
            assert.ok(err);
            assert.strictEqual(err.message, 'invalid: CONTRACT_MANIFEST (meta required)');
            assert.strictEqual(submitAction.callCount, 0);

            // A real carrier slice carries no source at all: nothing to judge, so it rides.
            await session.deployChunk({ codeHash: 'ab'.repeat(32), chunkIndex: 0, totalChunks: 2, codePart: 'bW9kdWxl' });
            assert.strictEqual(submitAction.callCount, 1);
        });
    });

    /*
     *  workflows.deployAndFund / deployStakeableContract inherit the session branch.
     */
    describe('workflows deploy pre-flight', function () {

        let sdk, workflows, submitAction;
        beforeEach(function () {
            sdk = makeSDK();
            workflows = new Workflows(sdk);
            submitAction = sinon.stub(LifecycleManager.prototype, 'submitAction')
                .resolves({ txid: 'deadbeef', indexed: { action_index: 7 } });
            // The session pulls its UTXO view before composing; there is no encoder here.
            sinon.stub(WalletSession.prototype, 'refreshUTXOs').resolves([]);
        });
        afterEach(function () { sinon.restore(); });

        function wif() { return sdk.wallet.generateKeyPair().wif; }

        it('deployAndFund refuses a nameless contract before any broadcast, and funds nothing', async function () {
            let err = null;
            await workflows.deployAndFund(wif(), { code: NO_META }, [{ tick: 'TOK', quantity: '10' }])
                .catch((e) => { err = e; });
            assert.ok(err, 'expected a refusal');
            const message = err.partial ? err.message : err.message;
            assert.ok(message.indexOf('invalid: CONTRACT_MANIFEST (meta required)') !== -1, message);
            assert.strictEqual(submitAction.callCount, 0, 'broadcast something for a refused deploy');
        });

        it('deployStakeableContract refuses a nameless contract before any broadcast', async function () {
            let err = null;
            await workflows.deployStakeableContract(wif(),
                { code: NO_META, COOLDOWN_BLOCKS: 10, SLASH_DESTINATION: 'BURN' })
                .catch((e) => { err = e; });
            assert.ok(err);
            assert.ok(err.message.indexOf('invalid: CONTRACT_MANIFEST (meta required)') !== -1, err.message);
            assert.strictEqual(submitAction.callCount, 0);
        });

        it("deployAndFund honours preflight:'off'", async function () {
            await workflows.deployAndFund(wif(), { code: NO_META }, [], { preflight: 'off' });
            assert.strictEqual(submitAction.callCount, 1);
        });
    });
});
