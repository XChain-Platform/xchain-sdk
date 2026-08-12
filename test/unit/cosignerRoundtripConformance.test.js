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
// Pins the co-signer's PSBT decode path to the SHARED encoder<->decoder
// roundtrip-conformance fixture.
//
// psbtActionDecode.js re-declares the carrier constants (the XCHN magic word,
// the p2sh/p2wsh two-phase tags and the AES-128-CTR key/IV derivation) because
// the authoritative decoder is service-bound and cannot be imported. Until now
// that mirror was held together only by a comment: every other wire-format
// consumer sits behind the roundtrip fixture, but the co-signer did not, so a
// derivation change the fixture catches everywhere else would have broken
// hardware co-signer decode silently.
//
// The fixture carries encoder-produced BYTES (obfuscated OP_RETURN payloads and
// the first-input txid that keys them). Decoding those bytes through this
// module exercises the whole carrier chain end to end: change the magic word,
// the tags or either key/IV offset upstream, regenerate the fixture, and these
// cases stop decoding here.

const { expect } = require('chai');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const {
    decodeActionFromPsbt, decodeActionStringFromPsbt,
    MAGIC_WORD, P2SH_TAG, P2WSH_TAG, OBFUSCATION,
} = require('../../src/cosigner/psbtActionDecode.js');

const VENDORED = path.join(__dirname, '..', 'fixtures', 'roundtrip-conformance.json');
const fixture  = require('../fixtures/roundtrip-conformance.json');

// A PSBT whose first input is the fixture's keying txid and whose single
// OP_RETURN carries the fixture's encoder-produced payload bytes verbatim.
function psbtForPayload(firstInputTxid, payloadHex) {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: Buffer.from(firstInputTxid, 'hex').reverse(), index: 0 });
    psbt.addOutput({
        script: bitcoin.payments.embed({ data: [Buffer.from(payloadHex, 'hex')] }).output,
        value:  0,
    });
    return psbt;
}

// Recover the pre-obfuscation payload using the module's OWN declared
// derivation, so the drift sentinels below mutate exactly what the shipped code
// reads rather than a second copy of the offsets.
function plaintextOf(c) {
    const key = c.firstInputTxid.substr(OBFUSCATION.keyOffset, OBFUSCATION.keyLength);
    const iv  = c.firstInputTxid.substr(OBFUSCATION.ivOffset,  OBFUSCATION.ivLength);
    const d   = crypto.createDecipheriv(OBFUSCATION.algorithm, key, iv);
    return Buffer.concat([d.update(Buffer.from(c.obfuscatedOpReturnHex, 'hex')), d.final()]);
}

function obfuscateWith(plain, txidHex, keyOffset, ivOffset) {
    const c = crypto.createCipheriv(OBFUSCATION.algorithm,
        txidHex.substr(keyOffset, OBFUSCATION.keyLength),
        txidHex.substr(ivOffset,  OBFUSCATION.ivLength));
    return Buffer.concat([c.update(plain), c.final()]);
}

const opReturnCases = fixture.cases.filter(c => c.encoding === 'OP_RETURN');
const acceptedCases = opReturnCases.filter(c => c.expected.gate === 'accepted');
const droppedCases  = opReturnCases.filter(c => c.expected.gate === 'dropped');

