// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// Regression: an error thrown after the commit is broadcast carries what was broadcast.
//
// When the reveal of a two-transaction action (P2SH chunk or Taproot envelope) is
// rejected, the commit is already in the mempool and its inputs are gone. The
// thrown error must carry the broadcast flag, the txid and the spent inputs, so a
// caller keying on err.broadcast never reads it as a clean failure and a
// WalletSession never offers the commit's inputs to its next submit. Any failure
// after the broadcast, such as the indexer wait refusing the action, must carry
// the spent inputs too.

const assert = require('assert');
const sinon = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
const LifecycleManager = require('../../src/carrier/lifecycle_manager.js');
const WalletSession = require('../../src/utils/wallet_session.js');
const ActionWaiter = require('../../src/utils/action_waiter.js');
const { FAKE_WIF, buildSignedTx, makeSdk } = require('../unit/carrier/lifecycle_manager.test/helpers/lifecycle_manager.js');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const outpoint = (u) => u.txid + ':' + u.vout;

// An unrelated outpoint the session also holds, which must stay available.
const OTHER = { txid: 'ee'.repeat(32), vout: 3, value: 50_000, scriptPubKey: '00', confirmations: 1 };

// A WalletSession over `sdk` whose tracker view holds `utxos`.
function sessionOver(sdk, address, utxos, wif = FAKE_WIF) {
    const encoder = sdk.requireEncoder();
    encoder.getUTXOs = async () => ({ utxos });
    sdk.wallet.importWIF = () => ({ publicKeyHex: '02' + '11'.repeat(32), publicKey: Buffer.alloc(33, 2), compressed: true });
    sdk.wallet.deriveAddress = () => address;
    return new WalletSession(sdk, wif, { waitForIndexer: false });
}

// --- P2SH chunk path ---------------------------------------------------------

// An unsigned reveal-shaped PSBT spending one P2WPKH input, as 09_ builds it.
function chunkRevealPsbt() {
    const NET = bitcoin.networks.bitcoin;
    const kp = ECPair.makeRandom({ network: NET });
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: NET }).output;
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: 'ab'.repeat(32), index: 0, witnessUtxo: { script, value: 100_000 } });
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN]), value: 0 });
    psbt.addOutput({ script, value: 90_000 });
    return psbt.toHex();
}

function chunkSdk() {
    const commit = buildSignedTx();
    const revealHex = chunkRevealPsbt();
    let broadcasts = 0;
    const sdk = makeSdk({
        wallet: {
            signPsbt:       () => ({ txHex: commit.txHex, txid: commit.txid, psbtHex: commit.psbtHex }),
            signRevealPsbt: () => ({ txHex: 'reveal-hex', txid: 'reveal-txid', psbtHex: revealHex }),
        },
    }, {
        createTx:    async () => ({ psbt: commit.psbtHex, encoding: 'P2SH' }),
        spendP2sh:   async () => ({ psbt: revealHex }),
        broadcastTx: async () => { broadcasts += 1; if (broadcasts === 2) throw new Error('client fault after the commit went out'); return {}; },
    });
    const commitInputs = LifecycleManager.prototype.extractSpentInputs(commit.psbtHex);
    return { sdk, commit, commitInputs };
}

// --- Taproot envelope path ---------------------------------------------------

const ENET = bitcoin.networks.regtest;
const EKEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7), { network: ENET });
const EPUB = Buffer.from(EKEY.publicKey);
const X_ONLY = EPUB.subarray(1, 33);
const FUNDING = bitcoin.payments.p2wpkh({ pubkey: EPUB, network: ENET });
const ACTION_STRING = 'XCHAIN|FILE|...';

function envelopeLeaf() {
    const payload = bitcoin.script.compile([Buffer.from(ACTION_STRING, 'utf8')]);
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_FALSE, bitcoin.opcodes.OP_IF,
        Buffer.from('XCHN', 'utf8'), Buffer.from([0x00]), payload,
        bitcoin.opcodes.OP_ENDIF, X_ONLY, bitcoin.opcodes.OP_CHECKSIG,
    ]);
}

