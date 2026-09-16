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

const ContractUtils    = require('../../../../src/contract/utils.js');
const XChainSDK        = require('../../../../src/XChainSDK.js');
const Workflows        = require('../../../../src/actions/workflows.js');
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const WalletSession    = require('../../../../src/utils/wallet_session.js');
const TEMPLATES        = require('../../../../src/contract/templates.js');

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
     *  sdk.deploy(): the lint seam's meta branch (block | warn | off)
     */
describe('contract identity (meta): static read + deploy pre-flight', function () {
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
    });
});

describe('contract identity (meta): static read + deploy pre-flight', function () {
    describe('sdk.deploy() pre-flight', function () {
        let sdk, createAction;
        beforeEach(function () {
            sdk = makeSDK();
            // The compose seam: everything that costs a fee happens beyond it.
            createAction = sinon.stub(sdk, 'createAction').resolves({ action: 'DEPLOY' });
        });
        afterEach(function () { sinon.restore(); });
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
});
