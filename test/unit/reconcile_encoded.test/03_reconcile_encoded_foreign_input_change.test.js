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
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { reconcileEncoded } = require('../../../src/carrier/reconcile_encoded.js');
require('../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;

function payTo() {
    const pubkey = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
    const p = bitcoin.payments.p2wpkh({ pubkey, network: NET });
    return { script: p.output, address: p.address };
}

const carrier = (value) => ({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value });

// ---------------------------------------------------------------------------
// An input is not proof the signer owns it.
//
// Rule (b) read "the destination is also an input" as "the destination stays
// under the signer's control". That holds only for inputs the WIF owns. The
// encoder's answer is UNSIGNED, so an input already carrying a signature was
// contributed by somebody else - and it HAS to be pre-signed to be there, since
// the default lifecycle signs and finalizes every input and would otherwise fail
// finalization. A hostile encoder therefore attached its own pre-signed input,
// pointed the wallet-funded remainder at that input's script, and rule (b) waved
// the drain through as change.
// ---------------------------------------------------------------------------

const ECPairFactory = require('ecpair').default || require('ecpair').ECPairFactory;
const ECPair = ECPairFactory(ecc);

// A wallet-funded PSBT that also carries one FOREIGN input, signed by a key that
// is not the wallet's, exactly as a hostile encoder would return it.
function psbtWithForeignInput(funding, outputs, foreignValue) {
    const foreignKey = ECPair.makeRandom({ network: NET });
    const foreign = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(foreignKey.publicKey), network: NET });
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: funding.script, value: 100000 } });
    psbt.addInput({ hash: 'ee'.repeat(32), index: 0, witnessUtxo: { script: foreign.output, value: foreignValue } });
    for (const out of outputs(foreign)) psbt.addOutput(out);
    psbt.signInput(1, foreignKey);                                // the attacker signs its OWN input
    return { hex: psbt.toHex(), foreign };
}

describe('reconcileEncoded foreign-input change', function () {
    it('REJECTS the drain: wallet value sent to a PRE-SIGNED foreign input\'s script', function () {
        const funding = payTo();
        const { hex, foreign } = psbtWithForeignInput(
            funding, (f) => [carrier(0), { script: f.output, value: 99000 }], 1000);
        assert.throws(() => reconcileEncoded(hex, { network: NET }),
                      (e) => e.code === 'UNRECONCILED_OUTPUT'
                          && e.details.detail.script === foreign.output.toString('hex'));
    });

    it('still authorizes change back to an UNSIGNED input script, with a foreign input present', function () {
        // The foreign input funds and is spent; it just cannot authorize a destination.
        const funding = payTo();
        const { hex } = psbtWithForeignInput(
            funding, () => [carrier(0), { script: funding.script, value: 99000 }], 1000);
        assert.strictEqual(reconcileEncoded(hex, { network: NET }).fee, 2000n);
    });

    it('a foreign input the caller ALSO submitted as change is still authorized', function () {
        // The pin is on how the destination was proven, not on who else spends it:
        // a script the caller named itself stays authorized by rule (b)'s siblings.
        const funding = payTo();
        const { hex, foreign } = psbtWithForeignInput(
            funding, (f) => [carrier(0), { script: f.output, value: 99000 }], 1000);
        assert.strictEqual(reconcileEncoded(hex, { network: NET, changeAddresses: foreign.address }).fee, 2000n);
    });

    it('denies a PSBT whose every input is already signed, with its own reason', function () {
        const foreignKey = ECPair.makeRandom({ network: NET });
        const foreign = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(foreignKey.publicKey), network: NET });
        const psbt = new bitcoin.Psbt({ network: NET });
        psbt.addInput({ hash: 'ee'.repeat(32), index: 0, witnessUtxo: { script: foreign.output, value: 100000 } });
        psbt.addOutput({ script: foreign.output, value: 99000 });
        psbt.signInput(0, foreignKey);
        assert.throws(() => reconcileEncoded(psbt.toHex(), { network: NET }),
                      (e) => e.code === 'NO_SIGNER_OWNED_INPUT');
    });
});
