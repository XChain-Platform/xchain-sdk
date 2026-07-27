'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Carrier-script verification (spec §5.3.2). The fixtures build redeem
// scripts the SAME way XChainEncoder does (leading data push + the P2PKH
// spend gate), so a change to that shape shows up here rather than only on
// a live chain.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const { verifyCarrierScripts, REASONS } = require('../../../src/carrier/verifyCarrierScripts.js');

const NET = bitcoin.networks.bitcoin;
const H160 = Buffer.alloc(20, 0xab); // stand-in for the caller HASH160

// Mirrors XChainEncoder's compile: <chunk> OP_DROP OP_DUP OP_HASH160
// <hash160> OP_EQUALVERIFY OP_CHECKSIG.
function redeemFor(chunk) {
    return bitcoin.script.compile([
        chunk,
        bitcoin.opcodes.OP_DROP,
        bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160,
        H160,
        bitcoin.opcodes.OP_EQUALVERIFY,
        bitcoin.opcodes.OP_CHECKSIG,
    ]);
}

function committed(encoding, redeem) {
    return encoding === 'P2SH'
        ? bitcoin.payments.p2sh({ redeem: { output: redeem }, network: NET }).output
        : bitcoin.payments.p2wsh({ redeem: { output: redeem }, network: NET }).output;
}

// A PSBT carrying the given output scripts, plus an unrelated payment output
// so the matcher has to actually find the right one.
function psbtWith(scripts) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({
        hash: Buffer.alloc(32, 0x11),
        index: 0,
        witnessUtxo: { script: bitcoin.payments.p2wpkh({ hash: H160, network: NET }).output, value: 100000 },
    });
    scripts.forEach(s => psbt.addOutput({ script: s, value: 1000 }));
    psbt.addOutput({ script: bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xcd), network: NET }).output, value: 500 });
    return psbt;
}

// The bytes the encoder actually chunks: the COMPILED payload, not the bare
// action. XChainEncoder.prepareData is handed `script.compile([action])` and
// slices that, so every chunked payload carries a push prefix (0x4c 0x9a ahead
// of a 154-byte action) and the decoder strips it by decompiling the
// reassembly. These fixtures used to slice the raw action string, which the
// encoder never emits - so they agreed with a verifier that could not accept a
// single real transaction .
function compiledPayload(action) {
    return bitcoin.script.compile([Buffer.from(action, 'utf8')]);
}

// Split like the encoder does: sequential slices of the payload.
function build(action, encoding, chunkSize) {
    const data = compiledPayload(action);
    const chunks = [];
    for (let i = 0; i < data.length; i += chunkSize) chunks.push(data.subarray(i, i + chunkSize));
    const redeems = chunks.map(redeemFor);
    return {
        carrierScripts: redeems.map(r => r.toString('hex')),
        psbt: psbtWith(redeems.map(r => committed(encoding, r))),
    };
}

