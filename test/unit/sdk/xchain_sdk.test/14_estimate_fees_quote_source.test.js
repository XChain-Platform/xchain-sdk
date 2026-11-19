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
// estimateFees quotes the native-coin fee for the sender submitAction would
// use for the same options: funding address, then change, then pubkey.

'use strict';

const { expect } = require('chai');
const sinon   = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const crypto  = require('crypto');
const XChainSDK = require('../../../../src/XChainSDK.js');

bitcoin.initEccLib(ecc);
const NET = bitcoin.networks.regtest;
const OWN = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xab), network: NET }).output;
const FEE_ADDRESS = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0x02), network: NET }).address;
const SEND = { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' } };

const CASES = [
    [{ pubkey: 'pk', sourceAddress: 'funding', change: 'change-addr' }, 'funding'],
    [{ pubkey: 'pk', sourceAddress: 'funding' }, 'funding'],
    [{ pubkey: 'pk', change: 'change-addr' }, 'change-addr'],
    [{ pubkey: 'pk' }, 'pk'],
    [{ pubkey: 'pk', source: 'ignored', change: 'change-addr' }, 'change-addr'],
];

function plainPsbt() {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt.toHex();
}

describe('XChainSDK estimateFees native-coin fee quote source', function () {
    afterEach(function () { sinon.restore(); });

    it('quotes the native fee for the same source submitAction would use', async function () {
        for (const [opts, expected] of CASES) {
            const sdk = new XChainSDK({ network: 'bitcoin-regtest', explorerUrl: 'http://localhost:8080',
                encoderUrl: 'http://localhost:3000', retry: false });
            sinon.stub(sdk.encoder, 'estimateFee').resolves({ psbt: plainPsbt(), encoding: 'OP_RETURN' });
            const quote = sinon.stub(sdk, 'quoteNativeFee').resolves({ supported: true, valid: true,
                requiredFeeSats: 500, requiredFeeSatsExact: '500', feeDestination: FEE_ADDRESS });
            await sdk.estimateFees(SEND, Object.assign({ payFeeInNativeCoin: true }, opts));
            expect(quote.firstCall.args[1].source, JSON.stringify(opts)).to.equal(expected);
            sinon.restore();
        }
    });
});
