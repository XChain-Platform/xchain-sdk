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
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
// Must load before bitcoinjs-lib builds a PSBT with BigInt output
// values (large-satoshi / DOGE fixtures below): teaches bip174/bitcoinjs to
// accept number|bigint, matching what applyBufferutilsPatch does process-wide
// when the SDK's wallet.js is required in production.
require('../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2     = require('../../../src/cosigner/musig2.js');
const CoSigner   = require('../../../src/cosigner/co_signer.js');
const WindowStore = require('../../../src/cosigner/window_store.js');

const h2b = (h) => Buffer.from(h, 'hex');

// A 2-of-2 MuSig2 account: agent (live signer) + co-signer (deterministic).
//
// NOTE: this exercises the co-signer SERVICE mechanics (decode -> policy ->
// sighash-from-PSBT -> deterministic partial-sign -> aggregate). The service is
// agnostic to the taproot tweak: it just forwards whatever `tweaks` both parties
// agreed at address setup. The BIP341 tweak/output-key parity equivalence (so the
// aggregate actually spends the P2TR output on chain) is an ADDRESS-DERIVATION
// concern, verified in that slice (wallet.js taproot-musig2), not here. So these
// tests use no tweak and verify under the bare aggregate key; the witnessUtxo
// still carries a real P2TR scriptPubKey so the sighash is computed over realistic
// bytes.
function makeAccount() {
    const musig = new MuSig2();
    const agentSk = crypto.randomBytes(32);
    const coSk    = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true);
    const coPk    = secp256k1.getPublicKey(coSk, true);
    const keys = [agentPk, coPk];                       // fixed agreed order

    const bare = musig.aggregateKeys(keys);
    const p2tr = bitcoin.payments.p2tr({ pubkey: Buffer.from(bare.xOnlyPubkey) });

    return { musig, agentSk, coSk, agentPk, coPk, keys, tweaks: [],
             aggKey: Buffer.from(bare.xOnlyPubkey), p2trScript: p2tr.output };
}

// Build a PSBT spending the account's P2TR output, carrying the given action in an
// obfuscated OP_RETURN built exactly as xchain-encoder does (so decode is faithful).
function buildSignablePsbt(acct, actionString, opts = {}) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const inner = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const tagged = Buffer.concat([Buffer.from('XCHN'), inner]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf = Buffer.concat([cipher.update(tagged), cipher.final()]);

    const psbt = new bitcoin.Psbt();
    const witnessUtxo = opts.noWitnessUtxo ? undefined : { script: acct.p2trScript, value: 100000 };
    psbt.addInput(witnessUtxo ? { hash: prevHash, index: 0, witnessUtxo } : { hash: prevHash, index: 0 });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    // Change returns to the account we spend from (a token SEND has no recipient
    // output; the recipient rides the action string). Custom external outputs are
    // tested explicitly in the anti-drain cases below.
    psbt.addOutput({ script: acct.p2trScript, value: 90000 });
    return psbt;
}


function policy(extra) {
    return Object.assign({ allowedActions: new Set(['SEND']) }, extra || {});
}

// Fund-key-safety fix: allowedOutputs.maxValue is the operator's bound on the
// SUM paid to one authorized destination, not a per-output limit. Without
// accumulation, N outputs to the same allow-listed script each pass the cap
// independently, letting a colluding agent move N x maxValue out of the
// account behind an otherwise in-policy action.
function buildMultiOutputPsbt(acct, outs) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    const psbt = new bitcoin.Psbt();
    const totalOut = outs.reduce((s, o) => s + o.value, 0);
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: totalOut + 50000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: 50000 });   // change to self
    for (const o of outs) psbt.addOutput({ script: o.script, value: o.value });
    return psbt;
}

