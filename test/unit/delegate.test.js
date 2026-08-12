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
// Unit: DELEGATE (signing-capability rotate/revoke) raw wrapper. Pins the
// PUBLIC surface, which is where the fee is spent: validator.test.js proves
// _validateDelegate's per-version field lists, and this file proves the same
// rules actually reach a caller who goes through sdk.delegate(). VOTE's half of
// the same defect is pinned in vote.test.js.

const { expect } = require('chai');
const { XChainSDK } = require('../../index.js');

describe('DELEGATE raw wrapper refuses commands the consumer rejects', function () {
    // compactTickers:false so createAction never reaches the network to resolve
    // ticker names; we assert on serialization only.
    const sdk = new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
    const PUB = 'a'.repeat(64);

    // The empty payload auto-selects the shortest fitting format, v0, and used to
    // serialize a bare `DELEGATE|0` the indexer refuses as SIGNING_PUBKEY
    // (required), with the miner fee already spent ().
    it('refuses a wholly empty delegate instead of building DELEGATE|0', async function () {
        let err = null;
        try { await sdk.delegate({}); } catch (e) { err = e; }
        expect(err, 'sdk.delegate({}) must not build a command').to.not.equal(null);
        expect(err.code).to.equal('MISSING_REQUIRED_FIELD');
        expect(err.message).to.match(/NEW_SIGNING_PUBKEY/);
    });

    it('refuses a hand-rolled v2 revoke carrying no SIGNING_PUBKEY', async function () {
        let err = null;
        try { await sdk.delegate({ version: 2 }); } catch (e) { err = e; }
        expect(err, 'a pubkey-less v2 must not serialize').to.not.equal(null);
        expect(err.code).to.equal('MISSING_REQUIRED_FIELD');
        expect(err.message).to.match(/SIGNING_PUBKEY/);
    });

    it('refuses a contract-targeted v1 rotate missing its TARGET_CONTRACT_INDEX and TICK', async function () {
        let err = null;
        try { await sdk.delegate({ version: 1, newSigningPubkey: PUB }); } catch (e) { err = e; }
        expect(err, 'an unanchored v1 must not serialize').to.not.equal(null);
        expect(err.code).to.equal('MISSING_REQUIRED_FIELD');
    });

    it('still builds a complete v0 capability rotate', async function () {
        const built = await sdk.delegate({ version: 0, newSigningPubkey: PUB });
        const wire = typeof built === 'string' ? built : (built.actionString || built.command);
        expect(wire).to.equal('DELEGATE|0|' + PUB);
    });
});
