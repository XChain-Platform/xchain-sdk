// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The pre-sign reconcile gate must honor maxFeeSats and maxPhaseFundingSats from
// the encoder options (the slot estimateFees and the message path read) as well
// as from the submit options, so a caller's ceiling never fails open.

const assert  = require('assert');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { reconcileTransaction } = require('../../../src/carrier/lifecycle_manager/submission_setup.js');
require('../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);
const NET = bitcoin.networks.regtest;
const manager = { reconcileNetwork: () => NET };

function payTo() {
    const pubkey = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
    const p = bitcoin.payments.p2wpkh({ pubkey, network: NET });
    return { script: p.output, address: p.address };
}
const carrier = () => ({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
const leg = () => bitcoin.payments.p2wsh({ hash: crypto.randomBytes(32), network: NET }).output;

function psbtHex(funding, outputs) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: funding.script, value: 100000 } });
    outputs.forEach((o) => psbt.addOutput(o));
    return psbt.toHex();
}

// Fixture A: a 546 sat fee. Fixture B: a P2WSH commit with 3 legs totalling 2184 sats.
function feeFixture() {
    const f = payTo();
    return { encoded: { psbt: psbtHex(f, [carrier(), { script: f.script, value: 100000 - 546 }]), encoding: 'P2PKH' }, f };
}
function legFixture() {
    const f = payTo();
    const outs = [{ script: leg(), value: 1092 }, { script: leg(), value: 546 }, { script: leg(), value: 546 },
                  { script: f.script, value: 100000 - 2184 - 300 }];
    return { encoded: { psbt: psbtHex(f, outs), encoding: 'P2WSH' }, f };
}

// Run the gate; the carrier-binding step after reconcile needs a real action
// string, so only the reconcile verdict is of interest.
function run(fx, encoderOpts, opts) {
    try {
        reconcileTransaction(manager, fx.encoded, { actionString: 'x' },
            Object.assign({ pubkey: fx.f.address, change: fx.f.address }, encoderOpts), opts || {});
        return null;
    } catch (e) { return e; }
}
const CAPS = ['FEE_OVER_CAP', 'PHASE_FUNDING_OVER_CAP'];

describe('reconcileTransaction caps in encoder options', function () {
    it('encoderOpts.maxFeeSats refuses an over-cap fee before signing', function () {
        const e = run(feeFixture(), { maxFeeSats: 273 });
        assert.ok(e, 'must refuse');
        assert.strictEqual(e.code, 'FEE_OVER_CAP');
        assert.ok(JSON.stringify(e.details || e.message).includes('273'));
    });

    it('encoderOpts.maxPhaseFundingSats refuses over-cap phase funding', function () {
        const e = run(legFixture(), { maxPhaseFundingSats: 1 });
        assert.ok(e, 'must refuse');
        assert.strictEqual(e.code, 'PHASE_FUNDING_OVER_CAP');
    });

    it('submit options win when both slots are set', function () {
        assert.strictEqual(run(feeFixture(), { maxFeeSats: 1000000 }, { maxFeeSats: 273 }).code, 'FEE_OVER_CAP');
        const e = run(feeFixture(), { maxFeeSats: 273 }, { maxFeeSats: 1000000 });
        assert.ok(!e || !CAPS.includes(e.code), 'a loose submit cap overrides the tight encoder cap');
    });

    it('caps in submit options only still refuse (control)', function () {
        assert.strictEqual(run(feeFixture(), {}, { maxFeeSats: 273 }).code, 'FEE_OVER_CAP');
        assert.strictEqual(run(legFixture(), {}, { maxPhaseFundingSats: 1 }).code, 'PHASE_FUNDING_OVER_CAP');
    });

    it('no caps anywhere: the same fixtures pass the cap checks', function () {
        for (const fx of [feeFixture(), legFixture()]) {
            const e = run(fx, {});
            assert.ok(!e || !CAPS.includes(e.code), 'unexpected ' + (e && e.code));
        }
    });
});
