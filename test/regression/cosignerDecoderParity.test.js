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
// G10: DIFFERENTIAL decode parity between the co-signer's action decoder and
// the authoritative on-chain decoder.
//
// xchain-decoder is the protocol arbiter, but it is DB/RPC-bound and cannot be
// imported as a library, so the co-signer re-implements the pure extraction
// path from the same primitives. The only validation previously on record was a
// round-trip against the ENCODER's forward construction - precisely the set of
// inputs an attacker will never use. The security property the co-signer
// actually needs is not "agrees on encoder output" but:
//
//     for any payload, the co-signer either REFUSES, or returns exactly what
//     xchain-decoder returns.
//
// A silent misparse is the one unacceptable outcome: it would let a benign
// action pass policy while the chain executes a different one. Being STRICTER
// than the arbiter is always safe and is deliberate in several places below
// (the co-signer demands exactly one two-element OP_RETURN, rejects invalid
// UTF-8 outright, and refuses the alternate carrier shapes entirely).
//
// This drives the arbiter's REAL extraction code: `parseTransaction` with only
// its two node-RPC calls stubbed, then the confirmed-block path's own
// post-steps rebuilt from the arbiter's exported symbols
// (canonicalizeActionPayload / MAX_ACTION_DATA_LENGTH), never from a local copy
// of its tables.

const { expect } = require('chai');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
require('../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');

// Resolve the sibling arbiter repo, mirroring the convention the other
// cross-repo conformance suites use: skip when it is not checked out (a
// standalone SDK deploy), but fail loudly under XCHAIN_REQUIRE_SIBLINGS=1 so CI
// can never quietly lose the coverage.
const DECODER_DIR = process.env.XCHAIN_DECODER_DIR
    || path.join(__dirname, '..', '..', '..', 'xchain-decoder');
const DECODER_ENTRY = path.join(DECODER_DIR, 'src', 'XChainDecoder.js');

let XChainDecoder = null;
try {
    if (fs.existsSync(DECODER_ENTRY)) XChainDecoder = require(DECODER_ENTRY);
} catch (e) { /* sibling present but unloadable; treated as absent below */ }

const MAGIC = Buffer.from('XCHN');

function obfuscate(data, txidHex) {
    const c = crypto.createCipheriv('aes-128-ctr', txidHex.substr(0, 16), txidHex.substr(16, 16));
    return Buffer.concat([c.update(data), c.final()]);
}

// The exact bytes the encoder writes into the OP_RETURN: obfuscated
// (XCHN || <script push of the action bytes>).
function carrierPayload(actionBytes, txidHex, opts = {}) {
    const inner = opts.rawInner ? actionBytes : bitcoin.script.compile([actionBytes]);
    return obfuscate(Buffer.concat([MAGIC, inner]), txidHex);
}

