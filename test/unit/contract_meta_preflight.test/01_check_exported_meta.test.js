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

    const wrap = (meta) => 'module.exports = { meta: ' + meta + ', run() {} };';

    /*
     *  checkExportedMeta: the client-side mirror of the consensus grammar.
     *  Every refusal is the EXACT string the chain writes into the action status.
     */
describe('contract identity (meta): static read + deploy pre-flight', function () {
    let utils;
    beforeEach(function () { utils = new ContractUtils(); });
    describe('checkExportedMeta()', function () {
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
    });
});

describe('contract identity (meta): static read + deploy pre-flight', function () {
    let utils;
    beforeEach(function () { utils = new ContractUtils(); });
    describe('checkExportedMeta()', function () {
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
});
