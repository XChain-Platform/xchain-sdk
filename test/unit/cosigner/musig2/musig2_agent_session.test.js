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
// The MuSig2-backed agent submit path. Covers the signer adapter
// (single- and multi-input key-path spends, every input signed in one round) and MuSig2AgentSession
// wiring (aggregate spending account, local policy pre-flight, co-signer as the
// authoritative gate). The encoder + broadcast are mocked; everything from the
// PSBT through the co-signer round to the finalized witness is real.

'use strict';

const { expect } = require('chai');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');

const CoSigner = require('../../../../src/cosigner/co_signer.js');
const CoSignerClient = require('../../../../src/cosigner/client.js');
const { inProcessTransport } = CoSignerClient;
const { deriveMuSig2P2TR } = require('../../../../src/cosigner/account.js');
const { buildMuSig2Signer } = require('../../../../src/cosigner/musig2_signer.js');
const { SDKPolicyError } = require('../../../../src/utils/errors.js');

const DEST = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

// An unsigned PSBT spending `inputs` UTXOs of `output`, carrying `actionString`
// in an obfuscated OP_RETURN built exactly like the encoder (AES-128-CTR keyed
// by the first input's txid, 'XCHN' magic), with change back to `output`.
function psbtSpending(output, actionString, { value = 100000, inputs = 1, fee = 10000 } = {}) {
    const psbt = new bitcoin.Psbt();
    for (let i = 0; i < inputs; i++)
        psbt.addInput({ hash: crypto.randomBytes(32), index: i, witnessUtxo: { script: output, value } });
    const firstTxid = Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex');
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', firstTxid.substr(0, 16), firstTxid.substr(16, 16));
    const obf    = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: output, value: value - fee });   // change back to the account
    return psbt.toHex();
}

// A 2-of-2 aggregate account plus an unsigned PSBT spending it.
function buildAccountAndPsbt(actionString, opts = {}) {
    const agentSk = crypto.randomBytes(32), coSk = crypto.randomBytes(32);
    const agentPk = Buffer.from(secp256k1.getPublicKey(agentSk, true));
    const coPk    = Buffer.from(secp256k1.getPublicKey(coSk, true));
    const keys    = [agentPk, coPk];
    const acct    = deriveMuSig2P2TR(keys);
    const value   = opts.value || 100000;
    // The action string is kept ON the fixture, not only inside the carrier it
    // builds: the submit path now proves the PSBT carries the action the SDK
    // composed, so a stub that answers a different string is a response no encoder
    // could produce.
    return { agentSk, coSk, agentPk, coPk, keys, acct, value, actionString,
             psbtHex: psbtSpending(acct.output, actionString, Object.assign({ value }, opts)) };
}

// Verify a finalized tx carries one valid key-path Schnorr witness for input 0
// under the aggregate key (the whole point: it spends the derived address).
function expectValidKeyPathSpend(txHex, acct, value) {
    const tx = bitcoin.Transaction.fromHex(txHex);
    expect(tx.ins[0].witness).to.have.length(1);
    const sig = tx.ins[0].witness[0];
    expect(sig).to.have.length(64);
    const sighash = tx.hashForWitnessV1(0, [acct.output], [value], bitcoin.Transaction.SIGHASH_DEFAULT);
    expect(schnorr.verify(sig, sighash, acct.aggregateXOnly)).to.equal(true);
}

describe('MuSig2 signer adapter (buildMuSig2Signer)', function () {

    it('completes a single-input key-path spend via the co-signer', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']) } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });
        const sign = buildMuSig2Signer({ coSignerClient: client, secretKey: s.agentSk });

        const out = await sign(s.psbtHex);
        expect(out.txid).to.be.a('string');
        expectValidKeyPathSpend(out.txHex, s.acct, s.value);
    });

    it('signs every input of a multi-input aggregate spend in one round', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`, { inputs: 3 });
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']) } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });
        const sign = buildMuSig2Signer({ coSignerClient: client, secretKey: s.agentSk });

        const out = await sign(s.psbtHex);
        const tx = bitcoin.Transaction.fromHex(out.txHex);
        expect(tx.ins).to.have.length(3);
        const scripts = tx.ins.map(() => s.acct.output);
        const values  = tx.ins.map(() => s.value);
        for (let i = 0; i < tx.ins.length; i++) {
            expect(tx.ins[i].witness).to.have.length(1);
            const sighash = tx.hashForWitnessV1(i, scripts, values, bitcoin.Transaction.SIGHASH_DEFAULT);
            expect(schnorr.verify(tx.ins[i].witness[0], sighash, s.acct.aggregateXOnly)).to.equal(true);
        }
    });

    it('propagates a co-signer denial as SDKPolicyError (no tx produced)', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|100|${DEST}|m`);
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '50' } } } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });
        const sign = buildMuSig2Signer({ coSignerClient: client, secretKey: s.agentSk });

        let err;
        try { await sign(s.psbtHex); } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKPolicyError);
        expect(err.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('rejects bad construction', function () {
        expect(() => buildMuSig2Signer({ secretKey: Buffer.alloc(32) })).to.throw(/CoSignerClient/);
        expect(() => buildMuSig2Signer({ coSignerClient: { sign() {} } })).to.throw(/secretKey/);
    });
});

describe('MuSig2 signer adapter (buildMuSig2Signer)', function () {
    // Drop-in parity with wallet.signPsbt: non-bitcoin networks get the raised
    // absurd-fee ceiling before extractTransaction (bitcoinjs's 5000 sat/vB
    // default is calibrated for BTC unit value), bitcoin keeps the default,
    // and an explicit maximumFeeRate wins.
    describe('extraction fee ceiling (signPsbt parity)', function () {
        // Not-bitcoin bech32 HRP; only shape matters (no address parsing here).
        const LTC = { messagePrefix: 'Litecoin Signed Message:\n', bech32: 'ltc',
            bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

        // ~66k sat/vB: over bitcoinjs's 5000 default, under the raised 1e7 ceiling.
        const HIGH_FEE = { value: 10000000, fee: 9990000 };

        function makeSigner(s, extra = {}) {
            const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
                policy: { allowedActions: new Set(['SEND']) } });
            const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });
            return buildMuSig2Signer(Object.assign({ coSignerClient: client, secretKey: s.agentSk }, extra));
        }

        it('extracts a high-fee spend on a non-bitcoin network (raised ceiling)', async function () {
            const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`, HIGH_FEE);
            const out = await makeSigner(s, { network: LTC })(s.psbtHex);
            expectValidKeyPathSpend(out.txHex, s.acct, s.value);
        });

        it('keeps bitcoinjs\'s absurd-fee default when no network is given (bitcoin)', async function () {
            const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`, HIGH_FEE);
            let err;
            try { await makeSigner(s)(s.psbtHex); } catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.match(/paying around/i);
        });

        it('honors an explicit maximumFeeRate override', async function () {
            const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`, HIGH_FEE);
            // Raised explicitly on bitcoin: extraction succeeds.
            const out = await makeSigner(s, { maximumFeeRate: 10000000 })(s.psbtHex);
            expectValidKeyPathSpend(out.txHex, s.acct, s.value);
            // Lowered explicitly on a non-bitcoin network: extraction throws.
            const s2 = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`, HIGH_FEE);
            let err;
            try { await makeSigner(s2, { network: LTC, maximumFeeRate: 1000 })(s2.psbtHex); } catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.match(/paying around/i);
        });
    });
});
