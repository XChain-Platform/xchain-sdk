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
// ---------------------------------------------------------------------------
// Unit: Taproot envelope pair through the action lifecycle ( §6, )
//
// A TAPROOT create_tx returns BOTH transactions from one call. Before  the
// lifecycle signed the commit, broadcast it, then branched only on P2SH/P2WSH for a
// second transaction: a TAPROOT response matched neither, so the commit went on
// chain and the reveal was never signed or broadcast. The caller got a txid for a
// transaction carrying no action, and the coin sat in a one-time P2TR output whose
// only exit is the §3.5 key-path cancel, from state the SDK never persisted.
//
// The load-bearing property here is ORDERING, not merely "both get broadcast":
// §6 requires the reveal to be signable BEFORE the commit is broadcast, because
// discovering an unsignable reveal afterwards manufactures a stranded-funds event
// rather than an error message. The 'nothing is broadcast' test below is the one
// that actually pins that, so it is worth more than the happy path.
// ---------------------------------------------------------------------------

'use strict';

const assert = require('assert');
const LifecycleManager = require('../../src/lifecycleManager.js');

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

function buildSignedTx() {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const ECPair = ECPairFactory(ecc);
    const net = bitcoin.networks.regtest;
    const kp = ECPair.makeRandom({ network: net });
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(script, 100_000);
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd,
                    witnessUtxo: { script, value: 100_000 } });
    psbt.addOutput({ script, value: 90_000 });
    // The encoder answers UNSIGNED, and reconcileEncoded no longer reads a PRE-SIGNED
    // input's script as a signer-owned change destination (), so the mock has
    // to hand back the pre-signature hex. The signing below exists only to produce a
    // broadcastable txHex/txid for the broadcast mock.
    const unsignedHex = psbt.toHex();
    psbt.signAllInputs(kp);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { psbtHex: unsignedHex, txHex: tx.toHex(), txid: tx.getId() };
}

// Fake SDK whose encoder returns an ENVELOPE PAIR, with every broadcast and signing
// call recorded in one ordered trace so the sequence itself can be asserted.
const RECOVERY = {
    commitTxid: 'aa'.repeat(32), commitVout: 0, commitValue: 12345,
    commitAddress: 'bcrt1pexample', internalPubkey: 'bb'.repeat(32),
    tapleafHash: 'cc'.repeat(32), controlBlock: 'c1' + 'dd'.repeat(32), revealFee: 500,
};

function makeEnvelopeSdk({ revealSignThrows = false, revealBroadcastThrows = false, customSigner = null } = {}) {
    const signed = buildSignedTx();
    const trace = [];

    const encoder = {
        createTx: async () => ({
            psbt:       signed.psbtHex,
            revealPsbt: signed.psbtHex,          // the pair, per §6
            envelope:   RECOVERY,                // the §3.5 recovery record
            encoding:   'TAPROOT',
        }),
        broadcastTx: async (hex) => {
            trace.push('broadcast:' + (hex === signed.txHex ? 'tx' : '?'));
            if (revealBroadcastThrows && trace.filter(t => t.startsWith('broadcast')).length === 2) {
                throw new Error('node rejected the reveal');
            }
            return { txid: signed.txid };
        },
        spendP2sh:   async () => { trace.push('spendP2sh'); return { psbt: signed.psbtHex }; },
    };

    const sdk = {
        _requireEncoder: () => encoder,
        actions: { createAction: () => ({ actionString: 'XCHAIN|FILE|...', action: 'FILE', version: 0 }) },
        tickResolver:    { resolveActionParams: async (a, p) => p },
        addressResolver: { resolveActionParams: async (a, p) => p },
        wallet: {
            // The reconcile gate parses submitted addresses against this, so a fake
            // that omits it silently reconciles regtest intent against mainnet.
            getBitcoinNetwork: () => require('bitcoinjs-lib').networks.regtest,
            signPsbt: () => { trace.push('signCommit'); return { txHex: signed.txHex, txid: 'COMMITTXID', psbtHex: signed.psbtHex }; },
            signRevealPsbt: () => { trace.push('signChunkReveal'); return { txHex: signed.txHex, txid: 'phase2txid', psbtHex: signed.psbtHex }; },
            signEnvelopeRevealPsbt: () => {
                trace.push('signEnvelopeReveal');
                if (revealSignThrows) throw new Error('reveal is unsignable by this key');
                return { txHex: signed.txHex, txid: 'REVEALTXID', psbtHex: signed.psbtHex };
            },
        },
    };
    return { sdk, trace, signed, customSigner };
}

