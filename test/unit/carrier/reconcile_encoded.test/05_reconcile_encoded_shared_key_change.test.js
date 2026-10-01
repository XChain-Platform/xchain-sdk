// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert  = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { reconcileEncoded } = require('../../../../src/carrier/reconcile_encoded.js');
require('../../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);

const ECPairFactory = require('ecpair').default || require('ecpair').ECPairFactory;
const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.regtest;

const carrier = { script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 };

// A 1-of-2 multisig the wallet key alone can spend, and so can the attacker's.
function sharedKeyScript(wallet, wrap) {
    const p2ms = bitcoin.payments.p2ms({ m: 1, network: NET,
        pubkeys: [Buffer.from(wallet.publicKey), Buffer.from(ECPair.makeRandom({ network: NET }).publicKey)] });
    return wrap({ redeem: p2ms, network: NET });
}

// A wallet-funded PSBT plus one UNSIGNED shared-key input, paying `changeTo` the remainder.
function psbtWithSharedInput(wallet, shared, witness, changeTo) {
    const own = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(wallet.publicKey), network: NET });
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: own.output, value: 100000 } });
    psbt.addInput(Object.assign({ hash: 'bb'.repeat(32), index: 0, witnessUtxo: { script: shared.output, value: 1000 } },
        witness ? { witnessScript: shared.redeem.output } : { redeemScript: shared.redeem.output }));
    psbt.addOutput(carrier);
    psbt.addOutput({ script: changeTo || shared.output, value: 99000 });
    return psbt;
}

const idOf = (key) => Buffer.from(key.publicKey).toString('hex');

describe('reconcileEncoded shared-key change', function () {
    it('the wallet key alone signs and finalizes a 1-of-2 input it co-controls', function () {
        const wallet = ECPair.makeRandom({ network: NET });
        const psbt = psbtWithSharedInput(wallet, sharedKeyScript(wallet, bitcoin.payments.p2wsh), true);
        psbt.signAllInputs(wallet);
        psbt.finalizeAllInputs();
        assert.ok(psbt.extractTransaction().getId());
    });

    it('REJECTS change to an unsigned P2WSH 1-of-2 input script', function () {
        const wallet = ECPair.makeRandom({ network: NET });
        const shared = sharedKeyScript(wallet, bitcoin.payments.p2wsh);
        const hex = psbtWithSharedInput(wallet, shared, true).toHex();
        assert.throws(() => reconcileEncoded(hex, { network: NET, callerIdentities: idOf(wallet) }),
                      (e) => e.code === 'UNRECONCILED_OUTPUT' && e.details.detail.script === shared.output.toString('hex'));
    });

    it('REJECTS change to an unsigned P2SH 1-of-2 input script', function () {
        const wallet = ECPair.makeRandom({ network: NET });
        const shared = sharedKeyScript(wallet, bitcoin.payments.p2sh);
        const hex = psbtWithSharedInput(wallet, shared, false).toHex();
        assert.throws(() => reconcileEncoded(hex, { network: NET, callerIdentities: idOf(wallet) }),
                      (e) => e.code === 'UNRECONCILED_OUTPUT' && e.details.detail.script === shared.output.toString('hex'));
    });

    it('still authorizes change to the caller\'s own script beside a shared-key input', function () {
        const wallet = ECPair.makeRandom({ network: NET });
        const own = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(wallet.publicKey), network: NET });
        const hex = psbtWithSharedInput(wallet, sharedKeyScript(wallet, bitcoin.payments.p2wsh), true, own.output).toHex();
        assert.strictEqual(reconcileEncoded(hex, { network: NET, callerIdentities: idOf(wallet) }).fee, 2000n);
    });

    it('authorizes change back to a p2sh-p2wpkh funding input for a raw-pubkey or address identity', function () {
        const wallet = ECPair.makeRandom({ network: NET });
        const nested = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(wallet.publicKey), network: NET }), network: NET });
        const psbt = new bitcoin.Psbt({ network: NET });
        psbt.addInput({ hash: 'cc'.repeat(32), index: 0, witnessUtxo: { script: nested.output, value: 100000 },
            redeemScript: nested.redeem.output });
        psbt.addOutput(carrier);
        psbt.addOutput({ script: nested.output, value: 99000 });
        for (const id of [idOf(wallet), nested.address])
            assert.strictEqual(reconcileEncoded(psbt.toHex(), { network: NET, callerIdentities: id }).fee, 1000n);
    });
});
