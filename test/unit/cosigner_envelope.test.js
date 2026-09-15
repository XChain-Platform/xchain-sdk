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

const {
    expect, crypto, bitcoin, secp256k1, schnorr, MuSig2, CoSigner,
    CoSignerClient, WindowStore, parseEnvelopeScript, deriveEnvelopeCommit,
    envelopeLeafHash, envelopeScriptPathSighash, classifyEnvelopeRole,
    envelopeRoundTweaks, buildRecoverySpend, localPairSigner,
    decodeEnvelopeAction, LEAF_VERSION, ACTION, makeAccount,
    buildEnvelopeScript, commitFor, buildCommitPsbt, buildRevealPsbt,
    buildCancelPsbt, makeCoSigner, runRound, make2of3, client3,
    envelopeFor3, commitPsbt3, revealPsbt3, cancelPsbt3,
    outputKeyFromControlBlock,
} = require('./cosigner_envelope.test/helpers/support.js');

describe('co-signer: Taproot envelope composition', function () {

    describe('grammar mirror (strict subset of the authoritative decoder)', function () {
        it('parses a well-formed envelope and recovers the exact payload', function () {
            const acct = makeAccount();
            const raw = crypto.randomBytes(900);
            const script = buildEnvelopeScript(acct.aggKey, ACTION, raw);
            const parsed = parseEnvelopeScript(script);
            expect(parsed).to.not.equal(null);
            expect(parsed.checksigKey.equals(acct.aggKey)).to.equal(true);
            const expected = bitcoin.script.compile([Buffer.from(ACTION, 'utf8'), raw]);
            expect(parsed.payload.equals(expected)).to.equal(true);
        });

        it('refuses a wrong magic, an unknown format byte, and a non-32-byte key', function () {
            const acct = makeAccount();
            expect(parseEnvelopeScript(buildEnvelopeScript(acct.aggKey, ACTION, null, { magic: 'XCHX' }))).to.equal(null);
            expect(parseEnvelopeScript(buildEnvelopeScript(acct.aggKey, ACTION, null, { formatByte: 0x01 }))).to.equal(null);
            expect(parseEnvelopeScript(buildEnvelopeScript(acct.aggKey, ACTION, null,
                { checksigKey: crypto.randomBytes(31) }))).to.equal(null);
        });

        it('refuses trailing junk after OP_CHECKSIG', function () {
            const acct = makeAccount();
            const good = buildEnvelopeScript(acct.aggKey, ACTION, null);
            const junked = Buffer.concat([good, Buffer.from([bitcoin.opcodes.OP_NOP])]);
            expect(parseEnvelopeScript(junked)).to.equal(null);
        });

        it('never throws on fuzzed bytes', function () {
            for (let i = 0; i < 300; i++) {
                const len = 1 + (i % 90);
                expect(parseEnvelopeScript(crypto.randomBytes(len))).to.equal(null);
            }
            expect(parseEnvelopeScript(null)).to.equal(null);
            expect(parseEnvelopeScript('not a buffer')).to.equal(null);
        });

        it('the standalone leaf hash equals bitcoinjs\'s own merkle root for the single-leaf tree', function () {
            const acct = makeAccount();
            // Both a small script and one past the 65,535-byte compact-size
            // boundary, where a 3-byte prefix would silently corrupt the hash.
            for (const rawLen of [100, 70000]) {
                const script = buildEnvelopeScript(acct.aggKey, ACTION, crypto.randomBytes(rawLen));
                const commit = deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script });
                expect(envelopeLeafHash(script).equals(commit.leafHash)).to.equal(true);
            }
        });

        it('refuses a leaf whose OP_CHECKSIG key is not this account aggregate', function () {
            const acct = makeAccount();
            const foreign = makeAccount();
            const script = buildEnvelopeScript(foreign.aggKey, ACTION, null);
            expect(() => deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script }))
                .to.throw(/different key/);
        });
    });
});

