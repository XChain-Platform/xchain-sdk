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
// Must load before bitcoinjs-lib is used to build a PSBT with BigInt output
// values (large-satoshi / DOGE fixtures below): teaches bip174/bitcoinjs to
// accept number|bigint, matching what applyBufferutilsPatch does process-wide
// when the SDK's wallet.js is required in production.
require('../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2     = require('../../src/cosigner/musig2.js');
const CoSigner   = require('../../src/cosigner/co_signer.js');
const WindowStore = require('../../src/cosigner/window_store.js');

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

// Anti-drain: a benign in-policy action must not let an attacker-controlled
// output siphon the account's native coin.
function buildDrainPsbt(acct, drainScript, drainValue) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: 50000 });   // change to self
    psbt.addOutput({ script: drainScript, value: drainValue });  // the suspect leg
    return psbt;
}

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    it('approves an in-policy action and the 2-of-2 aggregate verifies under the agreed key', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|MYTOKEN|10|1destX|m');
        // Agent round 1 (its secret nonce stays in its own MuSig2 instance).
        const agentMusig = new MuSig2();
        const agentNonce = agentMusig.generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });

        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(true);
        // Agent finishes from the co-signer's nonce + message.
        // ONE result shape since the wire collapse: a signatures array, even for
        // a single input. CoSignerClient.sign() is where the unwrapping lives.
        const only = res.signatures[0];
        const msg = h2b(only.msg);
        const aggNonce = agentMusig.aggregateNonces([agentNonce, h2b(only.publicNonce)]);
        const session  = agentMusig.startSession(aggNonce, msg, acct.keys, acct.tweaks);
        const agentSig = agentMusig.partialSign({ secretKey: acct.agentSk, publicNonce: agentNonce, sessionKey: session });
        const finalSig = agentMusig.aggregateSignatures([agentSig, h2b(only.sig)], session);

        expect(schnorr.verify(finalSig, msg, acct.aggKey)).to.equal(true);
    });

    it('rejects a non-committing sighashType (NONE/SINGLE/ANYONECANPAY) that would bypass the output gate', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|MYTOKEN|10|1destX|m');
        const agentMusig = new MuSig2();
        const agentNonce = agentMusig.generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        // The same in-policy PSBT the co-signer approves above, but under a sighash
        // type that does not commit to the gated outputs. Each must be refused with
        // no partial signature produced.
        for (const bad of [0x02 /* NONE */, 0x03 /* SINGLE */, 0x81 /* ALL|ANYONECANPAY */, 0x83 /* SINGLE|ANYONECANPAY */]) {
            const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }], sighashType: bad });
            expect(res.approved, 'sighashType 0x' + bad.toString(16) + ' must not approve').to.not.equal(true);
            expect(res.reason).to.equal('SIGHASH_TYPE_NOT_ALLOWED');
            expect(res.signatures, 'no partial signature is produced').to.equal(undefined);
        }
    });

    it('rejects an explicit SIGHASH_ALL (0x01) request even though it commits to all outputs', function () {
        // SIGHASH_ALL is output-safe (same commitment as SIGHASH_DEFAULT) but the
        // witness-assembly side (musig2_signer.js) writes a bare 64-byte tapKeySig
        // with no trailing sighash-flag byte, which BIP341 only permits for
        // SIGHASH_DEFAULT. Approving ALL here would let the co-signer authorize a
        // spend the rest of the pipeline cannot correctly finalize, so it is
        // refused alongside the non-committing types.
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|MYTOKEN|10|1destX|m');
        const agentMusig = new MuSig2();
        const agentNonce = agentMusig.generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }], sighashType: 0x01 });
        expect(res.approved, 'SIGHASH_ALL must not approve').to.not.equal(true);
        expect(res.reason).to.equal('SIGHASH_TYPE_NOT_ALLOWED');
        expect(res.signatures, 'no partial signature is produced').to.equal(undefined);
    });
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    it('derives the message from the PSBT, not the caller (no msg input is accepted)', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
        const agentMusig = new MuSig2();
        const agentNonce = agentMusig.generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        // The returned msg equals the independently-computed Taproot sighash.
        const expected = CoSigner.taprootKeyPathSighash(bitcoin.Psbt.fromHex(psbt.toHex()), 0).toString('hex');
        expect(res.signatures[0].msg).to.equal(expected);
    });

    it('denies (and signs nothing) when the amount exceeds a per-action cap', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|100|1destX|m');
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy({ maxPerAction: { SEND: { TOK: '50' } } }) });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_AMOUNT_EXCEEDED');
        expect(res.signatures).to.equal(undefined);
    });

    it('denies an action that does not decode (no OP_RETURN) with a DECODE_ reason', function () {
        const acct = makeAccount();
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
        psbt.addOutput({ address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', value: 90000 });
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('DECODE_NO_OP_RETURN');
    });

    it('fails closed when a witnessUtxo is missing (output gate runs first, both refuse)', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m', { noWitnessUtxo: true });
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        // The output gate needs the spent script too, so it refuses before the
        // sighash step would; either way nothing is signed.
        expect(res.reason).to.equal('CANNOT_CHECK_OUTPUTS');
    });

    it('denies a confirm-required action (a headless daemon cannot prompt)', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|100|1destX|m');
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy({ confirmAbove: { perTick: { '*': '50' } } }) });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('CONFIRMATION_REQUIRED');
    });
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    it('enforces the server-side window cap across calls', function () {
        const acct = makeAccount();
        const stateFile = path.join(os.tmpdir(), `cosigner-test-${crypto.randomBytes(6).toString('hex')}.json`);
        const store = new WindowStore(stateFile, 24, null, { init: true });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy({ maxPerWindow: { hours: 24, maxActions: 1 } }), windowStore: store });

        const mk = () => {
            const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
            const nonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
            return co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: nonce }] });
        };
        try {
            expect(mk().approved).to.equal(true);                       // 1st consumes the window
            const second = mk();
            expect(second.approved).to.equal(false);                    // 2nd over the cap
            expect(second.reason).to.equal('POLICY_WINDOW_COUNT_EXCEEDED');
        } finally {
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    it('refuses a benign action that drains native coin to an unauthorized output', function () {
        const acct = makeAccount();
        // An attacker P2WPKH output not in any allow-list.
        const attacker = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const psbt = buildDrainPsbt(acct, attacker, 49000);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('UNAUTHORIZED_OUTPUT');
    });

    it('allows an operator-authorized output (e.g. the protocol-fee leg)', function () {
        const acct = makeAccount();
        const fee = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const psbt = buildDrainPsbt(acct, fee, 1000);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: fee, maxValue: 5000 }] });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(true);
    });

    it('denies an authorized output that exceeds its value cap', function () {
        const acct = makeAccount();
        const fee = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const psbt = buildDrainPsbt(acct, fee, 49000);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: fee, maxValue: 5000 }] });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('OUTPUT_OVER_CAP');
    });
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    // Caps and output values were compared as Numbers, and
    // Number(9007199254740993n) is 9007199254740992, so an output ONE satoshi above a
    // >2^53 cap compared EQUAL to it and was approved. Reachable on a low-unit-value
    // chain (large DOGE amounts are exactly why applyBufferutilsPatch carries u64 as
    // BigInt). Both sides are exact BigInt now.
    it('denies an output one satoshi above a cap larger than 2^53', function () {
        const acct = makeAccount();
        const dest = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const cap  = 9007199254740992n;            // 2^53, the exact point Number stops counting
        const over = cap + 1n;
        const prevHash = crypto.randomBytes(32);
        const txid = Buffer.from(prevHash).reverse().toString('hex');
        const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
        const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
        const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: over + 51000n } });
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
        psbt.addOutput({ script: acct.p2trScript, value: 50000 });
        psbt.addOutput({ script: dest, value: over });
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: dest, maxValue: cap.toString() }] });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('OUTPUT_OVER_CAP');
    });
});