describe('carrier-script verification (§5.3.2)', function () {

    const ACTION = 'ISSUE|0|LONGTICK|1000000|1000000|8|a description long enough to need chunking across several outputs';

    ['P2SH', 'P2WSH'].forEach(encoding => {

        describe(encoding, function () {

            it('accepts scripts that are committed AND carry the intended action', function () {
                const { carrierScripts, psbt } = build(ACTION, encoding, 20);
                const r = verifyCarrierScripts({ psbt, carrierScripts, encoding, actionString: ACTION, network: NET });
                expect(r.ok).to.equal(true);
                expect(r.checked).to.be.greaterThan(1); // genuinely multi-chunk
            });

            // Check 2 with check 1 held valid: the script IS committed in the
            // PSBT, but carries a different payload than the caller asked for.
            // This is the substitution the whole section exists to catch.
            it('REJECTS a committed script whose payload is not what was asked for', function () {
                const evil = 'SEND|0|XCHAIN|9999999|bc1qattackeraddressgoeshere00000000000000';
                const { carrierScripts, psbt } = build(evil, encoding, 20);
                const r = verifyCarrierScripts({ psbt, carrierScripts, encoding, actionString: ACTION, network: NET });
                expect(r.ok).to.equal(false);
                expect(r.reason).to.equal(REASONS.PAYLOAD_MISMATCH);
            });

            // Check 1 with check 2 held valid: the payload is exactly right,
            // but the script is not one the PSBT commits to, so signing it
            // would put different bytes on chain than were verified.
            it('REJECTS a correct payload in a script the PSBT does not commit to', function () {
                const { carrierScripts } = build(ACTION, encoding, 20);
                const { psbt } = build(ACTION, encoding, 25); // same action, different chunking
                const r = verifyCarrierScripts({ psbt, carrierScripts, encoding, actionString: ACTION, network: NET });
                expect(r.ok).to.equal(false);
                expect(r.reason).to.equal(REASONS.OUTPUT_NOT_FOUND);
            });

            // Fail closed. An encoder that does not return scripts is the
            // exact pre-§5.3.2 situation, and treating "cannot verify" as a
            // pass would silently restore the residual trust.
            it('FAILS CLOSED when the encoder returned no scripts', function () {
                const { psbt } = build(ACTION, encoding, 20);
                const r = verifyCarrierScripts({ psbt, carrierScripts: [], encoding, actionString: ACTION, network: NET });
                expect(r.ok).to.equal(false);
                expect(r.reason).to.equal(REASONS.SCRIPTS_MISSING);
            });

            it('rejects a malformed script rather than skipping it', function () {
                const { psbt } = build(ACTION, encoding, 20);
                const r = verifyCarrierScripts({ psbt, carrierScripts: ['not-hex-at-all'], encoding, actionString: ACTION, network: NET });
                expect(r.ok).to.equal(false);
                expect(r.reason).to.be.oneOf([REASONS.SCRIPT_UNPARSEABLE, REASONS.OUTPUT_NOT_FOUND]);
            });
        });
    });

    // : the shape a real encoder emits, pinned end to end.
    //
    // Observed on the BTC regtest stack for a three-recipient SEND: 154 action
    // bytes, one P2SH carrier, and a redeem script whose leading push is 156
    // bytes - `4c 9a` (OP_PUSHDATA1, length 154) followed by the action. The
    // verifier called that PAYLOAD_MISMATCH and the wallet's confirm surface
    // refused to open. Written as an explicit single-chunk case rather than
    // trusting the shared builder, so the framing this regression is about
    // cannot quietly change with it.
    it('accepts the OP_PUSHDATA1 framing a real chunked action arrives in', function () {
        const action = 'SEND|1|XCHAIN|7|bcrt1qfdh24fmqxd23pax659t92hul2c5spj7jwele5q'
            + '|3|bcrt1q58r83tq8r0mjsam2q45pvfqwk2d3krqk7fx5yp'
            + '|1|bcrt1q9nf3v7qk5nf80lw9pwd262uta4xd4dx0yh8s28';
        const compiled = compiledPayload(action);
        expect(compiled.length).to.equal(action.length + 2);
        expect(compiled[0]).to.equal(0x4c);
        expect(compiled[1]).to.equal(action.length);

        const redeem = redeemFor(compiled);
        const psbt = psbtWith([committed('P2SH', redeem)]);
        const r = verifyCarrierScripts({
            psbt, carrierScripts: [redeem.toString('hex')], encoding: 'P2SH', actionString: action, network: NET,
        });
        expect(r.ok).to.equal(true);
        expect(r.checked).to.equal(1);
    });

    // The mirror image, and the reason the old fixtures passed against a
    // verifier no real transaction could satisfy: bytes that are the bare
    // action with no push framing are not what the chain would read back, so
    // they must not verify as the action either.
    it('REJECTS an unframed payload, which the decoder would not read as this action', function () {
        const action = 'BROADCAST|0|hello world, at length, so the lane is genuinely chunked past one push';
        const redeem = redeemFor(Buffer.from(action, 'utf8'));
        const psbt = psbtWith([committed('P2SH', redeem)]);
        const r = verifyCarrierScripts({
            psbt, carrierScripts: [redeem.toString('hex')], encoding: 'P2SH', actionString: action, network: NET,
        });
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal(REASONS.PAYLOAD_MISMATCH);
    });

    // The wallet passes PSBT HEX across its host messaging boundary, so the
    // verifier must accept that shape and not only a live bitcoinjs object.
    it('accepts the PSBT as hex, the shape that crosses the host boundary', function () {
        const { carrierScripts, psbt } = build(ACTION, 'P2WSH', 20);
        const r = verifyCarrierScripts({ psbt: psbt.toHex(), carrierScripts, encoding: 'P2WSH', actionString: ACTION, network: NET });
        expect(r.ok).to.equal(true);
    });

    // Inline OP_RETURN keeps its own cross-check (decodeActionFromPsbt); this
    // verifier must not claim to have checked anything there.
    it('reports NOT_CHUNKED for OP_RETURN instead of pretending to verify', function () {
        const { psbt } = build(ACTION, 'P2WSH', 20);
        const r = verifyCarrierScripts({ psbt, carrierScripts: [], encoding: 'OP_RETURN', actionString: ACTION, network: NET });
        expect(r.ok).to.equal(true);
        expect(r.reason).to.equal(REASONS.NOT_CHUNKED);
        expect(r.checked).to.equal(0);
    });
});
