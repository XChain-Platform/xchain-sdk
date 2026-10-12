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

const { expect } = require('chai');
const sinon   = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const crypto  = require('crypto');
const XChainSDK = require('../../../../src/XChainSDK.js');
const EncoderClient = require('../../../../src/clients/encoder.js');

bitcoin.initEccLib(ecc);
const NET = bitcoin.networks.regtest;
const H160 = Buffer.alloc(20, 0xab);
const OWN = bitcoin.payments.p2wpkh({ hash: H160, network: NET }).output;
const SEND = { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } };

function makeSDK() {
    return new XChainSDK({
        network: 'bitcoin-regtest', explorerUrl: 'http://localhost:8080',
        encoderUrl: 'http://localhost:3000', retry: false,
    });
}

function addressFor(byte) {
    return bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, byte), network: NET }).address;
}

// One funding input, a zero-value carrier and change back to the funding script.
function plainPsbt(extraOutputs = []) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
    for (const out of extraOutputs) psbt.addOutput(out);
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt.toHex();
}

// A P2WSH chunk transaction mirroring the encoder's redeem-script shape.
function chunkLane(actionString, rawBuf) {
    const data = bitcoin.script.compile([Buffer.from(actionString, 'utf8'), rawBuf]);
    const redeems = [];
    for (let i = 0; i < data.length; i += 40) {
        redeems.push(bitcoin.script.compile([data.subarray(i, i + 40), bitcoin.opcodes.OP_DROP,
            bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160, H160, bitcoin.opcodes.OP_EQUALVERIFY,
            bitcoin.opcodes.OP_CHECKSIG]));
    }
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    for (const r of redeems)
        psbt.addOutput({ script: bitcoin.payments.p2wsh({ redeem: { output: r }, network: NET }).output, value: 1000 });
    psbt.addOutput({ script: OWN, value: 80000 });
    return { psbt: psbt.toHex(), encoding: 'P2WSH', carrierScripts: redeems.map((r) => r.toString('hex')) };
}

describe('XChainSDK', function () {
    afterEach(function () { sinon.restore(); });

    describe('estimateFees: the request matches the one submitAction sends', function () {

        it('forwards every shared createTx option except the AUTO capability hint', async function () {
            const sdk = makeSDK();
            const estimate = sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt: plainPsbt(), encoding: 'OP_RETURN' });
            const opts = { pubkey: 'mypub' };
            const expected = {};
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS) {
                if (key === 'customOutputs' || key === 'options') continue;
                opts[key] = expected[key] = 'set-' + key;
            }
            opts.options = { signerSupportsTapscript: true };
            await sdk.estimateFees(SEND, opts);
            const sent = estimate.firstCall.args[0];
            for (const key of Object.keys(expected))
                expect(sent[key], key + ' must reach the encoder').to.equal(expected[key]);
            expect(Object.prototype.hasOwnProperty.call(sent, 'options'), 'options stays out of an estimate').to.equal(false);
            expect(sent.pubkey).to.equal('mypub');
            expect(sent.data).to.match(/^SEND\|/);
        });

        it('leaves unset options absent rather than sending them as undefined', async function () {
            const sdk = makeSDK();
            const estimate = sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt: plainPsbt(), encoding: 'OP_RETURN' });
            await sdk.estimateFees(SEND, { pubkey: 'mypub' });
            const sent = estimate.firstCall.args[0];
            for (const key of ['compress', 'feeQuote', 'rawData', 'sourceAddress', 'attachPrevTx'])
                expect(Object.prototype.hasOwnProperty.call(sent, key), key).to.equal(false);
        });

        it('keeps the native-fee output when the caller also passes customOutputs', async function () {
            const sdk = makeSDK();
            const estimate = sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt: plainPsbt(), encoding: 'OP_RETURN' });
            sinon.stub(sdk, 'quoteNativeFee').resolves({ supported: true, valid: true, requiredFeeSats: 500, feeDestination: addressFor(0x02) });
            await sdk.estimateFees(SEND, {
                pubkey: 'mypub', payFeeInNativeCoin: true,
                customOutputs: [{ address: addressFor(0x01), value: 600 }],
            });
            expect(estimate.firstCall.args[0].customOutputs).to.deep.equal([
                { address: addressFor(0x01), value: 600 },
                { address: addressFor(0x02), value: 500 },
            ]);
        });
    });
});

describe('XChainSDK', function () {
    afterEach(function () { sinon.restore(); });

    describe('estimateFees: chunked carriers and the reconcile gate', function () {

        it('binds a chunked FILE carrier to the rawData the caller sent', async function () {
            const sdk = makeSDK();
            const file = { action: 'FILE', params: { name: 'report.bin', type: 1 } };
            const actionString = sdk.actions.createAction(file).actionString;
            const bytes = Buffer.from('report row,'.repeat(40), 'utf8');
            const estimate = sinon.stub(sdk.encoder, 'estimateFee').resolves(chunkLane(actionString, bytes));
            const result = await sdk.estimateFees(file, { pubkey: 'mypub', rawData: bytes.toString('binary') });
            expect(estimate.firstCall.args[0].rawData).to.equal(bytes.toString('binary'));
            expect(result.psbt).to.be.a('string');
        });

        it('refuses a chunked FILE carrier whose rawData push was substituted', async function () {
            const sdk = makeSDK();
            const file = { action: 'FILE', params: { name: 'report.bin', type: 1 } };
            const actionString = sdk.actions.createAction(file).actionString;
            const bytes = Buffer.from('report row,'.repeat(40), 'utf8');
            const swapped = Buffer.from(bytes); swapped[3] ^= 0x20;
            sinon.stub(sdk.encoder, 'estimateFee').resolves(chunkLane(actionString, swapped));
            let err = null;
            try { await sdk.estimateFees(file, { pubkey: 'mypub', rawData: bytes.toString('binary') }); }
            catch (e) { err = e; }
            expect(err, 'a substituted payload must fail closed').to.be.ok;
            expect(err.code).to.equal('CARRIER_ACTION_MISMATCH');
        });

        it('fails closed on a feeQuote output the reconcile gate cannot authorize', async function () {
            const sdk = makeSDK();
            const feeQuote = { address: addressFor(0x03), amount: 700 };
            const feeScript = bitcoin.address.toOutputScript(feeQuote.address, NET);
            const estimate = sinon.stub(sdk.encoder, 'estimateFee')
                .resolves({ psbt: plainPsbt([{ script: feeScript, value: 700 }]), encoding: 'OP_RETURN' });
            let err = null;
            try { await sdk.estimateFees(SEND, { pubkey: 'mypub', feeQuote }); }
            catch (e) { err = e; }
            expect(estimate.firstCall.args[0].feeQuote).to.deep.equal(feeQuote);
            expect(err, 'no signable PSBT may come back for a protocol fee nothing reconciles').to.be.ok;
            expect(err.code).to.equal('UNRECONCILED_OUTPUT');
        });
    });
});
