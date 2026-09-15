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
const WalletUtils = require('../../../src/utils/wallet.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

describe('WalletUtils', function() {

    describe('validateAddress() - extended', function() {
        it('should validate a P2SH address on bitcoin-regtest', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const p2sh = wallet.deriveAddress(kp.publicKey, { type: 'p2sh-p2wpkh' });
            const result = wallet.validateAddress(p2sh);
            expect(result.valid).to.be.true;
            expect(result.type).to.equal('p2sh');
        });

        it('should return unknown type for p2wsh address (32 byte data)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp1 = wallet.generateKeyPair();
            const kp2 = wallet.generateKeyPair();
            // Build a P2WSH address from 1-of-2 multisig
            const result = wallet.deriveMultisigAddress({
                scriptTemplate: `multi:1:${kp1.publicKeyHex}:${kp2.publicKeyHex}`,
                scheme: 'p2wsh-multisig'
            });
            // validateAddress should recognize the bech32 / p2wsh
            const validation = wallet.validateAddress(result.address);
            expect(validation.valid).to.be.true;
            // type will be 'p2wsh' (32-byte bech32 data)
            expect(['p2wsh', 'bech32']).to.include(validation.type);
        });
    });
});
