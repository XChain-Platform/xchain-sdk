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

// Split like the encoder does: sequential slices of the payload.
function build(action, encoding, chunkSize) {
    const data = Buffer.from(action, 'utf8');
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
