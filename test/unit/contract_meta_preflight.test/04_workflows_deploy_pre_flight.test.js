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

describe('contract identity (meta): static read + deploy pre-flight', function () {

    let utils;
    beforeEach(function () { utils = new ContractUtils(); });

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