// A commit paying the envelope output at vout 0 and change back to FUNDING at
// vout 1, plus the reveal spending vout 0.
function envelopePair() {
    const leaf = envelopeLeaf();
    const tree = { output: leaf };
    const commitPayment = bitcoin.payments.p2tr({ internalPubkey: X_ONLY, scriptTree: tree, network: ENET });
    const revealPayment = bitcoin.payments.p2tr({ internalPubkey: X_ONLY, scriptTree: tree,
        redeem: { output: leaf, redeemVersion: 0xc0 }, network: ENET });
    const commit = new bitcoin.Psbt({ network: ENET });
    commit.addInput({ hash: Buffer.alloc(32, 4), index: 0, witnessUtxo: { script: FUNDING.output, value: 100000 } });
    commit.addOutput({ script: commitPayment.output, value: 8000 });
    commit.addOutput({ script: FUNDING.output, value: 91000 });
    const psbtHex = commit.toHex();
    const commitId = commit.__CACHE.__TX.getId();
    commit.signInput(0, EKEY);
    commit.finalizeAllInputs();
    const tx = commit.extractTransaction();
    const reveal = new bitcoin.Psbt({ network: ENET });
    reveal.addInput({ hash: commitId, index: 0,
        witnessUtxo: { script: commitPayment.output, value: 8000 }, tapInternalKey: X_ONLY,
        tapLeafScript: [{ leafVersion: 0xc0, script: leaf,
            controlBlock: revealPayment.witness[revealPayment.witness.length - 1] }],
    });
    reveal.addOutput({ script: FUNDING.output, value: 7500 });
    return { psbtHex, revealHex: reveal.toHex(), txHex: tx.toHex(), txid: tx.getId() };
}

function envelopeSdk() {
    const pair = envelopePair();
    let broadcasts = 0;
    const encoder = {
        createTx:    async () => ({ psbt: pair.psbtHex, revealPsbt: pair.revealHex, envelope: { commitTxid: pair.txid }, encoding: 'TAPROOT' }),
        broadcastTx: async () => { broadcasts += 1; if (broadcasts === 2) throw new Error('node rejected the reveal'); return {}; },
        spendP2sh:   async () => ({}),
    };
    const sdk = {
        requireEncoder: () => encoder,
        actions: { createAction: () => ({ actionString: ACTION_STRING, action: 'FILE', version: 0 }) },
        tickResolver:    { resolveActionParams: async (a, p) => p },
        addressResolver: { resolveActionParams: async (a, p) => p },
        wallet: {
            getBitcoinNetwork:      () => ENET,
            signPsbt:               () => ({ txHex: pair.txHex, txid: pair.txid, psbtHex: pair.psbtHex }),
            signEnvelopeRevealPsbt: () => ({ txHex: 'envelope-reveal-hex', txid: 'envelope-reveal-txid', psbtHex: pair.revealHex }),
        },
    };
    const commitInputs = LifecycleManager.prototype.extractSpentInputs(pair.psbtHex);
    return { sdk, pair, commitInputs };
}

function assertBroadcastError(err, code, commitTxid, commitInputs) {
    assert.strictEqual(err.code, code);
    assert.strictEqual(err.broadcast, true, 'a caller keying on err.broadcast must see the commit as out');
    assert.strictEqual(err.txid, commitTxid);
    assert.ok(Array.isArray(err.spentInputs) && err.spentInputs.length >= 1, 'spentInputs: ' + JSON.stringify(err.spentInputs));
    for (const input of commitInputs) {
        assert.ok(err.spentInputs.some((s) => outpoint(s) === outpoint(input)), 'commit input ' + outpoint(input) + ' listed');
    }
    // The recovery material is still there.
    assert.strictEqual(err.details.commitTxid, commitTxid);
    assert.ok(err.details.revealTxHex, 'revealTxHex kept so the reveal can be retried');
}

