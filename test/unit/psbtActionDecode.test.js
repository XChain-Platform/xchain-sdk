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
const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');
const { evaluatePolicy } = require('../../src/cosigner/policyEvaluator.js');

// Build an OP_RETURN PSBT exactly the way xchain-encoder does, so the decoder
// is tested against the real forward construction (not the decoder's own
// assumptions): compile([actionBytes]) -> prepend XCHN -> AES-128-CTR keyed by
// the first input's txid -> bitcoin.payments.embed. See XChainEncoder.js
// prepareData (OP_RETURN case), obfuscate(), and the OP_RETURN output build.
function buildPsbt(actionString, opts = {}) {
    const inputHash = opts.inputHash || crypto.randomBytes(32);   // internal (LE) hash
    const txid = Buffer.from(inputHash).reverse().toString('hex'); // display txid
    const key  = txid.substr(0, 16);
    const iv   = txid.substr(16, 16);

    // The on-chain payload after the magic word is a compiled push of the bytes.
    const inner = opts.rawBody || bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const tagged = opts.noMagic ? inner : Buffer.concat([Buffer.from('XCHN'), inner]);

    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
    const obf = opts.noObfuscation ? tagged : Buffer.concat([cipher.update(tagged), cipher.final()]);

    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: inputHash, index: 0 });
    if (opts.extraNonOpReturnOutput)
        psbt.addOutput({ address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', value: 1000 });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    return psbt;
}

describe('psbtActionDecode.decodeActionFromPsbt', function () {

    it('decodes a single-output SEND v0 (full round-trip vs the encoder construction)', function () {
        const r = decodeActionFromPsbt(buildPsbt('SEND|0|MYTOKEN|100|1abcDEST|hello'));
        expect(r.ok).to.equal(true);
        expect(r.action).to.equal('SEND');
        expect(r.version).to.equal(0);
        expect(r.params).to.deep.equal({ TICK: 'MYTOKEN', AMOUNT: '100', DESTINATION: '1abcDEST', MEMO: 'hello' });
    });

    it('resolves documented on-chain aliases to the canonical action (decoder/indexer parity)', function () {
        // Mirror of xchain-decoder ACTION_ALIASES / xchain-indexer actionAliases:
        // a spec-following client may encode any of these leading tokens and the
        // chain accepts them, so the co-signer must judge the canonical action.
        const r = decodeActionFromPsbt(buildPsbt('TRANSFER|0|MYTOKEN|100|1abcDEST|hello'));
        expect(r.ok).to.equal(true);
        expect(r.action).to.equal('SEND');
        expect(r.params).to.deep.equal({ TICK: 'MYTOKEN', AMOUNT: '100', DESTINATION: '1abcDEST', MEMO: 'hello' });
        // Alias-decoded action feeds policy under its canonical name.
        const v = evaluatePolicy({ allowedActions: new Set(['SEND']) }, { action: r.action, params: r.params });
        expect(v.ok).to.equal(true);
    });

    it('refuses a non-canonical-case action name instead of upper-casing it (decoder-parity)', function () {
        // XChainDecoder.js reads the raw action token WITHOUT case-folding it, so
        // an on-chain "send|..." (lower-case) is treated as an unknown action and
        // skipped, not silently matched to SEND. The co-signer must fail closed
        // the same way, or it could authorize-and-sign a payload the arbiter/
        // indexer read as no-action at all.
        const r = decodeActionFromPsbt(buildPsbt('send|0|MYTOKEN|100|1abcDEST|hello'));
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('UNKNOWN_ACTION');
    });

    it('refuses a non-canonical-case alias token the same way (decoder-parity)', function () {
        const r = decodeActionFromPsbt(buildPsbt('transfer|0|MYTOKEN|100|1abcDEST|hello'));
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('UNKNOWN_ACTION');
    });

    it('decodes correctly when the encoder trimmed a trailing empty MEMO', function () {
        // formatSelector.serialize trims trailing empties: "SEND|0|TOK|5|dest"
        const r = decodeActionFromPsbt(buildPsbt('SEND|0|TOK|5|1destX'));
        expect(r.ok).to.equal(true);
        expect(r.params).to.deep.equal({ TICK: 'TOK', AMOUNT: '5', DESTINATION: '1destX', MEMO: '' });
    });

    it('ignores a non-OP_RETURN payment output and still finds the action', function () {
        const r = decodeActionFromPsbt(buildPsbt('SEND|0|TOK|5|1destX|m', { extraNonOpReturnOutput: true }));
        expect(r.ok).to.equal(true);
        expect(r.action).to.equal('SEND');
    });

    it('feeds decoded params straight into the policy evaluator', function () {
        const r = decodeActionFromPsbt(buildPsbt('SEND|0|TOK|100|1destX|m'));
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '50' } } };
        const v = evaluatePolicy(policy, { action: r.action, params: r.params });
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    /* ── fail-closed paths (a refusal to sign is always safe) ──────────── */

    it('fails closed on a PSBT with no inputs', function () {
        const psbt = new bitcoin.Psbt();
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [Buffer.from('x')] }).output, value: 0 });
        expect(decodeActionFromPsbt(psbt).reason).to.equal('NO_INPUTS');
    });

    it('fails closed when there is no OP_RETURN output', function () {
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: crypto.randomBytes(32), index: 0 });
        psbt.addOutput({ address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', value: 1000 });
        expect(decodeActionFromPsbt(psbt).reason).to.equal('NO_OP_RETURN');
    });

    it('fails closed when the decrypted payload lacks the XCHN magic word', function () {
        const r = decodeActionFromPsbt(buildPsbt('SEND|0|TOK|5|1destX', { noMagic: true }));
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('NO_MAGIC_WORD');
    });

    it('fails closed on a P2SH funding-tx tag (action params not in this PSBT)', function () {
        // OP_RETURN body after XCHN is exactly "p2sh" (no compiled push).
        const r = decodeActionFromPsbt(buildPsbt(null, { rawBody: Buffer.from('p2sh') }));
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('P2SH_P2WSH_UNSUPPORTED');
    });

    it('fails closed on a multi-leg SEND v2 (repeated value fields would under-count)', function () {
        // SEND v2: VERSION|TICK|AMOUNT|DESTINATION|TICK|AMOUNT|DESTINATION|MEMO
        const r = decodeActionFromPsbt(buildPsbt('SEND|2|TOK|1000000|1evil|TOK|1|1ok|m'));
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('MULTI_LEG_UNSUPPORTED');
    });

    it('fails closed on an unknown action', function () {
        const r = decodeActionFromPsbt(buildPsbt('NOTANACTION|0|x'));
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('UNKNOWN_ACTION');
    });

    it('fails closed when the obfuscation key is wrong (decrypt yields garbage, no magic word)', function () {
        // Build with one input hash, then swap the input so the txid-derived key differs.
        const psbt = buildPsbt('SEND|0|TOK|5|1destX');
        const tampered = bitcoin.Psbt.fromHex(psbt.toHex());
        // Rebuild input list with a different hash by constructing a fresh PSBT
        // that reuses the (now mis-keyed) OP_RETURN output.
        const out = tampered.txOutputs[0];
        const swapped = new bitcoin.Psbt();
        swapped.addInput({ hash: crypto.randomBytes(32), index: 0 });
        swapped.addOutput({ script: out.script, value: out.value });
        const r = decodeActionFromPsbt(swapped);
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('NO_MAGIC_WORD');
    });
});
