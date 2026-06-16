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
const { getNetwork, getSupportedNetworks, NETWORKS } = require('../../src/networks.js');

describe('networks', function() {

    describe('getSupportedNetworks()', function() {
        it('should return all 9 supported networks', function() {
            const networks = getSupportedNetworks();
            expect(networks).to.be.an('array').with.lengthOf(9);
            expect(networks).to.include('bitcoin-mainnet');
            expect(networks).to.include('bitcoin-testnet');
            expect(networks).to.include('bitcoin-regtest');
            expect(networks).to.include('litecoin-mainnet');
            expect(networks).to.include('litecoin-testnet');
            expect(networks).to.include('litecoin-regtest');
            expect(networks).to.include('dogecoin-mainnet');
            expect(networks).to.include('dogecoin-testnet');
            expect(networks).to.include('dogecoin-regtest');
        });
    });

    describe('getNetwork()', function() {
        it('should return a network object for each supported network', function() {
            for (const name of getSupportedNetworks()) {
                const net = getNetwork(name);
                expect(net).to.be.an('object');
                expect(net).to.have.property('messagePrefix');
                expect(net).to.have.property('bip32');
                expect(net.bip32).to.have.property('public');
                expect(net.bip32).to.have.property('private');
                expect(net).to.have.property('pubKeyHash');
                expect(net).to.have.property('scriptHash');
                expect(net).to.have.property('wif');
                expect(net).to.have.property('dustThreshold');
            }
        });

        it('should throw on unknown network', function() {
            expect(() => getNetwork('ethereum-mainnet')).to.throw(/Unknown network/);
            expect(() => getNetwork('')).to.throw(/Unknown network/);
            expect(() => getNetwork(null)).to.throw(/Unknown network/);
        });

        it('should return frozen objects', function() {
            const net = getNetwork('bitcoin-mainnet');
            expect(Object.isFrozen(net)).to.be.true;
            expect(Object.isFrozen(net.bip32)).to.be.true;
        });

        it('should have bech32 prefix for bitcoin and litecoin', function() {
            expect(getNetwork('bitcoin-mainnet').bech32).to.equal('bc');
            expect(getNetwork('bitcoin-testnet').bech32).to.equal('tb');
            expect(getNetwork('bitcoin-regtest').bech32).to.equal('bcrt');
            expect(getNetwork('litecoin-mainnet').bech32).to.equal('ltc');
            expect(getNetwork('litecoin-testnet').bech32).to.equal('tltc');
            expect(getNetwork('litecoin-regtest').bech32).to.equal('rltc');
        });

        it('should not have bech32 for dogecoin (no segwit)', function() {
            expect(getNetwork('dogecoin-mainnet')).to.not.have.property('bech32');
            expect(getNetwork('dogecoin-testnet')).to.not.have.property('bech32');
            expect(getNetwork('dogecoin-regtest')).to.not.have.property('bech32');
        });

        it('should mark dogecoin as not supporting segwit', function() {
            expect(getNetwork('dogecoin-mainnet').supportsSegwit).to.be.false;
            expect(getNetwork('dogecoin-testnet').supportsSegwit).to.be.false;
            expect(getNetwork('dogecoin-regtest').supportsSegwit).to.be.false;
        });

        it('should mark bitcoin and litecoin as supporting segwit', function() {
            expect(getNetwork('bitcoin-mainnet').supportsSegwit).to.be.true;
            expect(getNetwork('litecoin-mainnet').supportsSegwit).to.be.true;
        });

        // Verify WIF bytes match known values
        it('should have correct WIF bytes', function() {
            expect(getNetwork('bitcoin-mainnet').wif).to.equal(0x80);
            expect(getNetwork('bitcoin-testnet').wif).to.equal(0xef);
            expect(getNetwork('litecoin-mainnet').wif).to.equal(0xb0);
            expect(getNetwork('dogecoin-mainnet').wif).to.equal(0x9e);
        });
    });
});
