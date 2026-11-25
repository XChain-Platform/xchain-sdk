/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 *
 * XChain Platform SDK - Actions Class Tests
 *
 * A binding VOTE v0 carries CALLBACK_PARAMS as a JSON array on the wire.
 * An array handed to the generic createAction path must be serialized as
 * that JSON array, not String()-flattened to a bare scalar.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { createActions } = require('./helpers/create_actions.js');

function votePayload(callbackParams) {
    return {
        version: 0, tick: 'GOVX', endBlock: 100, options: 'APPROVE,REJECT',
        maxSelections: 1, tallyMode: 'approval', weightMode: 'balance',
        quorum: '0.1', minVoters: 1, question: 'q',
        callbackContract: 5, callbackMethod: 'arm', callbackParams, callbackOn: 'pass'
    };
}

describe('Actions - VOTE callbackParams array reaches the wire as a JSON array', function () {
    let actions;
    beforeEach(function () { actions = createActions(); });

    const build = (cp) => actions.createAction({ action: 'VOTE', params: votePayload(cp) }).actionString;

    it('serializes a one-element array as a JSON array', function () {
        expect(build(['1'])).to.match(/\|arm\|\["1"\]\|pass$/);
    });

    it('gives the same string for a pre-stringified JSON array', function () {
        expect(build('["1"]')).to.equal(build(['1']));
    });

    it('serializes a multi-element array', function () {
        expect(build(['1', '2'])).to.match(/\|arm\|\["1","2"\]\|pass$/);
    });

    it('matches the createPollParams builder path', function () {
        const VoteHelpers = require('../../../../src/actions/vote.js');
        const built = new VoteHelpers().createPollParams(votePayload(['1']));
        const viaBuilder = actions.createAction({ action: 'VOTE', params: built }).actionString;
        expect(build(['1'])).to.equal(viaBuilder);
    });
});
