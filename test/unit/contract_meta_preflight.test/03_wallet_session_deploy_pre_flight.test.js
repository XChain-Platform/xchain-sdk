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
     *  walletSession.deploy / deployChunk: the session seam, driven on a REAL SDK
     *  with only the broadcast layer stubbed.
     */
describe('contract identity (meta): static read + deploy pre-flight', function () {
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
    });
});

describe('contract identity (meta): static read + deploy pre-flight', function () {
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
});
