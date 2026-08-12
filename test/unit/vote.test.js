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
// Unit: VOTE (token-weighted governance) helpers + wrappers. Proves the pure
// builders (sdk.voting.*) encode options/ballots/modes correctly, that the
// raw wrapper serializes them to the VOTE.md wire format, and that the SDK
// exposes the governance surface (sdk.vote, createPoll/castBallot/delegateVote).

const { expect } = require('chai');
const { XChainSDK, VoteHelpers } = require('../../index.js');
const WalletSession = require('../../src/walletSession.js');
const Formats = require('../../src/formats.js');

describe('VOTE governance helpers', function () {
    // compactTickers:false so createAction never reaches the network to resolve
    // ticker names; we assert on serialization only.
    const sdk = new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
    const v = sdk.voting;

    it('exposes the governance surface', function () {
        expect(sdk.voting).to.be.instanceOf(VoteHelpers);
        expect(sdk.vote).to.be.a('function');
        expect(sdk.createPoll).to.be.a('function');
        expect(sdk.castBallot).to.be.a('function');
        expect(sdk.delegateVote).to.be.a('function');
        expect(sdk.clearVoteDelegation).to.be.a('function');
        expect(WalletSession.prototype.vote).to.be.a('function');
    });

    it('exposes the mode enums', function () {
        expect(v.WEIGHT_MODES).to.deep.equal(['balance', 'flat', 'quadratic', 'time_weighted']);
        expect(v.TALLY_MODES).to.deep.equal(['approval', 'split']);
        expect(v.CALLBACK_ON).to.deep.equal(['pass', 'always']);
    });

    describe('createPollParams (v0)', function () {
        it('builds an advisory poll and serializes to the VOTE.md wire form', async function () {
            const p = v.createPollParams({
                tick: 'GOVTOKEN', endBlock: 850000, options: ['YES', 'NO'],
                quorum: '0.2', minVoters: 10, minVoteBalance: '100',
            });
            expect(p.version).to.equal(0);
            expect(p.options).to.equal('YES,NO');
            expect(p.maxSelections).to.equal('1');    // default
            expect(p.tallyMode).to.equal('approval'); // default
            expect(p.weightMode).to.equal('balance'); // default
            const wire = (await sdk.vote(p)).actionString;
            expect(wire).to.equal('VOTE|0|GOVTOKEN|850000|YES,NO|1|approval|balance|0.2|10|100');
        });

        it('accepts a comma-string options list', function () {
            expect(v.createPollParams({ tick: 'G', endBlock: 2, options: 'YES, NO, ABSTAIN' }).options)
                .to.equal('YES,NO,ABSTAIN');
        });

        it('builds a binding poll with callback fields and JSON-encodes callbackParams', function () {
            const p = v.createPollParams({
                tick: 'GOVTOKEN', endBlock: 850000, options: ['YES', 'NO'],
                callbackContract: 42, callbackMethod: 'releaseFunds',
                callbackParams: [1000], callbackOn: 'pass', gasEscrow: '5000',
            });
            expect(p.callbackContract).to.equal('42');
            expect(p.callbackMethod).to.equal('releaseFunds');
            expect(p.callbackParams).to.equal('[1000]');
            expect(p.callbackOn).to.equal('pass');
            expect(p.gasEscrow).to.equal('5000');
        });

        it('carries callbackDelayBlocks (the finalize -> callback timelock) on a binding poll', function () {
            const p = v.createPollParams({
                tick: 'GOVTOKEN', endBlock: 850000, options: ['YES', 'NO'],
                callbackContract: 42, callbackMethod: 'releaseFunds', callbackDelayBlocks: 144,
            });
            expect(p.callbackDelayBlocks).to.equal('144');
            // 0 is a meaningful value (fire in the finalization block itself),
            // so it must survive rather than being dropped as falsy.
            expect(v.createPollParams({
                tick: 'G', endBlock: 1, options: ['A', 'B'],
                callbackContract: 42, callbackMethod: 'm', callbackDelayBlocks: 0,
            }).callbackDelayBlocks).to.equal('0');
        });

        it('ignores callbackDelayBlocks on an advisory poll (no callback contract)', function () {
            const p = v.createPollParams({
                tick: 'G', endBlock: 1, options: ['A', 'B'], callbackDelayBlocks: 144,
            });
            expect(p.callbackDelayBlocks).to.equal(undefined);
        });

        it('enforces the key create-time rules', function () {
            expect(() => v.createPollParams({ endBlock: 1, options: ['A', 'B'] })).to.throw(/tick is required/);
            expect(() => v.createPollParams({ tick: 'G', options: ['A', 'B'] })).to.throw(/endBlock is required/);
            expect(() => v.createPollParams({ tick: 'G', endBlock: 1, options: ['ONLYONE'] })).to.throw(/at least two/);
            expect(() => v.createPollParams({ tick: 'G', endBlock: 1, options: ['A', 'B'], maxSelections: 3 })).to.throw(/maxSelections/);
            expect(() => v.createPollParams({ tick: 'G', endBlock: 1, options: ['A', 'B'], tallyMode: 'ranked' })).to.throw(/tallyMode/);
            expect(() => v.createPollParams({ tick: 'G', endBlock: 1, options: ['A', 'B'], weightMode: 'stake' })).to.throw(/weightMode/);
            expect(() => v.createPollParams({ tick: 'G', endBlock: 1, options: ['A', 'B'], weightMode: 'quadratic' })).to.throw(/minVoteBalance/);
            expect(() => v.createPollParams({ tick: 'G', endBlock: 1, options: ['A', 'B'], quorum: '2' })).to.throw(/quorum/);
            expect(() => v.createPollParams({ tick: 'G', endBlock: 1, options: ['A', 'B'], callbackContract: 42 })).to.throw(/callbackMethod is required/);
            expect(() => v.createPollParams({
                tick: 'G', endBlock: 1, options: ['A', 'B'],
                callbackContract: 42, callbackMethod: 'm', callbackDelayBlocks: -1,
            })).to.throw(/callbackDelayBlocks/);
            expect(() => v.createPollParams({
                tick: 'G', endBlock: 1, options: ['A', 'B'],
                callbackContract: 42, callbackMethod: 'm', callbackDelayBlocks: 1.5,
            })).to.throw(/callbackDelayBlocks/);
        });
    });

    describe('castBallotParams (v1)', function () {
        it('formats every ballot shape', function () {
            expect(v.castBallotParams({ pollRef: 1, ballot: 1 }).ballot).to.equal('1');
            expect(v.castBallotParams({ pollRef: 1, ballot: '0:60,2:40' }).ballot).to.equal('0:60,2:40');
            expect(v.castBallotParams({ pollRef: 1, ballot: [0, 2] }).ballot).to.equal('0,2');
            expect(v.castBallotParams({ pollRef: 1, ballot: [{ option: 0, share: 60 }, { option: 2, share: 40 }] }).ballot).to.equal('0:60,2:40');
            expect(v.castBallotParams({ pollRef: 1, ballot: { 0: 60, 2: 40 } }).ballot).to.equal('0:60,2:40');
        });

        it('serializes a split ballot with memo to the VOTE.md wire form', async function () {
            const p = v.castBallotParams({ pollRef: 307, ballot: [{ option: 0, share: 60 }, { option: 2, share: 40 }], memo: 'funding split' });
            expect((await sdk.vote(p)).actionString).to.equal('VOTE|1|307|0:60,2:40|funding split');
        });

        it('requires pollRef and a non-empty ballot', function () {
            expect(() => v.castBallotParams({ ballot: 0 })).to.throw(/pollRef is required/);
            expect(() => v.castBallotParams({ pollRef: 1 })).to.throw(/ballot is required/);
            expect(() => v.castBallotParams({ pollRef: 1, ballot: [] })).to.throw(/no entries/);
        });
    });

    describe('delegate (v3)', function () {
        it('sets and clears a delegation', async function () {
            expect((await sdk.vote(v.delegateParams({ tick: 'GOVTOKEN', delegateTo: 'mAlice' }))).actionString)
                .to.equal('VOTE|3|GOVTOKEN|mAlice');
            expect((await sdk.vote(v.clearDelegationParams({ tick: 'GOVTOKEN' }))).actionString)
                .to.equal('VOTE|3|GOVTOKEN');
        });

        it('requires a delegate target for a set (clear is separate)', function () {
            expect(() => v.delegateParams({ tick: 'G' })).to.throw(/delegateTo is required/);
            expect(() => v.clearDelegationParams({})).to.throw(/tick is required/);
        });
    });

    // The raw wrapper takes hand-rolled params, so the SDK must refuse the two
    // shapes the indexer is guaranteed to reject: the system-only v2 finalizer,
    // and a v1 ballot missing its anchor fields.
    describe('raw wrapper refuses commands the consumer rejects', function () {
        it('has no v2 finalize format in the authoring map', function () {
            expect(Object.keys(Formats.VOTE).sort()).to.deep.equal(['0', '1', '3']);
        });

        it('refuses to author the system-only v2 finalizer', async function () {
            let err = null;
            try { await sdk.vote({ version: 2, pollRef: '307' }); } catch (e) { err = e; }
            expect(err, 'sdk.vote({version:2}) must not build a command').to.not.equal(null);
            expect(err.code).to.be.oneOf(['VOTE_CONSTRAINT', 'INVALID_VERSION']);
        });

        it('refuses a hand-rolled v1 ballot carrying only POLL_REF', async function () {
            let err = null;
            try { await sdk.vote({ version: 1, pollRef: '307' }); } catch (e) { err = e; }
            expect(err, 'a BALLOT-less v1 must not serialize').to.not.equal(null);
            expect(err.code).to.equal('MISSING_REQUIRED_FIELD');
        });

        it('refuses a POLL_REF-only call that auto-selects the ballot format', async function () {
            let err = null;
            try { await sdk.vote({ pollRef: '307' }); } catch (e) { err = e; }
            expect(err, 'an auto-selected BALLOT-less ballot must not serialize').to.not.equal(null);
            expect(err.code).to.equal('MISSING_REQUIRED_FIELD');
        });
    });
});