describe('co-signer: Taproot envelope composition', function () {

    describe('delta (c): the action is read from the leaf', function () {
        it('decodes the action a commit output commits to, with no transaction in hand', function () {
            const acct = makeAccount();
            const { script } = commitFor(acct);
            const decoded = decodeEnvelopeAction(script);
            expect(decoded.ok).to.equal(true);
            expect(decoded.action).to.equal('FILE');
            expect(decoded.version).to.equal(0);
            expect(decoded.params.NAME).to.equal('report.bin');
        });

        it('decodes a reveal PSBT through the ordinary decodeActionFromPsbt entry point', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const psbt = buildRevealPsbt(acct, commit);
            const { decodeActionFromPsbt } = require('../../src/cosigner/psbt_action_decode.js');
            const decoded = decodeActionFromPsbt(psbt);
            expect(decoded.ok).to.equal(true);
            expect(decoded.action).to.equal('FILE');
            expect(decoded.actionString).to.equal(ACTION);
            void script;
        });

        it('refuses an envelope mixed with an OP_RETURN carrier (no action on chain)', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const psbt = buildRevealPsbt(acct, commit);
            psbt.addOutput({ script: bitcoin.payments.embed({ data: [Buffer.from('XCHNjunk')] }).output, value: 0 });
            const { decodeActionFromPsbt } = require('../../src/cosigner/psbt_action_decode.js');
            const decoded = decodeActionFromPsbt(psbt);
            expect(decoded.ok).to.equal(false);
            expect(decoded.reason).to.equal('ENVELOPE_MIXED_CARRIER');
        });

        it('refuses an envelope that is not input 0, and two envelope inputs', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const { decodeActionFromPsbt } = require('../../src/cosigner/psbt_action_decode.js');

            const notZero = new bitcoin.Psbt();
            notZero.addInput({ hash: crypto.randomBytes(32), index: 0,
                witnessUtxo: { script: acct.p2trScript, value: 5000 } });
            notZero.addInput({ hash: crypto.randomBytes(32), index: 0,
                witnessUtxo: { script: commit.output, value: 20000 },
                tapInternalKey: acct.aggKey,
                tapLeafScript: [{ leafVersion: LEAF_VERSION, script: commit.script, controlBlock: commit.controlBlock }] });
            notZero.addOutput({ script: acct.p2trScript, value: 20000 });
            expect(decodeActionFromPsbt(notZero).reason).to.equal('ENVELOPE_NOT_INPUT_ZERO');

            const two = buildRevealPsbt(acct, commit);
            two.addInput({ hash: crypto.randomBytes(32), index: 1,
                witnessUtxo: { script: commit.output, value: 20000 },
                tapInternalKey: acct.aggKey,
                tapLeafScript: [{ leafVersion: LEAF_VERSION, script: commit.script, controlBlock: commit.controlBlock }] });
            expect(decodeActionFromPsbt(two).reason).to.equal('MULTI_ENVELOPE');
        });
    });
});

describe('co-signer: Taproot envelope composition', function () {

    describe('role derivation', function () {
        it('classifies commit, reveal and cancel from the PSBT alone', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            expect(classifyEnvelopeRole(buildCommitPsbt(acct, commit), commit)).to.equal('commit');
            expect(classifyEnvelopeRole(buildRevealPsbt(acct, commit), commit)).to.equal('reveal');
            expect(classifyEnvelopeRole(buildCancelPsbt(acct, commit), commit)).to.equal('cancel');
        });

        it('classifies nothing for a transaction that neither funds nor spends the commit', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const unrelated = new bitcoin.Psbt();
            unrelated.addInput({ hash: crypto.randomBytes(32), index: 0,
                witnessUtxo: { script: acct.p2trScript, value: 100000 } });
            unrelated.addOutput({ script: acct.p2trScript, value: 90000 });
            expect(classifyEnvelopeRole(unrelated, commit)).to.equal(null);
        });
    });
});
