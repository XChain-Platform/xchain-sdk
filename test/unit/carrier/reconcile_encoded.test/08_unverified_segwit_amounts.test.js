// Copyright 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
const { reconcileEncoded } = require('../../../../src/carrier/reconcile_encoded.js');
const { buildTransactionRequest } = require('../../../../src/carrier/lifecycle_manager/submission_setup.js');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.bitcoin;

function walletScript() {
    return bitcoin.payments.p2wpkh({ pubkey: ECPair.makeRandom().publicKey, network: NET }).output;
}

function previous(script, value) {
    const tx = new bitcoin.Transaction();
    tx.addInput(crypto.randomBytes(32), 0);
    tx.addOutput(script, value);
    return tx;
}

function spending(prevs, opts = {}) {
    const psbt = new bitcoin.Psbt({ network: NET });
    for (let i = 0; i < prevs.length; i++) {
        const prev = prevs[i];
        const witness = { script: prev.outs[0].script,
            value: opts.values ? opts.values[i] : prev.outs[0].value };
        const input = { hash: prev.getHash(), index: 0, witnessUtxo: witness };
        if (opts.full) input.nonWitnessUtxo = prev.toBuffer();
        psbt.addInput(input);
    }
    const total = prevs.reduce((sum, tx) => sum + Number(tx.outs[0].value), 0);
    psbt.addOutput({ script: opts.output || prevs[0].outs[0].script, value: total - 1000 });
    return psbt;
}

describe('reconcileEncoded segwit-v0 amount binding', function () {
    it('keeps one witness-only input but refuses two before fee accounting', function () {
        const one = previous(walletScript(), 10000);
        assert.strictEqual(reconcileEncoded(spending([one]).toHex(), { network: NET }).fee, 1000n);
        const two = [previous(walletScript(), 10000), previous(walletScript(), 12000)];
        assert.throws(() => reconcileEncoded(spending(two).toHex(), { network: NET, maxFeeSats: 5000 }),
            (e) => e.code === 'UNVERIFIED_INPUT_VALUE');
        assert.throws(() => reconcileEncoded(spending(two).toHex(), { network: NET }),
            (e) => e.code === 'UNVERIFIED_INPUT_VALUE');
    });

    it('accepts hash-bound previous transactions and catches a stated mismatch', function () {
        const prevs = [previous(walletScript(), 10000), previous(walletScript(), 12000)];
        assert.strictEqual(reconcileEncoded(spending(prevs, { full: true }).toHex(), { network: NET }).fee, 1000n);
        assert.throws(() => reconcileEncoded(spending(prevs, { full: true,
            values: [9000, 12000] }).toHex(), { network: NET }),
        (e) => e.code === 'INCONSISTENT_PREVOUT');
    });

    it('counts partial signatures as unbound and exempts taproot commitments', function () {
        const two = [previous(walletScript(), 10000), previous(walletScript(), 12000)];
        const partial = spending(two);
        const signer = ECPair.makeRandom();
        partial.updateInput(0, { partialSig: [{ pubkey: signer.publicKey,
            signature: bitcoin.script.signature.encode(Buffer.alloc(64, 1), bitcoin.Transaction.SIGHASH_ALL) }] });
        assert.throws(() => reconcileEncoded(partial.toHex(), { network: NET }),
            (e) => e.code === 'UNVERIFIED_INPUT_VALUE');
        const tapKey = ECPair.makeRandom().publicKey.subarray(1);
        const taproot = bitcoin.payments.p2tr({ internalPubkey: tapKey, network: NET }).output;
        const mixed = [previous(walletScript(), 10000), previous(taproot, 12000)];
        assert.strictEqual(reconcileEncoded(spending(mixed).toHex(), { network: NET }).fee, 1000n);
    });

    it('binds witness-only reveal inputs to SDK-trusted transactions', function () {
        const redeem = bitcoin.script.compile([bitcoin.opcodes.OP_TRUE]);
        const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: redeem }, network: NET }).output;
        const prevs = [previous(p2wsh, 10000), previous(p2wsh, 12000)];
        const destination = bitcoin.payments.p2wpkh({ pubkey: ECPair.makeRandom().publicKey, network: NET });
        const intent = { network: NET, trustedPrevTxs: prevs.map((tx) => tx.toHex()),
            customOutputs: [{ address: destination.address, value: 21000 }] };
        assert.strictEqual(reconcileEncoded(spending(prevs, { output: destination.output }).toHex(), intent).fee, 1000n);
        const lied = spending(prevs, { output: destination.output, values: [9000, 12000] });
        assert.throws(() => reconcileEncoded(lied.toHex(), intent), (e) => e.code === 'INCONSISTENT_PREVOUT');
    });

    it('defaults reconciled create requests to proof and preserves explicit false', function () {
        const manager = { sdk: { actions: { createAction: () => ({ actionString: 'SEND|0|TOK|1|dest|m' }) } } };
        const normal = buildTransactionRequest(manager, { action: 'SEND' }, { pubkey: '02aa' }, {}, () => {});
        const optedOut = buildTransactionRequest(manager, { action: 'SEND' },
            { pubkey: '02aa', attachPrevTx: false }, {}, () => {});
        assert.strictEqual(normal.txParams.attachPrevTx, true);
        assert.strictEqual(optedOut.txParams.attachPrevTx, false);
    });
});