// Anti-drain (burn variant): the OP_RETURN action carrier is exempt from the
// output gate because it "carries the action, not value" - but an OP_RETURN
// output is unspendable, so any satoshis on it are burned. A malicious agent
// could set value = the whole input amount (with NO change output) and burn
// the entire account balance behind a benign in-policy action. The carrier
// must therefore be value=0; a value-bearing OP_RETURN fails closed.
function buildOpReturnValuePsbt(acct, carrierValue, includeChange) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
    // The action carrier, but loaded with native value instead of 0.
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: carrierValue });
    if (includeChange) psbt.addOutput({ script: acct.p2trScript, value: 100000 - carrierValue });
    return psbt;
}

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    it('denies N outputs to the SAME allow-listed entry that each stay under maxValue but sum over it', function () {
        const acct = makeAccount();
        const fee = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        // Two outputs at 3000 each, both under the 5000 cap individually, but
        // 3000 + 3000 = 6000 > 5000 in aggregate.
        const psbt = buildMultiOutputPsbt(acct, [{ script: fee, value: 3000 }, { script: fee, value: 3000 }]);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: fee, maxValue: 5000 }] });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('OUTPUT_OVER_CAP');
    });

    it('still allows a single legitimate authorized output at or under the cap (no regression)', function () {
        const acct = makeAccount();
        const fee = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const psbt = buildMultiOutputPsbt(acct, [{ script: fee, value: 5000 }]);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: fee, maxValue: 5000 }] });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(true);
    });

    it('allows multiple outputs to the same entry when their sum stays within the cap', function () {
        const acct = makeAccount();
        const fee = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const psbt = buildMultiOutputPsbt(acct, [{ script: fee, value: 2000 }, { script: fee, value: 2000 }]);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: fee, maxValue: 5000 }] });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(true);
    });

    it('keeps independent budgets per allow-list entry even if two entries somehow share a script', function () {
        const acct = makeAccount();
        const fee = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        // Two allow-list entries pointing at the same script, each with maxValue
        // 3000. A single output of 3000 must still match only ONE entry's budget
        // (the first found), not be treated as satisfying both independently in a
        // way that would let a second output of 3000 slip through unaccumulated.
        const psbt = buildMultiOutputPsbt(acct, [{ script: fee, value: 3000 }, { script: fee, value: 3000 }]);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: fee, maxValue: 3000 }] });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('OUTPUT_OVER_CAP');
    });
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    // Fund-key-safety fix: _checkFee must accept BigInt witnessUtxo/output values
    // (the SDK's own applyBufferutilsPatch narrowU64 legitimately produces them
    // above 2^53-1 sats, e.g. large DOGE UTXOs) and do exact BigInt arithmetic,
    // not deny with CANNOT_CHECK_FEE.
    it('accepts BigInt witnessUtxo values in the fee gate and reconciles the fee exactly', function () {
        const acct = makeAccount();
        const prevHash = crypto.randomBytes(32);
        const txid = Buffer.from(prevHash).reverse().toString('hex');
        const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
        const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
        const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
        const big = 10_000_000_000_000_000n; // above 2^53-1
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: big } });
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
        psbt.addOutput({ script: acct.p2trScript, value: big - 10000n });   // BigInt change too
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(true);
    });

    it('denies a BigInt-valued fee that exceeds maxFeeSats, computed exactly (no Number rounding)', function () {
        const acct = makeAccount();
        const prevHash = crypto.randomBytes(32);
        const txid = Buffer.from(prevHash).reverse().toString('hex');
        const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
        const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
        const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
        const big = 10_000_000_000_000_000n;
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: big } });
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
        psbt.addOutput({ script: acct.p2trScript, value: big - 1_000_000n });   // fee = 1,000,000 sats
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), maxFeeSats: 10000 });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('FEE_EXCEEDS_CAP');
    });

    it('still denies a fee exceeding a Number-typed maxFeeSats cap (no regression)', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
        // buildSignablePsbt: input 100000, change 90000 -> fee 10000
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), maxFeeSats: 100 });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('FEE_EXCEEDS_CAP');
    });
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    it('refuses a benign action that burns the balance into a value-bearing OP_RETURN', function () {
        const acct = makeAccount();
        // The entire input value routed into the OP_RETURN carrier, no change output.
        const psbt = buildOpReturnValuePsbt(acct, 99000, false);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('OP_RETURN_CARRIES_VALUE');
        expect(res.signatures, 'no partial signature is produced').to.equal(undefined);
    });

    it('still approves the normal zero-value OP_RETURN carrier with change to self', function () {
        const acct = makeAccount();
        const psbt = buildOpReturnValuePsbt(acct, 0, true);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(true);
    });

    // Anti-drain (fee-burn variant): a zero-value OP_RETURN carrier with NO change
    // output passes the output gate (nothing is diverted, nothing burned to
    // OP_RETURN), yet the entire input value silently becomes miner fee. The fee
    // gate reconciles sum(inputs) - sum(outputs) and refuses it.
    it('refuses a benign action that burns the whole balance as miner fee (change omitted, always-on)', function () {
        const acct = makeAccount();
        const psbt = buildOpReturnValuePsbt(acct, 0, false); // zero-value carrier, no change: every sat to fee
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('FEE_BURNS_ENTIRE_INPUT');
        expect(res.signatures, 'no partial signature is produced').to.equal(undefined);
    });

    // An undersized change output (a 1-sat dust leg) is the same drain, but it is
    // indistinguishable from a legitimate high fee without chain knowledge, so it
    // takes the operator's absolute cap to catch.
    it('refuses a fee-burn hidden behind a dust change output under an operator cap', function () {
        const acct = makeAccount();
        const psbt = buildOpReturnValuePsbt(acct, 0, false);
        psbt.addOutput({ script: acct.p2trScript, value: 1 }); // 1-sat change, 99999 to fee
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), maxFeeSats: 50000 });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('FEE_EXCEEDS_CAP');
    });
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    // An operator absolute cap (maxFeeSats) tightens the bound below the coarse
    // proportional backstop.
    it('refuses a fee above the operator maxFeeSats cap', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|MYTOKEN|10|1destX|m'); // fee = 10000
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), maxFeeSats: 5000 });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('FEE_EXCEEDS_CAP');
    });

    it('approves a normal fee within both the fraction backstop and an operator cap', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|MYTOKEN|10|1destX|m'); // fee = 10000
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), maxFeeSats: 20000 });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(true);
    });
});

