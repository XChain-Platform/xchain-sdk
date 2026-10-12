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
const WalletUtils = require('../../../../src/utils/wallet.js');
const { getNetwork } = require('../../../../src/protocol/networks.js');

describe('WalletUtils', function() {

    describe('deriveMultisigAddress()', function() {
        it('should throw without params', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress(null)).to.throw(/params required/);
        });

        it('should throw with empty scriptTemplate', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({ scriptTemplate: '', scheme: 'p2sh-multisig' })).to.throw(/scriptTemplate must be a non-empty string/);
        });

        it('should throw for unknown scheme', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({ scriptTemplate: 'multi:1:03abc', scheme: 'unknown' })).to.throw(/scheme must be one of/);
        });

        it('should derive p2sh-multisig address for 2-of-3', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp1 = wallet.generateKeyPair();
            const kp2 = wallet.generateKeyPair();
            const kp3 = wallet.generateKeyPair();
            const template = `multi:2:${kp1.publicKeyHex}:${kp2.publicKeyHex}:${kp3.publicKeyHex}`;
            const result = wallet.deriveMultisigAddress({ scriptTemplate: template, scheme: 'p2sh-multisig' });
            expect(result.address).to.be.a('string');
            expect(result.scheme).to.equal('p2sh-multisig');
            expect(result.redeemScript).to.be.a('string');
            expect(result.witnessScript).to.be.null;
            expect(result.outputPubkey).to.be.null;
        });

        it('should derive p2wsh-multisig address for 1-of-2', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp1 = wallet.generateKeyPair();
            const kp2 = wallet.generateKeyPair();
            const template = `multi:1:${kp1.publicKeyHex}:${kp2.publicKeyHex}`;
            const result = wallet.deriveMultisigAddress({ scriptTemplate: template, scheme: 'p2wsh-multisig' });
            expect(result.address).to.be.a('string').that.matches(/^bcrt1q/);
            expect(result.scheme).to.equal('p2wsh-multisig');
            expect(result.witnessScript).to.be.a('string');
            expect(result.redeemScript).to.be.null;
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for bad multi: format', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: 'bad:format', scheme: 'p2sh-multisig'
            })).to.throw(/scriptTemplate must look like/);
        });
    });
});

describe('WalletUtils', function() {

    describe('deriveMultisigAddress()', function() {
        it('should throw INVALID_SCRIPT_TEMPLATE when threshold > cosigner count', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `multi:3:${kp.publicKeyHex}:${kp.publicKeyHex}`,
                scheme: 'p2sh-multisig'
            })).to.throw(/threshold .* exceeds cosigner/);
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for non-integer threshold', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            // Need 4+ parts: multi:<threshold>:<pk1>:<pk2>
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `multi:abc:${kp.publicKeyHex}:${kp.publicKeyHex}`,
                scheme: 'p2sh-multisig'
            })).to.throw(/threshold .* must be a positive integer/);
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for uncompressed pubkey in multisig template', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // 65-byte (130 hex chars) uncompressed pubkey; need at least 4 parts
            const validKp = wallet.generateKeyPair();
            const badPubkey = '04' + 'ab'.repeat(64);
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `multi:1:${badPubkey}:${validKp.publicKeyHex}`,
                scheme: 'p2sh-multisig'
            })).to.throw(/must be 33 bytes compressed/);
        });

        it('should derive taproot-musig2 address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Derive a valid x-only pubkey by stripping the prefix byte from a
            // compressed secp256k1 public key. This guarantees the x-coordinate
            // is on the curve and P2TR derivation succeeds.
            const kp = wallet.generateKeyPair();
            // compressed pubkey = 33 bytes: [02|03] + x (32 bytes)
            const xonly = kp.publicKey.slice(1).toString('hex'); // 32 bytes → 64 hex chars
            const result = wallet.deriveMultisigAddress({
                scriptTemplate: `musig2:${xonly}`,
                scheme: 'taproot-musig2'
            });
            expect(result.address).to.be.a('string');
            expect(result.scheme).to.equal('taproot-musig2');
            expect(result.outputPubkey).to.equal(xonly.toLowerCase());
            expect(result.redeemScript).to.be.null;
            expect(result.witnessScript).to.be.null;
        });
    });
});

