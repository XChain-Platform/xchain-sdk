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
require('../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2     = require('../../src/musig2.js');
const CoSigner   = require('../../src/cosigner/coSigner.js');
const WindowStore = require('../../src/cosigner/windowStore.js');

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

describe('CoSigner (MuSig2 hard-enforcement service)', function () {

    function policy(extra) {
        return Object.assign({ allowedActions: new Set(['SEND']) }, extra || {});
    }

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
        // witness-assembly side (musig2Signer.js) writes a bare 64-byte tapKeySig
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

    // : caps and output values were compared as Numbers, and
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

    // : the cap itself was parsed with Number() while both sites that
    // enforce it compare in BigInt, so a >2^53 cap was ROUNDED before enforcement.
    // The chosen cap rounds UP - Number('9007199254740995') is 9007199254740996 -
    // which is the direction that LOOSENS the guard: a fee one satoshi above the
    // operator's real cap compared within the rounded one and was approved. Both
    // directions are asserted, since a cap rounding the other way false-denies.
    describe('maxFeeSats is parsed as an exact u64 ()', function () {
        const CAP = 9007199254740995n;   // above 2^53; Number() rounds it UP to ...996
        const IN  = 18014398509481984n;  // 2^54, comfortably above any fee below

        // One signable OP_RETURN spend whose miner fee is exactly `fee`.
        const psbtWithFee = (acct, prevHash, fee) => {
            const txid = Buffer.from(prevHash).reverse().toString('hex');
            const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
            const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
            const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
            const psbt = new bitcoin.Psbt();
            psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: IN } });
            psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
            psbt.addOutput({ script: acct.p2trScript, value: IN - fee });
            return psbt;
        };

        const run = (capForm, fee) => {
            const acct = makeAccount();
            const prevHash = crypto.randomBytes(32);
            const psbt = psbtWithFee(acct, prevHash, fee);
            const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
            const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
                policy: policy(), maxFeeSats: capForm });
            return co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        };

        for (const [label, capForm] of [['bigint', CAP], ['digit string', String(CAP)]]) {
            it(`approves a fee landing exactly on a >2^53 cap given as a ${label}`, function () {
                expect(run(capForm, CAP).approved).to.equal(true);
            });

            it(`denies a fee ONE satoshi over a >2^53 cap given as a ${label}`, function () {
                const res = run(capForm, CAP + 1n);
                expect(res.approved).to.equal(false);
                expect(res.reason).to.equal('FEE_EXCEEDS_CAP');
                // The detail rides a JSON response, so the BigInt cap must be a string.
                expect(res.detail.maxFeeSats).to.equal(String(CAP));
                expect(() => JSON.stringify(res)).to.not.throw();
            });
        }

        // A cap that cannot be represented exactly is refused at construction rather
        // than rounded into the guard, matching allowedOutputs[].maxValue. The bare
        // Number form of a >2^53 cap has ALREADY lost precision (), so it
        // is rejected too: such a cap must arrive as a bigint or a digit string.
        for (const bad of [9007199254740993, 1.5, -1, 'abc', {}, NaN])
            it(`refuses a maxFeeSats of ${String(bad)} at construction`, function () {
                const acct = makeAccount();
                expect(() => new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
                    tweaks: acct.tweaks, policy: policy(), maxFeeSats: bad })).to.throw(/maxFeeSats/);
            });
    });

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

    // Multi-input: one authorization covering a tx that spends several aggregate
    // UTXOs, a partial signature per input, the budget charged once.
    function buildMultiInputPsbt(acct, n, scripts) {
        const psbt = new bitcoin.Psbt();
        for (let i = 0; i < n; i++)
            psbt.addInput({ hash: crypto.randomBytes(32), index: i,
                witnessUtxo: { script: (scripts && scripts[i]) || acct.p2trScript, value: 100000 } });
        const firstTxid = Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex');
        const inner = bitcoin.script.compile([Buffer.from('SEND|0|TOK|1|1destX|m', 'utf8')]);
        const cipher = crypto.createCipheriv('aes-128-ctr', firstTxid.substr(0, 16), firstTxid.substr(16, 16));
        const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
        psbt.addOutput({ script: acct.p2trScript, value: n * 90000 });   // change to self
        return psbt;
    }
    function multiInputs(acct, n) {
        return Array.from({ length: n }, (_, i) => ({
            index: i,
            agentPublicNonce: Buffer.from(new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex'),
        }));
    }

    it('multi-input: approves once and returns one partial signature per input', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: buildMultiInputPsbt(acct, 3).toHex(), inputs: multiInputs(acct, 3) });
        expect(res.approved).to.equal(true);
        expect(res.signatures).to.have.length(3);
        expect(res.signatures.map((s) => s.index)).to.deep.equal([0, 1, 2]);
    });

    it('multi-input: charges the window once for the whole tx', function () {
        const acct = makeAccount();
        const stateFile = path.join(os.tmpdir(), `cosigner-multi-${crypto.randomBytes(6).toString('hex')}.json`);
        const store = new WindowStore(stateFile, 24, null, { init: true });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy({ maxPerWindow: { hours: 24, maxActions: 1 } }), windowStore: store });
        try {
            const first = co.process({ psbt: buildMultiInputPsbt(acct, 2).toHex(), inputs: multiInputs(acct, 2) });
            expect(first.approved).to.equal(true);          // a 2-input tx consumes ONE action
            const second = co.process({ psbt: buildMultiInputPsbt(acct, 2).toHex(), inputs: multiInputs(acct, 2) });
            expect(second.approved).to.equal(false);
            expect(second.reason).to.equal('POLICY_WINDOW_COUNT_EXCEEDED');
        } finally {
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('multi-input: fails closed on a mixed-account input set', function () {
        const acct = makeAccount();
        const foreign = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const psbt = buildMultiInputPsbt(acct, 2, [acct.p2trScript, foreign]);
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: multiInputs(acct, 2) });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('MIXED_INPUT_SCRIPTS');
    });

    // Anti-forgery: a witnessUtxo.script that isn't the daemon's own derived
    // account must be denied (PREVOUT_NOT_OUR_ACCOUNT), and denial must consume
    // no velocity-window budget (see FINDING 1841 / coSigner.js _checkPrevouts).
    it('denies a foreign witnessUtxo.script with PREVOUT_NOT_OUR_ACCOUNT, before _checkOutputs would otherwise pass it', function () {
        const acct = makeAccount();
        const foreignSk = crypto.randomBytes(32);
        const foreignPk = secp256k1.getPublicKey(foreignSk, true);
        const foreignAggAcct = makeAccount(); // an unrelated account's own aggregate script
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
        // Overwrite the witnessUtxo to point at a DIFFERENT (foreign) account's
        // script, while everything else (action, change output) still looks benign
        // to _checkOutputs/_checkFee because they only ever compare against the
        // same caller-supplied script.
        psbt.data.inputs[0].witnessUtxo.script = foreignAggAcct.p2trScript;
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('PREVOUT_NOT_OUR_ACCOUNT');
        expect(res.detail.index).to.equal(0);
        expect(res.detail.expected).to.equal(acct.p2trScript.toString('hex'));
        expect(res.detail.got).to.equal(foreignAggAcct.p2trScript.toString('hex'));
        void foreignPk;
    });

    it('a foreign-prevout denial does NOT consume velocity-window budget', function () {
        const acct = makeAccount();
        const foreignAggAcct = makeAccount();
        const stateFile = path.join(os.tmpdir(), `cosigner-prevout-${crypto.randomBytes(6).toString('hex')}.json`);
        const store = new WindowStore(stateFile, 24, null, { init: true });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy({ maxPerWindow: { hours: 24, maxActions: 1 } }), windowStore: store });
        try {
            const before = store.snapshot();
            const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
            psbt.data.inputs[0].witnessUtxo.script = foreignAggAcct.p2trScript;
            const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
            const res = co.process({ psbt: psbt.toHex(), inputs: [{ index: 0, agentPublicNonce: agentNonce }] });
            expect(res.approved).to.equal(false);
            expect(res.reason).to.equal('PREVOUT_NOT_OUR_ACCOUNT');
            const after = store.snapshot();
            expect(after).to.deep.equal(before);   // no budget consumed

            // Prove the window is still fully available: a genuine in-policy request
            // against the real account still succeeds after the denial.
            const good = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
            const goodNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
            const goodRes = co.process({ psbt: good.toHex(), inputs: [{ index: 0, agentPublicNonce: goodNonce }] });
            expect(goodRes.approved).to.equal(true);
        } finally {
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('multi-input: denies when every input uniformly carries a foreign script', function () {
        const acct = makeAccount();
        const foreignAggAcct = makeAccount();
        const psbt = buildMultiInputPsbt(acct, 2, [foreignAggAcct.p2trScript, foreignAggAcct.p2trScript]);
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), inputs: multiInputs(acct, 2) });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('PREVOUT_NOT_OUR_ACCOUNT');
        expect(res.detail.index).to.equal(0);
    });
});

