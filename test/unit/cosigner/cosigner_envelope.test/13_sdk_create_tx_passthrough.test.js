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
} = require('./helpers/support.js');

// The SDK must be able to REACH the encoder's new surface. It does
// not default to it (AUTO can return a commit/reveal pair where callers expect
// one PSBT, so that flip belongs to a major version), but a caller that wants
// the smallest footprint, or wants to opt out of compression, must be able to
// say so through the SDK rather than dropping to raw JSON-RPC.
describe('SDK create_tx passthrough', function () {
    const EncoderClient = require('../../../../src/clients/encoder.js');

    function clientCapturing(captured) {
        // A real client with only the transport replaced, so the parameter
        // mapping under test is the shipped one.
        const enc = new EncoderClient({});
        enc.rpc = async (method, params) => {
            captured.method = method; captured.params = params;
            return { psbt: 'aa', encoding: 'P2WSH' };
        };
        return enc;
    }

    it('forwards encoding AUTO, compress and the options bag', async function () {
        const captured = {};
        const enc = clientCapturing(captured);
        await enc.createTx({
            pubkey: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef',
            data: 'FILE|0|a.log|text/plain',
            encoding: 'auto',
            compress: false,
            options: { signerSupportsTapscript: true },
        });
        expect(captured.params.encoding).to.equal('AUTO');
        expect(captured.params.compress).to.equal(false);
        expect(captured.params.options).to.deep.equal({ signerSupportsTapscript: true });
    });

    it('omits all three when the caller says nothing, so the encoder default applies', async function () {
        const captured = {};
        const enc = clientCapturing(captured);
        await enc.createTx({
            pubkey: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef',
            data: 'FILE|0|a.log|text/plain',
        });
        expect(captured.params).to.not.have.property('compress');
        expect(captured.params).to.not.have.property('options');
        expect(captured.params).to.not.have.property('encoding');
    });
});
