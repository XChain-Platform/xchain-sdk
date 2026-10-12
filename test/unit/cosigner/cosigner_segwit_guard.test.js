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
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1 } = require('@noble/curves/secp256k1');
const CoSigner = require('../../../src/cosigner/co_signer.js');
const { deriveMuSig2P2TR, deriveMuSig2P2TR2of3 } = require('../../../src/cosigner/account.js');
const { deriveEnvelopeCommit } = require('../../../src/cosigner/envelope.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

const DOGE = getNetwork('dogecoin-regtest');
// A hand-rolled Dogecoin network in plain bitcoinjs shape: no supportsSegwit, no bech32.
const BARE_DOGE = { messagePrefix: '\x19Dogecoin Signed Message:\n',
    bip32: { public: 0x02facafd, private: 0x02fac398 }, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e };
const BTC = getNetwork('bitcoin-regtest');

function keyPair() {
    const sk = crypto.randomBytes(32);
    return { sk, pk: secp256k1.getPublicKey(sk, true) };
}

function refusedWithCode(fn) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    expect(err, 'expected a SEGWIT_NOT_SUPPORTED refusal').to.not.equal(null);
    expect(err.code).to.equal('SEGWIT_NOT_SUPPORTED');
}

function coSignerConfig(network, recovery) {
    const agent = keyPair(), daemon = keyPair();
    return { secretKey: daemon.sk, publicKeys: [agent.pk, daemon.pk], network,
        recoveryPublicKey: recovery ? keyPair().pk : undefined,
        policy: { allowedActions: new Set(['SEND']) } };
}

describe('cosigner witness-v1 derivation refuses a network without segwit', function () {

    it('the SDK dogecoin network really is marked non-segwit with no bech32 prefix', function () {
        expect(DOGE.supportsSegwit).to.equal(false);
        expect(DOGE.bech32).to.equal(undefined);
    });

    it('deriveMuSig2P2TR refuses DOGE and still derives on BTC regtest and native bitcoinjs networks', function () {
        const keys = [keyPair().pk, keyPair().pk];
        refusedWithCode(() => deriveMuSig2P2TR(keys, DOGE));
        refusedWithCode(() => deriveMuSig2P2TR(keys, BARE_DOGE));
        expect(deriveMuSig2P2TR(keys, BTC).address).to.match(/^bcrt1p/);
        expect(deriveMuSig2P2TR(keys, bitcoin.networks.testnet).address).to.match(/^tb1p/);
        expect(deriveMuSig2P2TR(keys).address).to.match(/^bc1p/);
    });

    it('deriveMuSig2P2TR2of3 refuses DOGE and still derives on BTC regtest', function () {
        const parties = { agent: keyPair().pk, daemon: keyPair().pk, recovery: keyPair().pk };
        refusedWithCode(() => deriveMuSig2P2TR2of3(parties, DOGE));
        refusedWithCode(() => deriveMuSig2P2TR2of3(parties, BARE_DOGE));
        expect(deriveMuSig2P2TR2of3(parties, BTC).address).to.match(/^bcrt1p/);
    });

    it('a 2-of-2 CoSigner on DOGE refuses at construction instead of adopting an OP_1 account script', function () {
        refusedWithCode(() => new CoSigner(coSignerConfig(DOGE, false)));
        refusedWithCode(() => new CoSigner(coSignerConfig(BARE_DOGE, false)));
        const co = new CoSigner(coSignerConfig(BTC, false));
        expect(co.accountScript[0]).to.equal(bitcoin.opcodes.OP_1);
    });

    it('a 2-of-3 CoSigner on DOGE refuses with the code intact, not a rewrapped tap-tree error', function () {
        refusedWithCode(() => new CoSigner(coSignerConfig(DOGE, true)));
        expect(new CoSigner(coSignerConfig(BTC, true)).tapTree).to.not.equal(null);
    });

    it('deriveEnvelopeCommit refuses DOGE before reading its other arguments', function () {
        refusedWithCode(() => deriveEnvelopeCommit({ internalXOnly: null, envelopeScript: null, network: DOGE }));
        // On BTC the guard passes and the next check (the internal key) is what fires.
        expect(() => deriveEnvelopeCommit({ internalXOnly: null, envelopeScript: null, network: BTC }))
            .to.throw(/32-byte x-only internal key/);
    });
});
