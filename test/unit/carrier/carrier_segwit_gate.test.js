'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// On a network without segwit the encoder refuses to build a P2WSH chunk carrier
// and the decoder never reads one, so the signing-side carrier check refuses it
// too, whether it is handed the network object or the network name. P2SH stays a
// legal chunk lane on every chain.

const { expect } = require('chai');
require('../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { verifyCarrierScripts, REASONS } = require('../../../src/carrier/verify_carrier_scripts.js');
const { assertCarrierBinding } = require('../../../src/carrier/bind_action_carrier.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

const BTC = bitcoin.networks.bitcoin;
const DOGE = getNetwork('dogecoin-regtest');
const H160 = Buffer.alloc(20, 0xab);
const ACTION = 'SEND|0|TOK|1|1RecipientAAAAAAAAAAAAAAAAAAAAAAAA|m';

function redeemFor(chunk) {
    return bitcoin.script.compile([chunk, bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160, H160, bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG]);
}

// The committed output scripts are bare hash pushes, identical on every network.
function chunkLane(encoding) {
    const data = bitcoin.script.compile([Buffer.from(ACTION, 'utf8')]);
    const redeems = [];
    for (let i = 0; i < data.length; i += 20) redeems.push(redeemFor(data.subarray(i, i + 20)));
    const psbt = new bitcoin.Psbt({ network: BTC });
    const own = bitcoin.payments.p2pkh({ hash: H160, network: BTC }).output;
    psbt.addInput({ hash: Buffer.alloc(32, 9), index: 0, witnessUtxo: { script: own, value: 100000000 } });
    for (const r of redeems) {
        const script = encoding === 'P2SH'
            ? bitcoin.payments.p2sh({ redeem: { output: r }, network: BTC }).output
            : bitcoin.payments.p2wsh({ redeem: { output: r }, network: BTC }).output;
        psbt.addOutput({ script, value: 1000000 });
    }
    psbt.addOutput({ script: own, value: 50000000 });
    return { psbt, carrierScripts: redeems.map(r => r.toString('hex')) };
}

function verify(encoding, network, overrides) {
    const { psbt, carrierScripts } = chunkLane(encoding);
    return verifyCarrierScripts(Object.assign({ psbt, carrierScripts, encoding, actionString: ACTION, network }, overrides));
}

describe('carrier-script verification on a network without segwit', function () {

    it('refuses a committed, correct P2WSH carrier on DOGE', function () {
        const r = verify('P2WSH', DOGE);
        expect(r).to.deep.equal({ ok: false, reason: REASONS.SEGWIT_UNSUPPORTED, checked: 0 });
    });

    it('refuses it when the DOGE network arrives as a name', function () {
        expect(verify('P2WSH', 'dogecoin-regtest').reason).to.equal(REASONS.SEGWIT_UNSUPPORTED);
        expect(verify('p2wsh', 'dogecoin-mainnet').reason).to.equal(REASONS.SEGWIT_UNSUPPORTED);
    });

    it('names the segwit refusal ahead of missing scripts', function () {
        expect(verify('P2WSH', DOGE, { carrierScripts: [] }).reason).to.equal(REASONS.SEGWIT_UNSUPPORTED);
    });

    it('still accepts a committed, correct P2SH carrier on DOGE', function () {
        expect(verify('P2SH', DOGE).ok).to.equal(true);
        expect(verify('P2SH', 'dogecoin-regtest').ok).to.equal(true);
    });

    it('still accepts P2WSH on segwit networks, by object, by name and by default', function () {
        expect(verify('P2WSH', BTC).ok).to.equal(true);
        expect(verify('P2WSH', getNetwork('litecoin-regtest')).ok).to.equal(true);
        expect(verify('P2WSH', 'litecoin-regtest').ok).to.equal(true);
        expect(verify('P2WSH', undefined).ok).to.equal(true);
        expect(verify('P2WSH', 'not-a-network').ok).to.equal(true);
    });
});

describe('carrier binding on a network without segwit', function () {

    function bind(encoding, network) {
        const { psbt, carrierScripts } = chunkLane(encoding);
        return () => assertCarrierBinding({ psbt, carrierScripts, actionString: ACTION, encoding, network, label: 'transaction' });
    }

    it('refuses a DOGE P2WSH carrier as a mismatch naming the segwit reason', function () {
        let err = null;
        try { bind('P2WSH', DOGE)(); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('CARRIER_ACTION_MISMATCH');
        expect(err.details.reason).to.equal('SEGWIT_UNSUPPORTED');
    });

    it('passes a matching DOGE P2SH carrier', function () {
        expect(bind('P2SH', DOGE)).to.not.throw();
    });
});