describe('WalletUtils', function() {

    describe('deriveMultisigAddress()', function() {
        it('should throw INVALID_SCRIPT_TEMPLATE for bad musig2 template format', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: 'musig2:notvalidhex!!!',
                scheme: 'taproot-musig2'
            })).to.throw(/taproot-musig2 scriptTemplate must look like/);
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for musig2 with wrong pubkey length', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // 16 bytes: too short
            const shortXOnly = 'deadbeef'.repeat(4);
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `musig2:${shortXOnly}`,
                scheme: 'taproot-musig2'
            })).to.throw(/aggregated x-only pubkey must be 32 bytes/);
        });

        it('should support network override via params.network', function() {
            // No instance network, but pass network via params
            const wallet = new WalletUtils();
            const kp1 = new WalletUtils('bitcoin-regtest').generateKeyPair();
            const kp2 = new WalletUtils('bitcoin-regtest').generateKeyPair();
            const template = `multi:1:${kp1.publicKeyHex}:${kp2.publicKeyHex}`;
            const result = wallet.deriveMultisigAddress({
                scriptTemplate: template,
                scheme: 'p2sh-multisig',
                network: 'bitcoin-regtest'
            });
            expect(result.address).to.be.a('string');
        });
    });
});

// Capture the thrown error so a segwit-gate assertion reads its code, not its message.
function codeOf(fn) {
    try { fn(); } catch (e) { return e.code; }
    return 'no-throw';
}

function multiTemplate(wallet) {
    const kp1 = wallet.generateKeyPair();
    const kp2 = wallet.generateKeyPair();
    return `multi:1:${kp1.publicKeyHex}:${kp2.publicKeyHex}`;
}

function musigTemplate(wallet) {
    return `musig2:${wallet.generateKeyPair().publicKey.slice(1).toString('hex')}`;
}

describe('WalletUtils', function() {

    describe('deriveMultisigAddress() on a network without segwit', function() {
        it('should refuse p2wsh-multisig on dogecoin-regtest with SEGWIT_NOT_SUPPORTED', function() {
            const wallet = new WalletUtils('dogecoin-regtest');
            expect(codeOf(() => wallet.deriveMultisigAddress({
                scriptTemplate: multiTemplate(wallet), scheme: 'p2wsh-multisig',
            }))).to.equal('SEGWIT_NOT_SUPPORTED');
        });

        it('should refuse taproot-musig2 on dogecoin-regtest with SEGWIT_NOT_SUPPORTED', function() {
            const wallet = new WalletUtils('dogecoin-regtest');
            expect(codeOf(() => wallet.deriveMultisigAddress({
                scriptTemplate: musigTemplate(wallet), scheme: 'taproot-musig2',
            }))).to.equal('SEGWIT_NOT_SUPPORTED');
        });

        it('should refuse a dogecoin network override on a bitcoin instance', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(codeOf(() => wallet.deriveMultisigAddress({
                scriptTemplate: multiTemplate(wallet), scheme: 'p2wsh-multisig', network: 'dogecoin-regtest',
            }))).to.equal('SEGWIT_NOT_SUPPORTED');
        });
    });
});

describe('WalletUtils', function() {

    describe('deriveMultisigAddress() on a network without segwit', function() {
        it('should still derive p2sh-multisig on dogecoin-regtest', function() {
            const wallet = new WalletUtils('dogecoin-regtest');
            const result = wallet.deriveMultisigAddress({
                scriptTemplate: multiTemplate(wallet), scheme: 'p2sh-multisig',
            });
            expect(result.address).to.be.a('string');
            expect(result.scheme).to.equal('p2sh-multisig');
        });

        // A bech32 prefix on a non-segwit network must not turn the refusal into an address.
        it('should refuse both witness schemes even when the network carries a bech32 prefix', function() {
            const wallet = new WalletUtils('dogecoin-regtest');
            wallet.resolveNet = () => Object.assign({}, getNetwork('dogecoin-regtest'), { bech32: 'dcrt' });
            expect(codeOf(() => wallet.deriveMultisigAddress({
                scriptTemplate: multiTemplate(wallet), scheme: 'p2wsh-multisig',
            }))).to.equal('SEGWIT_NOT_SUPPORTED');
            expect(codeOf(() => wallet.deriveMultisigAddress({
                scriptTemplate: musigTemplate(wallet), scheme: 'taproot-musig2',
            }))).to.equal('SEGWIT_NOT_SUPPORTED');
        });
    });
});