describe('co-signer decode parity with the authoritative decoder @regression', function () {

    let decoder = null;
    const prevHash = Buffer.alloc(32, 7);
    const prevTxid = Buffer.from(prevHash).reverse().toString('hex');

    before(function () {
        if (!XChainDecoder) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the sibling xchain-decoder was not found at ' + DECODER_ENTRY);
            this.skip();
            return;
        }
        decoder = new XChainDecoder('bitcoin-regtest', '127.0.0.1', 3306, 'x', 'u', 'p',
            '127.0.0.1', 18443, 'u', 'p', false, null);
        // The extraction path is pure; only these two reach the node. Stubbing
        // them leaves every byte-level decision (OP_RETURN selection,
        // de-obfuscation, magic word, decompile, size measurement) running the
        // arbiter's own unmodified code.
        decoder.getSourceFromOutput   = async () => null;
        decoder.findFundingFeeOutputs = async () => [];
    });

    // Mirror of the confirmed-block path's post-parse steps (XChainDecoder.js,
    // updateBlocks), built from the arbiter's OWN exports so a change to its
    // alias table or size cap shows up here as a failure rather than as drift.
    async function authoritative(tx) {
        const parsed = await decoder.parseTransaction(tx, new Set(), { getAddressId: async () => null });
        if (!parsed || !Buffer.isBuffer(parsed.data) || parsed.data.length === 0)
            return { ok: false, reason: 'NO_ACTION' };
        if (parsed.compiledDataLength > XChainDecoder.MAX_ACTION_DATA_LENGTH)
            return { ok: false, reason: 'OVERSIZED' };

        const canonical = XChainDecoder.canonicalizeActionPayload(parsed.data);
        let strictUtf8 = true, canonicalString;
        try {
            canonicalString = new TextDecoder('utf-8', { fatal: true }).decode(canonical.buffer);
        } catch (e) {
            strictUtf8 = false;
            canonicalString = new TextDecoder('utf-8').decode(canonical.buffer);
        }
        if (!canonical.isKnown) return { ok: false, reason: 'UNKNOWN_ACTION' };

        // The raw (pre-alias-rewrite) string, which is what the co-signer
        // reports as its actionString.
        let rawString;
        try { rawString = new TextDecoder('utf-8', { fatal: true }).decode(parsed.data); }
        catch (e) { rawString = new TextDecoder('utf-8').decode(parsed.data); }

        return { ok: true, actionName: canonical.actionName, rawString, canonicalString, strictUtf8 };
    }

    // Build the matching tx + PSBT for a set of outputs, so both decoders see
    // byte-identical transactions.
    function pair(outputs) {
        const tx = new bitcoin.Transaction();
        tx.addInput(Buffer.from(prevHash), 0);
        for (const o of outputs) tx.addOutput(o.script, o.value);

        const psbt = new bitcoin.Psbt();
        psbt.addInput({
            hash: Buffer.from(prevHash), index: 0,
            witnessUtxo: { script: Buffer.alloc(34, 1), value: 100000 },
        });
        for (const o of outputs) psbt.addOutput({ script: o.script, value: o.value });
        return { tx, psbt };
    }

    function opReturn(payload) {
        return { script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, payload]), value: 0 };
    }

    // THE property. Every case below routes through here.
    async function assertParity(outputs, label) {
        const { tx, psbt } = pair(outputs);
        const mine = decodeActionFromPsbt(psbt);
        const theirs = await authoritative(tx);

        if (!mine.ok) return { mine, theirs };          // refusing is always safe

        expect(theirs.ok, `${label}: co-signer accepted a payload the arbiter treats as no-action ` +
            `(${theirs.reason}) - it would authorize an action the chain never executes`).to.equal(true);
        expect(mine.actionString, `${label}: recovered action bytes diverge`).to.equal(theirs.rawString);
        expect(mine.action, `${label}: canonical action name diverges`).to.equal(theirs.actionName);
        return { mine, theirs };
    }

    it('agrees on an ordinary encoder-produced action (the control)', async function () {
        const s = 'SEND|0|PEPECASH|1.50000000|1destX|memo';
        const r = await assertParity([opReturn(carrierPayload(Buffer.from(s, 'utf8'), prevTxid))], 'control');
        expect(r.mine.ok).to.equal(true);
        expect(r.mine.action).to.equal('SEND');
    });

    it('agrees on a documented action alias (TRANSFER -> SEND)', async function () {
        const s = 'TRANSFER|0|PEPECASH|1|1destX|memo';
        const r = await assertParity([opReturn(carrierPayload(Buffer.from(s, 'utf8'), prevTxid))], 'alias');
        expect(r.mine.ok).to.equal(true);
        expect(r.mine.action).to.equal('SEND');
        expect(r.mine.actionString).to.equal(s);        // raw bytes preserved, not rewritten
    });

    it('both refuse a non-canonical-case action name', async function () {
        const s = 'send|0|PEPECASH|1|1destX|memo';
        const r = await assertParity([opReturn(carrierPayload(Buffer.from(s, 'utf8'), prevTxid))], 'case');
        expect(r.mine.ok).to.equal(false);
        expect(r.theirs.ok).to.equal(false);            // the arbiter drops it as an unknown action
    });

    it('the co-signer refuses a second OP_RETURN rather than picking one', async function () {
        // The arbiter's output loop lets the LAST two-element OP_RETURN win. A
        // decoder that picked a different one would gate a different action than
        // the chain executes, so the co-signer refuses the ambiguity outright.
        const a = 'SEND|0|AAA|1|1destX|m';
        const b = 'SEND|0|BBB|999|1attacker|m';
        const r = await assertParity([
            opReturn(carrierPayload(Buffer.from(a, 'utf8'), prevTxid)),
            opReturn(carrierPayload(Buffer.from(b, 'utf8'), prevTxid)),
        ], 'multi-op-return');
        expect(r.mine.ok).to.equal(false);
        expect(r.mine.reason).to.equal('MULTI_OP_RETURN');
    });

    it('both ignore a multi-push OP_RETURN (not the carrier shape)', async function () {
        const s = 'SEND|0|PEPECASH|1|1destX|m';
        const payload = carrierPayload(Buffer.from(s, 'utf8'), prevTxid);
        const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, payload, Buffer.from('extra')]);
        const r = await assertParity([{ script, value: 0 }], 'multi-push');
        expect(r.mine.ok).to.equal(false);
        expect(r.theirs.ok).to.equal(false);
    });

    it('the co-signer refuses the bare-multisig carrier the arbiter accepts', async function () {
        // The arbiter recognizes a bare 1-of-3 multisig data carrier. The
        // co-signer never examines that shape, so it must land on a refusal -
        // never on a decode of only PART of what the chain will execute. This is
        // the anti-smuggling property the output gate also backstops (G7).
        const s = 'SEND|0|SMUGGLED|999|1attacker|m';
        const data = carrierPayload(Buffer.from(s, 'utf8'), prevTxid);
        const chunk = (i) => {
            const b = Buffer.alloc(33, 0x02);
            const start = Math.min(i * 32, data.length);
            data.copy(b, 1, start, Math.min(start + 32, data.length));
            return b;
        };
        const script = bitcoin.script.compile([
            bitcoin.opcodes.OP_1, chunk(0), chunk(1), chunk(2), bitcoin.opcodes.OP_3,
            bitcoin.opcodes.OP_CHECKMULTISIG,
        ]);
        const r = await assertParity([{ script, value: 0 }], 'bare-multisig');
        expect(r.mine.ok).to.equal(false);
    });

    it('the co-signer refuses invalid UTF-8 the arbiter decodes with replacement chars', async function () {
        const bad = Buffer.concat([Buffer.from('SEND|0|', 'utf8'), Buffer.from([0xff, 0xfe]),
                                   Buffer.from('|1|1destX|m', 'utf8')]);
        const r = await assertParity([opReturn(carrierPayload(bad, prevTxid))], 'invalid-utf8');
        expect(r.mine.ok).to.equal(false);
        expect(r.mine.reason).to.equal('NOT_UTF8');
    });

    it('both refuse an oversized payload', async function () {
        const big = Buffer.alloc(XChainDecoder.MAX_ACTION_DATA_LENGTH + 64, 0x41);
        const s = Buffer.concat([Buffer.from('SEND|0|TOK|1|1destX|', 'utf8'), big]);
        const r = await assertParity([opReturn(carrierPayload(s, prevTxid))], 'oversized');
        expect(r.mine.ok).to.equal(false);
        expect(r.theirs.ok).to.equal(false);
    });

    it('both refuse the P2SH two-phase tag (the params are not in this tx)', async function () {
        const payload = obfuscate(Buffer.concat([MAGIC, Buffer.from('p2sh')]), prevTxid);
        const r = await assertParity([opReturn(payload)], 'p2sh-tag');
        expect(r.mine.ok).to.equal(false);
        expect(r.mine.reason).to.equal('P2SH_P2WSH_UNSUPPORTED');
    });

    it('agrees across a randomized and adversarial corpus', async function () {
        this.timeout(30000);
        // Deterministic PRNG: a differential failure must be reproducible from
        // the test alone, not dependent on the run.
        let seed = 0x5eed1234;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const pickOne = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

        const actions   = ['SEND', 'TRANSFER', 'MSG', 'ISSUE', 'ORDER', 'SWEEP', 'BATCH', 'EXECUTE',
                           'NOPE', 'send', '', 'SEND '];
        const versions  = ['0', '1', '9', '99', '-1', 'x', ''];
        const fragments = ['TOK', '^12', '1.5', '', '|', ';', 'a'.repeat(300), 'é', 'constructor',
                           '__proto__', 'BAD\\TICK', '0x10'];

        let accepted = 0;
        for (let i = 0; i < 400; i++) {
            let bytes;
            if (i % 5 === 0) {
                // Raw garbage: exercises the decompile / magic-word / utf8 gates.
                const len = 1 + Math.floor(rnd() * 80);
                const b = Buffer.alloc(len);
                for (let j = 0; j < len; j++) b[j] = Math.floor(rnd() * 256);
                bytes = b;
            } else {
                const n = 1 + Math.floor(rnd() * 8);
                const segs = [pickOne(actions), pickOne(versions)];
                for (let j = 0; j < n; j++) segs.push(pickOne(fragments));
                bytes = Buffer.from(segs.join('|'), 'utf8');
            }
            // Alternate between the canonical script push and a raw (unpushed)
            // inner body, so the inner-decompile gate is exercised too.
            const payload = carrierPayload(bytes, prevTxid, { rawInner: i % 7 === 0 });
            const r = await assertParity([opReturn(payload)], `fuzz#${i}`);
            if (r.mine.ok) accepted++;
        }
        // Guard against the corpus degenerating into "everything refuses", which
        // would make the parity assertions vacuous.
        expect(accepted, 'the corpus never exercised an accepting path').to.be.greaterThan(0);
    });
});
