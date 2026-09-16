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
require('../../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2     = require('../../../../src/cosigner/musig2.js');
const CoSigner   = require('../../../../src/cosigner/co_signer.js');
const WindowStore = require('../../../../src/cosigner/window_store.js');

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

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
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
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    // Anti-forgery: a witnessUtxo.script that isn't the daemon's own derived
    // account must be denied (PREVOUT_NOT_OUR_ACCOUNT), and denial must consume
    // no velocity-window budget (see co_signer.js checkPrevouts).
    it('denies a foreign witnessUtxo.script with PREVOUT_NOT_OUR_ACCOUNT, before checkOutputs would otherwise pass it', function () {
        const acct = makeAccount();
        const foreignSk = crypto.randomBytes(32);
        const foreignPk = secp256k1.getPublicKey(foreignSk, true);
        const foreignAggAcct = makeAccount(); // an unrelated account's own aggregate script
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|1|1destX|m');
        // Overwrite the witnessUtxo to point at a DIFFERENT (foreign) account's
        // script, while everything else (action, change output) still looks benign
        // to checkOutputs/checkFee because they only ever compare against the
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
});

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
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

describe('CoSigner (MuSig2 hard-enforcement service)', function () {
    // The cap itself was parsed with Number() while both sites that
    // enforce it compare in BigInt, so a >2^53 cap was ROUNDED before enforcement.
    // The chosen cap rounds UP - Number('9007199254740995') is 9007199254740996 -
    // which is the direction that LOOSENS the guard: a fee one satoshi above the
    // operator's real cap compared within the rounded one and was approved. Both
    // directions are asserted, since a cap rounding the other way false-denies.
    describe('maxFeeSats is parsed as an exact u64', function () {
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
        // Number form of a >2^53 cap has ALREADY lost precision, so it
        // is rejected too: such a cap must arrive as a bigint or a digit string.
        for (const bad of [9007199254740993, 1.5, -1, 'abc', {}, NaN])
            it(`refuses a maxFeeSats of ${String(bad)} at construction`, function () {
                const acct = makeAccount();
                expect(() => new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
                    tweaks: acct.tweaks, policy: policy(), maxFeeSats: bad })).to.throw(/maxFeeSats/);
            });
    });
});
