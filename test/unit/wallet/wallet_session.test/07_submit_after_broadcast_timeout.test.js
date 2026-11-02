// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// CONFIRMATION_TIMEOUT means the transaction is on the wire and only the
// indexer wait ran out. Its inputs are gone: a later submit from the same
// session must never be handed them again (that build is either a byte-equal
// rebroadcast the node refuses or a conflicting spend), and the session must
// recover on its own, with no refreshUTXOs() or cache invalidation.

const assert = require('assert');
const sinon = require('sinon');
const bitcoin = require('bitcoinjs-lib');

const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const WalletSession = require('../../../../src/utils/wallet_session.js');
const ActionWaiter = require('../../../../src/utils/action_waiter.js');
const { SDKActionError } = require('../../../../src/utils/errors.js');
const { buildSignedTx, makeSdk: makeCarrierSdk } =
    require('../../carrier/lifecycle_manager.test/helpers/lifecycle_manager.js');

const WIF_MAINNET = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73NUBBy7N';
const FAKE_KEY_INFO = {
    publicKeyHex: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    publicKey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
    compressed: true
};
const OTHER = { txid: 'ee'.repeat(32), vout: 3, value: 50000, scriptPubKey: '00', confirmations: 1 };
const outpoint = (u) => u.txid + ':' + u.vout;

// A session-level sdk whose tracker view holds only utxo1:0.
function trackerSdk() {
    const encoder = { getUTXOs: async () => ({ utxos: [{ txid: 'utxo1', vout: 0, value: 100000 }] }) };
    return {
        wallet: { importWIF: () => FAKE_KEY_INFO, deriveAddress: () => 'mTestAddr123' },
        requireEncoder: () => encoder
    };
}

// A carrier-level sdk running the real LifecycleManager over one OP_RETURN
// commit whose only output pays back to the session address (its change).
// Every createTx records the inputs it was handed in `builds`.
function lifecycleSdk() {
    const commit = buildSignedTx();
    const tx = bitcoin.Transaction.fromHex(commit.txHex);
    const address = bitcoin.address.fromOutputScript(tx.outs[0].script, bitcoin.networks.regtest);
    const commitInputs = LifecycleManager.prototype.extractSpentInputs(commit.psbtHex);
    const held = commitInputs.map((i) => ({ txid: i.txid, vout: i.vout, value: 100000, scriptPubKey: '00', confirmations: 1 }));
    const builds = [];
    const sdk = makeCarrierSdk();
    const encoder = sdk.requireEncoder();
    encoder.getUTXOs = async () => ({ utxos: held.concat([OTHER]) });
    encoder.createTx = async (txParams) => {
        builds.push((txParams.utxos || []).map(outpoint));
        return { psbt: commit.psbtHex, encoding: 'OP_RETURN' };
    };
    Object.assign(sdk.wallet, {
        signPsbt:          () => ({ txHex: commit.txHex, txid: commit.txid, psbtHex: commit.psbtHex }),
        importWIF:         () => FAKE_KEY_INFO,
        deriveAddress:     () => address,
        getBitcoinNetwork: () => bitcoin.networks.regtest
    });
    return { sdk, commit, commitInputs, builds };
}

describe('WalletSession submit() after a broadcast whose indexer wait timed out', function () {
    afterEach(function () { sinon.restore(); });

    it('drops the broadcast inputs, keeps its change, and the next submit spends only that', async function () {
        const change = { txid: 'tx1', vout: 1, value: 90000, scriptPubKey: '76a914aa88ac', confirmations: 0 };
        const stub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        stub.onCall(0).rejects(Object.assign(new Error('not indexed within 1000 ms'), {
            code: 'CONFIRMATION_TIMEOUT', broadcast: true, txid: 'tx1',
            spentInputs: [{ txid: 'utxo1', vout: 0 }], changeOutputs: [change], details: { broadcast: true }
        }));
        stub.onCall(1).resolves({ txid: 'tx2', spentInputs: [{ txid: 'tx1', vout: 1 }], changeOutputs: [] });

        const session = new WalletSession(trackerSdk(), WIF_MAINNET, { waitForIndexer: true });
        await session.refreshUTXOs();
        await assert.rejects(session.submit({ action: 'SEND', params: {} }),
            (err) => err.code === 'CONFIRMATION_TIMEOUT' && err.broadcast === true);

        const available = session._utxoCache.getAvailable().map(outpoint);
        assert.ok(!available.includes('utxo1:0'), 'the broadcast input is never offered again: ' + available);
        assert.ok(available.includes('tx1:1'), 'the broadcast change is offered for chaining: ' + available);

        // No refreshUTXOs() or invalidate() between the two submits.
        await session.submit({ action: 'SEND', params: {} });
        const handed = (stub.secondCall.args[1].utxos || []).map(outpoint);
        assert.deepStrictEqual(handed, ['tx1:1'], 'the next build must not spend the broadcast input');
    });

    it('through the real lifecycle, the next build is handed none of the broadcast inputs', async function () {
        const { sdk, commit, commitInputs, builds } = lifecycleSdk();
        sinon.stub(ActionWaiter.prototype, 'waitForTxid').rejects(
            new SDKActionError('CONFIRMATION_TIMEOUT', 'not indexed', { txid: commit.txid, timeout: 1000 }));

        const session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: true, timeout: 1000 });
        await assert.rejects(session.submit({ action: 'SEND', params: {} }), (err) =>
            err.code === 'CONFIRMATION_TIMEOUT' && err.broadcast === true && err.txid === commit.txid);

        const available = session._utxoCache.getAvailable().map(outpoint);
        for (const input of commitInputs) {
            assert.ok(!available.includes(outpoint(input)), outpoint(input) + ' is in the mempool and still offered');
        }
        assert.ok(available.includes(commit.txid + ':0'), 'the broadcast change is offered: ' + available);
        assert.ok(available.includes(outpoint(OTHER)), 'an unrelated input stays available');

        await assert.rejects(session.submit({ action: 'SEND', params: {} }), /not indexed/);
        assert.strictEqual(builds.length, 2);
        for (const input of commitInputs) {
            assert.ok(!builds[1].includes(outpoint(input)), 'the second build re-spent ' + outpoint(input));
        }
    });
});
