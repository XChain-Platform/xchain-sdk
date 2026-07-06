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
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce, inputIndex: 0 });
        expect(res.approved).to.equal(true);

        // Agent finishes from the co-signer's nonce + message.
        const msg = h2b(res.msg);
        const aggNonce = agentMusig.aggregateNonces([agentNonce, h2b(res.publicNonce)]);
        const session  = agentMusig.startSession(aggNonce, msg, acct.keys, acct.tweaks);
        const agentSig = agentMusig.partialSign({ secretKey: acct.agentSk, publicNonce: agentNonce, sessionKey: session });
        const finalSig = agentMusig.aggregateSignatures([agentSig, h2b(res.sig)], session);

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
            const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce, inputIndex: 0, sighashType: bad });
            expect(res.approved, 'sighashType 0x' + bad.toString(16) + ' must not approve').to.not.equal(true);
            expect(res.reason).to.equal('SIGHASH_TYPE_NOT_ALLOWED');
            expect(res.sig, 'no partial signature is produced').to.equal(undefined);
        }
    });

    it('still approves an explicit SIGHASH_ALL (0x01) request', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|MYTOKEN|10|1destX|m');
        const agentMusig = new MuSig2();
        const agentNonce = agentMusig.generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce, inputIndex: 0, sighashType: 0x01 });
        expect(res.approved).to.equal(true);
    });

    it('derives the message from the PSBT, not the caller (no msg input is accepted)', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
        const agentMusig = new MuSig2();
        const agentNonce = agentMusig.generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
        // The returned msg equals the independently-computed Taproot sighash.
        const expected = CoSigner.taprootKeyPathSighash(bitcoin.Psbt.fromHex(psbt.toHex()), 0).toString('hex');
        expect(res.msg).to.equal(expected);
    });

    it('denies (and signs nothing) when the amount exceeds a per-action cap', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|100|1destX|m');
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy({ maxPerAction: { SEND: { TOK: '50' } } }) });
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_AMOUNT_EXCEEDED');
        expect(res.sig).to.equal(undefined);
    });

    it('denies an action that does not decode (no OP_RETURN) with a DECODE_ reason', function () {
        const acct = makeAccount();
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
        psbt.addOutput({ address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', value: 90000 });
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('DECODE_NO_OP_RETURN');
    });

    it('fails closed when a witnessUtxo is missing (output gate runs first, both refuse)', function () {
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m', { noWitnessUtxo: true });
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks, policy: policy() });
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
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
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('CONFIRMATION_REQUIRED');
    });

    it('enforces the server-side window cap across calls', function () {
        const acct = makeAccount();
        const stateFile = path.join(os.tmpdir(), `cosigner-test-${crypto.randomBytes(6).toString('hex')}.json`);
        const store = new WindowStore(stateFile, 24);
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy({ maxPerWindow: { hours: 24, maxActions: 1 } }), windowStore: store });

        const mk = () => {
            const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
            const nonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
            return co.process({ psbt: psbt.toHex(), agentPublicNonce: nonce });
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
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
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
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
        expect(res.approved).to.equal(true);
    });

    it('denies an authorized output that exceeds its value cap', function () {
        const acct = makeAccount();
        const fee = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true)) }).output;
        const psbt = buildDrainPsbt(acct, fee, 49000);
        const agentNonce = new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, tweaks: acct.tweaks,
            policy: policy(), allowedOutputs: [{ script: fee, maxValue: 5000 }] });
        const res = co.process({ psbt: psbt.toHex(), agentPublicNonce: agentNonce });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('OUTPUT_OVER_CAP');
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
        const store = new WindowStore(stateFile, 24);
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
});

describe('WindowStore (fail-closed budget)', function () {
    let stateFile;
    beforeEach(() => { stateFile = path.join(os.tmpdir(), `ws-${crypto.randomBytes(6).toString('hex')}.json`); });
    afterEach(() => { try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ } });

    it('snapshots an empty window before any record', function () {
        const s = new WindowStore(stateFile, 24);
        expect(s.snapshot()).to.deep.equal({ count: 0, perTick: {} });
    });

    it('accumulates per-tick totals and counts', function () {
        const s = new WindowStore(stateFile, 24);
        s.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        s.record({ action: 'SEND', tick: 'TOK', amount: '7' });
        const snap = s.snapshot();
        expect(snap.count).to.equal(2);
        expect(snap.perTick.TOK).to.equal('12');
    });

    it('prunes entries older than the window', function () {
        let t = 1_000_000_000_000;
        const s = new WindowStore(stateFile, 1, () => t);   // 1-hour window, injected clock
        s.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        t += 2 * 3600 * 1000;                               // advance 2h
        // reload from disk so the in-memory cache doesn't mask pruning
        const s2 = new WindowStore(stateFile, 1, () => t);
        expect(s2.snapshot().count).to.equal(0);
    });

    it('fails closed on a corrupt state file (never silently resets the budget)', function () {
        fs.writeFileSync(stateFile, '{ not valid json');
        const s = new WindowStore(stateFile, 24);
        expect(() => s.snapshot()).to.throw(/unreadable/);
    });
});