describe('reveal binding through the chunk reveal path', function () {
    const { buildPhase2Request, prepareChunkReveal } = require('../../../../src/carrier/lifecycle_manager/submission_results.js');

    function revealFixture(values) {
        const redeem = bitcoin.script.compile([bitcoin.opcodes.OP_TRUE]);
        const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: redeem }, network: NET }).output;
        const phase1 = new bitcoin.Transaction();
        phase1.addInput(crypto.randomBytes(32), 0);
        phase1.addOutput(p2wsh, 10000);
        phase1.addOutput(p2wsh, 12000);
        const dest = bitcoin.payments.p2wpkh({ pubkey: ECPair.makeRandom().publicKey, network: NET });
        const psbt = new bitcoin.Psbt({ network: NET });
        for (let i = 0; i < 2; i++)
            psbt.addInput({ hash: phase1.getHash(), index: i, witnessUtxo: { script: p2wsh, value: values[i] } });
        psbt.addOutput({ script: dest.output, value: 21000 });
        const state = {
            encoder: { spendP2sh: async () => ({ psbt: psbt.toHex() }) },
            signed: { txid: phase1.getId(), txHex: phase1.toHex() },
            encoded: { encoding: 'P2WSH', p2shHash: 'aa', p2shHex: 'bb' },
            encoderOpts: { pubkey: '02aa' },
            carriedAction: {},
            reconcileState: { reconcileIntent: { network: NET },
                revealCustomOutputs: [{ address: dest.address, value: 21000 }], phase1: { phaseFunding: [] } },
            createResult: { actionString: 'SEND|0|TOK|1|dest|m' },
            wif: 'unused',
            progress: () => {},
        };
        return { state, manager: { reconcileNetwork: () => NET } };
    }

    async function codeOf(fixture) {
        try { await prepareChunkReveal(fixture.manager, fixture.state); return 'ok'; }
        catch (e) { return e.code || e.message; }
    }

    it('refuses a reveal leg whose stated amount differs from the signed commit', async function () {
        assert.strictEqual(await codeOf(revealFixture([9000, 12000])), 'INCONSISTENT_PREVOUT');
    });

    it('lets truthful reveal legs past the amount gate', async function () {
        const code = await codeOf(revealFixture([10000, 12000]));
        assert.ok(code !== 'INCONSISTENT_PREVOUT' && code !== 'UNVERIFIED_INPUT_VALUE', 'got ' + code);
    });

    it('asks the encoder for previous transactions on a reveal unless the caller opted out', function () {
        const signed = { txHex: '00', txid: 'aa' };
        const encoded = { encoding: 'P2WSH', p2shHash: 'aa', p2shHex: 'bb' };
        assert.strictEqual(buildPhase2Request(signed, encoded, { pubkey: '02aa' }, {}).attachPrevTx, true);
        assert.strictEqual(buildPhase2Request(signed, encoded,
            { pubkey: '02aa', attachPrevTx: false }, {}).attachPrevTx, false);
    });
});