const submit = (lm, opts = {}) => lm.submitAction(
    { action: 'FILE', params: {} }, { pubkey: '03abc' },
    Object.assign({ wif: FAKE_WIF, waitForIndexer: false }, opts));

describe('Taproot envelope pair through the lifecycle ', function () {

    it('signs BOTH halves before anything is broadcast, then commit -> reveal', async function () {
        const { sdk, trace } = makeEnvelopeSdk();
        await submit(new LifecycleManager(sdk));
        // The whole safety argument is in this sequence.
        assert.deepStrictEqual(trace, [
            'signCommit',
            'signEnvelopeReveal',      // BEFORE any broadcast (§6)
            'broadcast:tx',            // commit
            'broadcast:tx',            // reveal
        ]);
    });

    it('an unsignable reveal broadcasts NOTHING (the stranded-funds case)', async function () {
        const { sdk, trace } = makeEnvelopeSdk({ revealSignThrows: true });
        await assert.rejects(() => submit(new LifecycleManager(sdk)));
        assert.ok(!trace.some(t => t.startsWith('broadcast')),
            'nothing may reach the chain when the reveal cannot be signed; trace was ' + JSON.stringify(trace));
    });

    it('returns the REVEAL txid as the action txid, not the commit (§3.1)', async function () {
        const { sdk } = makeEnvelopeSdk();
        const result = await submit(new LifecycleManager(sdk));
        assert.strictEqual(result.txid, 'REVEALTXID');
        assert.notStrictEqual(result.txid, 'COMMITTXID');
    });

    it('never takes the P2SH/P2WSH phase-2 path for an envelope', async function () {
        const { sdk, trace } = makeEnvelopeSdk();
        await submit(new LifecycleManager(sdk));
        assert.ok(!trace.includes('spendP2sh'));
        assert.ok(!trace.includes('signChunkReveal'));
    });

    it('refuses a custom signer for an envelope BEFORE broadcasting anything', async function () {
        const { sdk, trace } = makeEnvelopeSdk();
        await assert.rejects(
            () => submit(new LifecycleManager(sdk), { signer: async () => ({ txHex: 'x', txid: 'y' }) }),
            (e) => e.code === 'SIGNER_ENCODING_UNSUPPORTED');
        assert.ok(!trace.some(t => t.startsWith('broadcast')), 'refusal must precede any broadcast');
    });

    it('tracks the reveal inputs too, so UTXO cache accounting is not half-done', async function () {
        const { sdk } = makeEnvelopeSdk();
        const result = await submit(new LifecycleManager(sdk));
        assert.ok(Array.isArray(result.spentInputs));
        assert.ok(result.spentInputs.length >= 2, 'commit and reveal inputs both counted');
    });

    it('a p2tr leg the reveal never spends aborts BEFORE anything is broadcast ', async function () {
        // Rule (d) used to authorize the commit leg on script shape alone, so a
        // hostile encoder could add a second, correctly shaped P2TR output only it can
        // spend and the SDK would sign it. The commit and its reveal arrive from one
        // createTx call, so the reveal's inputs decide which leg is real.
        const bitcoin = require('bitcoinjs-lib');
        const crypto = require('crypto');
        const { sdk, trace, signed } = makeEnvelopeSdk();
        const net = bitcoin.networks.regtest;
        const fundingScript = bitcoin.Psbt.fromHex(signed.psbtHex).data.inputs[0].witnessUtxo.script;
        const shapedP2tr = () => bitcoin.script.compile([bitcoin.opcodes.OP_1, crypto.randomBytes(32)]);
        const commitLeg = shapedP2tr(), parked = shapedP2tr();

        const commit = new bitcoin.Psbt({ network: net });
        commit.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: fundingScript, value: 100_000 } });
        commit.addOutput({ script: commitLeg, value: 8_000 });
        commit.addOutput({ script: parked,    value: 85_000 });     // the theft
        const reveal = new bitcoin.Psbt({ network: net });
        reveal.addInput({ hash: 'bb'.repeat(32), index: 0, witnessUtxo: { script: commitLeg, value: 8_000 } });
        reveal.addOutput({ script: fundingScript, value: 7_500 });

        sdk._requireEncoder = () => ({
            createTx:    async () => ({ psbt: commit.toHex(), revealPsbt: reveal.toHex(), envelope: RECOVERY, encoding: 'TAPROOT' }),
            broadcastTx: async () => { trace.push('broadcast:tx'); return {}; },
            spendP2sh:   async () => ({}),
        });
        await assert.rejects(() => submit(new LifecycleManager(sdk)), (e) => e.code === 'PHASE_FUNDING_UNSPENT');
        assert.deepStrictEqual(trace, [], 'nothing may be signed or broadcast once the commit fails to reconcile');
    });

    it('the same pair WITHOUT the parked leg goes all the way through', async function () {
        // The other half of the pin: a legitimate commit still reconciles, so the
        // rejection above is the encoder misbehaving rather than the gate being blind.
        const bitcoin = require('bitcoinjs-lib');
        const crypto = require('crypto');
        const { sdk, trace, signed } = makeEnvelopeSdk();
        const net = bitcoin.networks.regtest;
        const fundingScript = bitcoin.Psbt.fromHex(signed.psbtHex).data.inputs[0].witnessUtxo.script;
        const commitLeg = bitcoin.script.compile([bitcoin.opcodes.OP_1, crypto.randomBytes(32)]);

        const commit = new bitcoin.Psbt({ network: net });
        commit.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: fundingScript, value: 100_000 } });
        commit.addOutput({ script: commitLeg, value: 8_000 });
        commit.addOutput({ script: fundingScript, value: 90_000 });
        const reveal = new bitcoin.Psbt({ network: net });
        reveal.addInput({ hash: 'bb'.repeat(32), index: 0, witnessUtxo: { script: commitLeg, value: 8_000 } });
        reveal.addOutput({ script: fundingScript, value: 7_500 });

        sdk._requireEncoder = () => ({
            createTx:    async () => ({ psbt: commit.toHex(), revealPsbt: reveal.toHex(), envelope: RECOVERY, encoding: 'TAPROOT' }),
            broadcastTx: async () => { trace.push('broadcast:tx'); return {}; },
            spendP2sh:   async () => ({}),
        });
        await new LifecycleManager(sdk).submitAction(
            { action: 'FILE', params: {} },
            { pubkey: '03abc', change: bitcoin.address.fromOutputScript(fundingScript, net) },
            { wif: FAKE_WIF, waitForIndexer: false });
        assert.deepStrictEqual(trace, ['signCommit', 'signEnvelopeReveal', 'broadcast:tx', 'broadcast:tx']);
    });

    it('a NON-envelope response is untouched by any of this', async function () {
        const { sdk, trace } = makeEnvelopeSdk();
        sdk._requireEncoder = () => ({
            createTx:    async () => ({ psbt: buildSignedTx().psbtHex, encoding: 'OP_RETURN' }),
            broadcastTx: async () => { trace.push('broadcast:tx'); return {}; },
            spendP2sh:   async () => ({}),
        });
        await submit(new LifecycleManager(sdk));
        assert.deepStrictEqual(trace, ['signCommit', 'broadcast:tx'],
            'no envelope signing on a lane that has no reveal');
    });

    it('hands the §3.5 recovery record to the caller BEFORE the commit is broadcast', async function () {
        const { sdk, trace } = makeEnvelopeSdk();
        const events = [];
        await submit(new LifecycleManager(sdk), { onProgress: (stage, data) => events.push({ stage, data }) });
        const i = events.findIndex(e => e.stage === 'envelope_recovery_record');
        assert.ok(i >= 0, 'the record must be emitted at all: without it §3.5 cancel is impossible');
        assert.deepStrictEqual(events[i].data.recovery, RECOVERY);
        // and it must arrive while nothing is on chain
        const broadcastIdx = events.findIndex(e => e.stage === 'broadcasting');
        assert.ok(broadcastIdx === -1 || i < broadcastIdx,
            'the record is worthless if it arrives after the commit is already broadcast');
    });

    it('a reveal REJECTED after the commit landed carries the recovery record out with the error', async function () {
        const { sdk } = makeEnvelopeSdk({ revealBroadcastThrows: true });
        await assert.rejects(() => submit(new LifecycleManager(sdk)), (err) => {
            assert.strictEqual(err.code, 'ENVELOPE_REVEAL_BROADCAST_FAILED');
            // losing these is losing the funds
            assert.deepStrictEqual(err.details.recovery, RECOVERY);
            assert.ok(err.details.commitTxid, 'the caller must know WHICH commit is stranded');
            assert.ok(err.details.revealTxHex, 'so the broadcast can simply be retried');
            return true;
        });
    });
});