describe('Regression: an error after the commit broadcast carries what was broadcast', function () {

    it('CHUNK_REVEAL_BROADCAST_FAILED carries broadcast, txid and spentInputs', async function () {
        const { sdk, commit, commitInputs } = chunkSdk();
        await assert.rejects(new LifecycleManager(sdk).submitAction({ action: 'SEND', params: {} },
            { pubkey: '03pub', change: 'addr' }, { wif: FAKE_WIF, waitForIndexer: false }), (err) => {
            assertBroadcastError(err, 'CHUNK_REVEAL_BROADCAST_FAILED', commit.txid, commitInputs);
            assert.strictEqual(err.details.revealTxHex, 'reveal-hex');
            return true;
        });
    });

    it('a session drops the commit\'s inputs from its cache when the chunk reveal fails', async function () {
        const { sdk, commit, commitInputs } = chunkSdk();
        const held = commitInputs.map((i) => ({ txid: i.txid, vout: i.vout, value: 100_000, scriptPubKey: '00', confirmations: 1 }));
        const session = sessionOver(sdk, 'addr', held.concat([OTHER]));
        await assert.rejects(session.submit({ action: 'SEND', params: {} }, { encoding: 'P2SH' }),
            (err) => { assertBroadcastError(err, 'CHUNK_REVEAL_BROADCAST_FAILED', commit.txid, commitInputs); return true; });
        const available = session._utxoCache.getAvailable().map(outpoint);
        for (const input of commitInputs) assert.ok(!available.includes(outpoint(input)), outpoint(input) + ' still offered: ' + available);
        assert.ok(available.includes(outpoint(OTHER)), 'an input the commit did not spend stays available');
    });

    it('ENVELOPE_REVEAL_BROADCAST_FAILED carries broadcast, txid and spentInputs', async function () {
        const { sdk, pair, commitInputs } = envelopeSdk();
        await assert.rejects(new LifecycleManager(sdk).submitAction({ action: 'FILE', params: {} },
            { pubkey: EPUB.toString('hex'), change: FUNDING.address }, { wif: EKEY.toWIF(), waitForIndexer: false }), (err) => {
            assertBroadcastError(err, 'ENVELOPE_REVEAL_BROADCAST_FAILED', pair.txid, commitInputs);
            assert.strictEqual(err.details.revealTxHex, 'envelope-reveal-hex');
            return true;
        });
    });

    it('a session drops the envelope commit\'s inputs and keeps its change when the reveal fails', async function () {
        const { sdk, pair, commitInputs } = envelopeSdk();
        const held = commitInputs.map((i) => ({ txid: i.txid, vout: i.vout, value: 100000,
            scriptPubKey: FUNDING.output.toString('hex'), confirmations: 1 }));
        const session = sessionOver(sdk, FUNDING.address, held.concat([OTHER]), EKEY.toWIF());
        await assert.rejects(session.submit({ action: 'FILE', params: {} }, { pubkey: EPUB.toString('hex') }),
            (err) => { assertBroadcastError(err, 'ENVELOPE_REVEAL_BROADCAST_FAILED', pair.txid, commitInputs); return true; });
        const available = session._utxoCache.getAvailable().map(outpoint);
        for (const input of commitInputs) assert.ok(!available.includes(outpoint(input)), outpoint(input) + ' still offered: ' + available);
        assert.ok(available.includes(pair.txid + ':1'), 'the commit\'s change is chained: ' + available);
        assert.ok(!available.includes(pair.txid + ':0'), 'the output the pending reveal spends is never offered');
    });
});

describe('Regression: any failure after a broadcast is tagged, and none before it', function () {

    it('an indexer refusal carries the spent inputs to the cache, not the in-flight flag', async function () {
        const commit = buildSignedTx();
        const sdk = makeSdk();
        const commitInputs = LifecycleManager.prototype.extractSpentInputs(commit.psbtHex);
        sdk.requireEncoder().createTx = async () => ({ psbt: commit.psbtHex, encoding: 'OP_RETURN' });
        sdk.wallet.signPsbt = () => ({ txHex: commit.txHex, txid: commit.txid, psbtHex: commit.psbtHex });
        const refusal = Object.assign(new Error('action is invalid'), { code: 'ACTION_INVALID', details: {} });
        const wait = sinon.stub(ActionWaiter.prototype, 'waitForTxid').rejects(refusal);
        try {
            const held = commitInputs.map((i) => ({ txid: i.txid, vout: i.vout, value: 100_000, scriptPubKey: '00', confirmations: 1 }));
            const session = sessionOver(sdk, 'addr', held.concat([OTHER]));
            await assert.rejects(session.submit({ action: 'SEND', params: {} }, {}, { waitForIndexer: true }), (err) => {
                assert.strictEqual(err.code, 'ACTION_INVALID');
                // A settled refusal is not "awaiting confirmation".
                assert.strictEqual(err.broadcast, undefined);
                assert.ok(err.spentInputs.some((s) => outpoint(s) === outpoint(commitInputs[0])));
                return true;
            });
            const available = session._utxoCache.getAvailable().map(outpoint);
            for (const input of commitInputs) assert.ok(!available.includes(outpoint(input)), outpoint(input) + ' still offered');
            assert.ok(available.includes(outpoint(OTHER)));
        } finally {
            wait.restore();
        }
    });

    it('a failure before any broadcast is not tagged as broadcast and leaves the cache alone', async function () {
        const commit = buildSignedTx();
        const sdk = makeSdk({}, { broadcastTx: async () => { throw new Error('node refused the commit'); } });
        sdk.requireEncoder().createTx = async () => ({ psbt: commit.psbtHex, encoding: 'OP_RETURN' });
        sdk.wallet.signPsbt = () => ({ txHex: commit.txHex, txid: commit.txid, psbtHex: commit.psbtHex });
        const commitInputs = LifecycleManager.prototype.extractSpentInputs(commit.psbtHex);
        const held = commitInputs.map((i) => ({ txid: i.txid, vout: i.vout, value: 100_000, scriptPubKey: '00', confirmations: 1 }));
        const session = sessionOver(sdk, 'addr', held);
        await assert.rejects(session.submit({ action: 'SEND', params: {} }), (err) => {
            assert.notStrictEqual(err.broadcast, true);
            assert.strictEqual(err.spentInputs, undefined);
            return true;
        });
        const available = session._utxoCache.getAvailable().map(outpoint);
        for (const input of commitInputs) assert.ok(available.includes(outpoint(input)), 'unbroadcast input stays available');
    });
});
