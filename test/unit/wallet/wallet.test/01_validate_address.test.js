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
const ecc = require('@bitcoinerlab/secp256k1');
const WalletUtils = require('../../../../src/utils/wallet.js');
const { getNetwork } = require('../../../../src/protocol/networks.js');

describe('WalletUtils', function() {

    describe('validateAddress()', function() {
        it('should validate a bitcoin regtest P2PKH address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);
            const result = wallet.validateAddress(address);
            expect(result.valid).to.be.true;
            expect(result.type).to.equal('p2pkh');
            expect(result.network).to.equal('bitcoin-regtest');
        });

        it('should validate a bech32 address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });
            const result = wallet.validateAddress(address);
            expect(result.valid).to.be.true;
            expect(result.type).to.equal('p2wpkh');
        });

        it('classifies a Taproot (v1) address as p2tr, not p2wsh', function() {
            bitcoin.initEccLib(ecc);
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const internalPubkey = Buffer.from(kp.publicKey).slice(1, 33); // x-only
            const { address } = bitcoin.payments.p2tr({
                internalPubkey,
                network: getNetwork('bitcoin-regtest')
            });
            const result = wallet.validateAddress(address);
            expect(result.valid).to.be.true;
            expect(result.type).to.equal('p2tr');
        });
    });
});

describe('WalletUtils', function() {

    describe('validateAddress()', function() {
        it('should return valid:false for invalid address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const result = wallet.validateAddress('not-an-address');
            expect(result.valid).to.be.false;
            expect(result.error).to.be.a('string');
        });

        it('should return valid:false for empty input', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(wallet.validateAddress('').valid).to.be.false;
            expect(wallet.validateAddress(null).valid).to.be.false;
        });

        it('should accept network override', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const ltcWallet = new WalletUtils('litecoin-regtest');
            const kp = ltcWallet.generateKeyPair();
            const ltcAddr = ltcWallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });

            // Validate a litecoin address against litecoin network from a bitcoin-configured wallet
            const result = wallet.validateAddress(ltcAddr, 'litecoin-regtest');
            expect(result.valid).to.be.true;
            expect(result.network).to.equal('litecoin-regtest');
        });

        it('should check all networks when none configured', function() {
            const wallet = new WalletUtils();
            const btcWallet = new WalletUtils('bitcoin-regtest');
            const kp = btcWallet.generateKeyPair();
            const address = btcWallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });

            const result = wallet.validateAddress(address);
            expect(result.valid).to.be.true;
            expect(result.network).to.equal('bitcoin-regtest');
        });
    });
});
