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
const { feeQuoteAuthorizedOutput } = require('../../../../src/carrier/reconcile_encoded.js');

bitcoin.initEccLib(ecc);
const NET = bitcoin.networks.regtest;
const OWN = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xab), network: NET }).output;
const SEND = { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } };

const addressFor = (byte) => bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, byte), network: NET }).address;

function psbtPaying(address, value) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
    psbt.addOutput({ script: bitcoin.address.toOutputScript(address, NET), value });
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt.toHex();
}

function makeSDK() {
    return new XChainSDK({ network: 'bitcoin-regtest', explorerUrl: 'http://localhost:8080',
        encoderUrl: 'http://localhost:3000', retry: false });
}

describe('feeQuote authorized output', function () {
    it('helper maps a quote to an address/value pair and rejects malformed quotes', function () {
        expect(feeQuoteAuthorizedOutput({ address: 'a', amount: 700 })).to.deep.equal({ address: 'a', value: 700n });
        expect(feeQuoteAuthorizedOutput(null)).to.equal(null);
        expect(feeQuoteAuthorizedOutput({ amount: 5 })).to.equal(null);
        expect(feeQuoteAuthorizedOutput({ address: 'a', amount: 'x' })).to.equal(null);
    });

    it('estimateFees accepts the quoted output', async function () {
        const sdk = makeSDK();
        const addr = addressFor(0x03);
        sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt: psbtPaying(addr, 700), encoding: 'OP_RETURN' });
        const res = await sdk.estimateFees(SEND, { pubkey: 'mypub', feeQuote: { address: addr, amount: 700 } });
        expect(res.signable).to.equal(true);
    });

    it('refuses an output above the quoted amount', async function () {
        const sdk = makeSDK();
        const addr = addressFor(0x03);
        sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt: psbtPaying(addr, 5000), encoding: 'OP_RETURN' });
        let err = null;
        try { await sdk.estimateFees(SEND, { pubkey: 'mypub', feeQuote: { address: addr, amount: 700 } }); }
        catch (e) { err = e; }
        expect(err && err.code).to.equal('OUTPUT_OVER_REQUESTED_VALUE');
    });

    it('refuses an output to a different address than the quote', async function () {
        const sdk = makeSDK();
        sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt: psbtPaying(addressFor(0x09), 700), encoding: 'OP_RETURN' });
        let err = null;
        try { await sdk.estimateFees(SEND, { pubkey: 'mypub', feeQuote: { address: addressFor(0x03), amount: 700 } }); }
        catch (e) { err = e; }
        expect(err && err.code).to.equal('UNRECONCILED_OUTPUT');
    });
});

// A chunk funding PSBT: one shaped P2SH/P2WSH leg and change, plus the quote output when asked.
function chunkFundingPaying(encoding, quoteAddress, quoteValue) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    const leg = encoding === 'P2SH'
        ? bitcoin.payments.p2sh({ hash: Buffer.alloc(20, 0x5a), network: NET }).output
        : bitcoin.payments.p2wsh({ hash: Buffer.alloc(32, 0x5a), network: NET }).output;
    psbt.addOutput({ script: leg, value: 5000 });
    if (quoteAddress) psbt.addOutput({ script: bitcoin.address.toOutputScript(quoteAddress, NET), value: quoteValue });
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt.toHex();
}

async function estimateError(psbt, encoding, feeQuote) {
    const sdk = makeSDK();
    sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt, encoding });
    try { await sdk.estimateFees(SEND, { pubkey: 'mypub', feeQuote }); }
    catch (e) { return e; }
    return null;
}

// A chunked action is indexed from its reveal, so its phase-1 funding PSBT must never pay the quote.
describe('feeQuote authorized output on a chunked estimate', function () {
    afterEach(() => sinon.restore());

    for (const encoding of ['P2SH', 'P2WSH']) {
        it('refuses the quote output on a ' + encoding + ' funding PSBT, as submitAction does', async function () {
            const addr = addressFor(0x03);
            const err = await estimateError(chunkFundingPaying(encoding, addr, 700), encoding, { address: addr, amount: 700 });
            expect(err && err.code).to.equal('UNRECONCILED_OUTPUT');
        });

        it('lets the same ' + encoding + ' funding PSBT without the quote output past reconcile', async function () {
            const addr = addressFor(0x03);
            const err = await estimateError(chunkFundingPaying(encoding, null), encoding, { address: addr, amount: 700 });
            expect(err && err.code).to.not.equal('UNRECONCILED_OUTPUT');
        });
    }
});