describe('co-signer PSBT decode vs the shared roundtrip-conformance fixture', function () {

    it('the fixture actually carries the OP_RETURN shapes this guard needs', function () {
        // Guards the guard: a regenerated fixture that lost its inline cases
        // would otherwise turn this whole suite into a green no-op.
        expect(acceptedCases.length).to.be.greaterThan(0);
        expect(droppedCases.length).to.be.greaterThan(0);
        expect(fixture.aliasCases.length).to.be.greaterThan(0);
        expect(fixture.p2shCases.length).to.be.greaterThan(0);
    });

    it('the magic word matches the one the fixture was generated with', function () {
        expect(MAGIC_WORD.toString('utf8')).to.equal(fixture.magicWord);
    });

    // The carrier chain, driven by encoder-produced bytes.

    for (const c of acceptedCases) {
        it(`decodes the encoder's bytes for: ${c.name}`, function () {
            const r = decodeActionStringFromPsbt(psbtForPayload(c.firstInputTxid, c.obfuscatedOpReturnHex));
            expect(r.ok, `refused with ${r.reason}`).to.equal(true);
            expect(r.actionString).to.equal(Buffer.from(c.expected.dataHex, 'hex').toString('utf8'));
        });
    }

    for (const c of droppedCases) {
        it(`fails closed on the shape the arbiter drops: ${c.name}`, function () {
            // The arbiter yields no action for these, so the only safe co-signer
            // answer is a refusal; returning an action here would let a payload
            // pass policy that the chain never executes as that action.
            const r = decodeActionStringFromPsbt(psbtForPayload(c.firstInputTxid, c.obfuscatedOpReturnHex));
            expect(r.ok).to.equal(false);
        });
    }

    for (const c of fixture.aliasCases) {
        it(`resolves the on-chain alias the arbiter rewrites: ${c.name}`, function () {
            const r = decodeActionFromPsbt(psbtForPayload(c.firstInputTxid, c.obfuscatedOpReturnHex));
            expect(r.ok, `refused with ${r.reason}`).to.equal(true);
            expect(r.actionString).to.equal(Buffer.from(c.expected.dataHex, 'hex').toString('utf8'));
            // Policy is evaluated on the canonical name, exactly as the arbiter
            // rewrites it.
            expect(r.action).to.equal(c.expected.actionName);
        });
    }

    for (const c of fixture.p2shCases) {
        it(`refuses the two-phase marker (params are not in this PSBT): ${c.name}`, function () {
            // Pins P2SH_TAG / P2WSH_TAG against the encoder's real marker bytes.
            const r = decodeActionStringFromPsbt(psbtForPayload(c.firstInputTxid, c.markerOpReturnHex));
            expect(r.ok).to.equal(false);
            expect(r.reason).to.equal('P2SH_P2WSH_UNSUPPORTED');
        });
    }

    it('the two-phase tags are the ones the fixture markers carry', function () {
        const marker = plaintextOf({
            firstInputTxid:        fixture.p2shCases[0].firstInputTxid,
            obfuscatedOpReturnHex: fixture.p2shCases[0].markerOpReturnHex,
        }).subarray(MAGIC_WORD.length);
        expect(marker.equals(P2SH_TAG) || marker.equals(P2WSH_TAG)).to.equal(true);
    });

    // Derivation-drift sentinels.

    describe('drift sentinels', function () {
        const sample = acceptedCases[0];

        it('positive control: re-obfuscating with the declared derivation still decodes', function () {
            const payload = obfuscateWith(plaintextOf(sample), sample.firstInputTxid,
                OBFUSCATION.keyOffset, OBFUSCATION.ivOffset);
            const r = decodeActionStringFromPsbt(psbtForPayload(sample.firstInputTxid, payload.toString('hex')));
            expect(r.ok).to.equal(true);
            expect(r.actionString).to.equal(Buffer.from(sample.expected.dataHex, 'hex').toString('utf8'));
        });

        it('refuses a payload keyed off a shifted KEY offset', function () {
            const payload = obfuscateWith(plaintextOf(sample), sample.firstInputTxid,
                OBFUSCATION.keyOffset + 1, OBFUSCATION.ivOffset);
            const r = decodeActionStringFromPsbt(psbtForPayload(sample.firstInputTxid, payload.toString('hex')));
            expect(r.ok).to.equal(false);
            expect(r.reason).to.equal('NO_MAGIC_WORD');
        });

        it('refuses a payload keyed off a shifted IV offset', function () {
            const payload = obfuscateWith(plaintextOf(sample), sample.firstInputTxid,
                OBFUSCATION.keyOffset, OBFUSCATION.ivOffset + 1);
            const r = decodeActionStringFromPsbt(psbtForPayload(sample.firstInputTxid, payload.toString('hex')));
            expect(r.ok).to.equal(false);
            expect(r.reason).to.equal('NO_MAGIC_WORD');
        });

        it('refuses a payload carrying a different magic word', function () {
            const plain = plaintextOf(sample);
            const drifted = Buffer.concat([Buffer.from('XCHZ'), plain.subarray(MAGIC_WORD.length)]);
            const payload = obfuscateWith(drifted, sample.firstInputTxid,
                OBFUSCATION.keyOffset, OBFUSCATION.ivOffset);
            const r = decodeActionStringFromPsbt(psbtForPayload(sample.firstInputTxid, payload.toString('hex')));
            expect(r.ok).to.equal(false);
            expect(r.reason).to.equal('NO_MAGIC_WORD');
        });

        it('the obfuscation descriptor still describes a full AES-128 key and IV', function () {
            expect(OBFUSCATION.algorithm).to.equal('aes-128-ctr');
            expect(OBFUSCATION.keyLength).to.equal(16);
            expect(OBFUSCATION.ivLength).to.equal(16);
        });
    });
});

// IDENTITY: the vendored copy must match the canonical encoder fixture (skip
// when the sibling xchain-encoder is not checked out, matching the
// ActionManifestConformance / decoder roundtrip convention; hard-fail under
// XCHAIN_REQUIRE_SIBLINGS=1 so CI can never quietly lose the coverage).
describe('roundtrip conformance fixture: byte-identity to encoder original', function () {
    const ENCODER = process.env.XCHAIN_ENCODER_DIR
        || path.join(__dirname, '..', '..', '..', 'xchain-encoder');
    const CANON = path.join(ENCODER, 'test', 'fixtures', 'roundtrip-conformance.json');

    before(function () {
        if (!fs.existsSync(CANON)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical roundtrip-conformance.json not found at ' + CANON);
            this.skip();
        }
    });

    it('vendored test/fixtures/roundtrip-conformance.json is byte-identical to the encoder original', function () {
        expect(fs.readFileSync(VENDORED, 'utf8')).to.equal(fs.readFileSync(CANON, 'utf8'),
            'vendored roundtrip-conformance.json drifted from the encoder original; ' +
            're-run the encoder fixture generator and re-vendor the copy here.');
    });
});
