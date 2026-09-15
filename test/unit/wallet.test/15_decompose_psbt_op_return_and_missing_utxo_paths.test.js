// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../src/utils/wallet.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

describe('WalletUtils', function() {

    describe('decomposePsbt() - OP_RETURN and missing UTXO paths', function() {
        it('should set address null for OP_RETURN output', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            // OP_RETURN output: cannot be converted to an address
            const opReturnScript = bitcoin.script.compile([
                bitcoin.opcodes.OP_RETURN,
                Buffer.from('58434841494e', 'hex'), // "XCHAIN" in hex
            ]);

            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 100_000);

            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({
                hash:         prevTx.getId(),
                index:        0,
                sequence:     0xfffffffd,
                witnessUtxo:  { script: inputScript, value: 100_000 },
            });
            // Add a real P2WPKH output + an OP_RETURN output
            psbt.addOutput({ script: inputScript, value: 90_000 });
            psbt.addOutput({ script: opReturnScript, value: 0 });

            const decomposed = wallet.decomposePsbt(psbt.toHex());
            expect(decomposed.outputs).to.have.lengthOf(2);
            // OP_RETURN output should have address=null
            const opReturnOut = decomposed.outputs[1];
            expect(opReturnOut.address).to.be.null;
            expect(opReturnOut.scriptType).to.equal('unknown');
        });
    });
});