describe('WindowStore (fail-closed budget)', function () {
    let stateFile;
    beforeEach(() => { stateFile = path.join(os.tmpdir(), `ws-${crypto.randomBytes(6).toString('hex')}.json`); });
    afterEach(() => { try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ } });

    it('snapshots an empty window before any record', function () {
        const s = new WindowStore(stateFile, 24, null, { init: true });
        expect(s.snapshot()).to.deep.equal({ count: 0, perTick: {} });
    });

    it('accumulates per-tick totals and counts', function () {
        const s = new WindowStore(stateFile, 24, null, { init: true });
        s.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        s.record({ action: 'SEND', tick: 'TOK', amount: '7' });
        const snap = s.snapshot();
        expect(snap.count).to.equal(2);
        expect(snap.perTick.TOK).to.equal('12');
    });

    it('prunes entries older than the window', function () {
        let t = 1_000_000_000_000;
        const s = new WindowStore(stateFile, 1, () => t, { init: true });   // 1-hour window, injected clock
        s.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        t += 2 * 3600 * 1000;                               // advance 2h
        // reload from disk so the in-memory cache doesn't mask pruning. The store
        // is a single-writer resource (G5), so the first handle must hand the lock
        // over before a second one can open the same file.
        s.release();
        const s2 = new WindowStore(stateFile, 1, () => t, { init: true });
        expect(s2.snapshot().count).to.equal(0);
    });

    it('fails closed on a corrupt state file (never silently resets the budget)', function () {
        fs.writeFileSync(stateFile, '{ not valid json');
        // The store loads EAGERLY since G6, so a corrupt window is a startup
        // failure the operator sees at boot rather than a surprise on the first
        // co-sign request. init:true does not paper over it: the file exists, it
        // is simply unreadable, and silently resetting it would re-open the budget.
        expect(() => new WindowStore(stateFile, 24, null, { init: true })).to.throw(/unreadable/);
    });

    it('refuses to start when the state file is ABSENT (deletion is not a reset)', function () {
        // Without init, a missing window is a hard error: treating it as empty
        // made `rm window.json` a complete, silent budget reset (G6).
        let err = null;
        try { new WindowStore(stateFile, 24); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('WINDOW_STATE_MISSING');
    });
});
