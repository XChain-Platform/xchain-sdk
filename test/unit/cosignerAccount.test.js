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
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2 = require('../../src/musig2.js');
const CoSigner = require('../../src/cosigner/coSigner.js');
const { deriveMuSig2P2TR } = require('../../src/cosigner/account.js');

const h2b = (h) => Buffer.from(h, 'hex');

describe('cosigner/account deriveMuSig2P2TR', function () {

    it('uses the aggregate key directly as the Taproot output key (no tweak)', function () {
        const keys = [
            secp256k1.getPublicKey(crypto.randomBytes(32), true),
            secp256k1.getPublicKey(crypto.randomBytes(32), true),
        ];
        const acct = deriveMuSig2P2TR(keys);
        expect(acct.tweaks).to.deep.equal([]);
        // scriptPubKey is OP_1 <32-byte aggregate>; the embedded key == the aggregate.
        expect(acct.output.subarray(2).toString('hex')).to.equal(acct.aggregateXOnly.toString('hex'));
        expect(acct.address).to.be.a('string').and.match(/^(bc1p|tb1p|bcrt1p)/);
    });

    it('matches the wallet taproot-musig2 derivation (p2tr({pubkey: aggXOnly}))', function () {
        const keys = [
            secp256k1.getPublicKey(crypto.randomBytes(32), true),
            secp256k1.getPublicKey(crypto.randomBytes(32), true),
        ];
        const acct = deriveMuSig2P2TR(keys);
        const aggXOnly = Buffer.from(new MuSig2().aggregateKeys(keys).xOnlyPubkey);
        const walletStyle = bitcoin.payments.p2tr({ pubkey: aggXOnly });
        expect(acct.address).to.equal(walletStyle.address);
    });

    it('the co-signer + agent produce a VALID key-path spending signature for the derived address', function () {
        // End-to-end proof that the no-tweak scheme is on-chain spendable: the
        // aggregate signature verifies under the exact key in the address output.
        const agentSk = crypto.randomBytes(32), coSk = crypto.randomBytes(32);
        const agentPk = secp256k1.getPublicKey(agentSk, true), coPk = secp256k1.getPublicKey(coSk, true);
        const keys = [agentPk, coPk];
        const acct = deriveMuSig2P2TR(keys);

        // Build a PSBT spending the derived P2TR output, carrying an in-policy SEND.
        const prevHash = crypto.randomBytes(32);
        const txid = Buffer.from(prevHash).reverse().toString('hex');
        const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
        const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
        const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.output, value: 100000 } });
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
        psbt.addOutput({ address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', value: 90000 });

        const agentMusig = new MuSig2();
        const agentNonce = agentMusig.generateNonce({ publicKey: agentPk, secretKey: agentSk });

        const co = new CoSigner({ secretKey: coSk, publicKeys: keys, tweaks: acct.tweaks,
            policy: { allowedActions: new Set(['SEND']) } });
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
        expect(res.approved).to.equal(true);

        const msg = h2b(res.msg);
        const aggNonce = agentMusig.aggregateNonces([agentNonce, h2b(res.publicNonce)]);
        const session  = agentMusig.startSession(aggNonce, msg, keys, acct.tweaks);
        const agentSig = agentMusig.partialSign({ secretKey: agentSk, publicNonce: agentNonce, sessionKey: session });
        const finalSig = agentMusig.aggregateSignatures([agentSig, h2b(res.sig)], session);

        // The output key embedded in the address == the key the signature verifies under.
        expect(schnorr.verify(finalSig, msg, acct.aggregateXOnly)).to.equal(true);
    });
});
