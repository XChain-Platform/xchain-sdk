/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform SDK - ORDER and DISPENSER coin-field regression
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Actions = require('../../../src/actions/index.js');
const Utility = require('../../../src/utils/utility.js');

function create(action, params) {
    const actions = new Actions({
        config: {},
        util: new Utility(),
        options: { network: 'bitcoin-mainnet' }
    });
    return actions.createAction({ action, params });
}

function expectEmptyCoinSlots(result, giveCoinIndex, getCoinIndex) {
    const parts = result.actionString.split('|');
    expect(parts[giveCoinIndex]).to.equal('');
    expect(parts[getCoinIndex]).to.equal('');
    expect(result.fields).not.to.have.property('GIVE_COIN');
    expect(result.fields).not.to.have.property('GET_COIN');
}

describe('ORDER and DISPENSER omitted coin fields', function () {
    it('leaves both ORDER v0 coin slots empty for a token-to-token create', function () {
        const result = create('ORDER', {
            giveTick: 'ALPHA',
            giveAmount: '10',
            getTick: 'BETA',
            getAmount: '20'
        });

        expect(result.version).to.equal(0);
        expect(result.actionString).to.equal('ORDER|0||ALPHA|10|||BETA|20');
        expectEmptyCoinSlots(result, 2, 6);
    });

    it('leaves both DISPENSER v0 coin slots empty for a token-priced create', function () {
        const result = create('DISPENSER', {
            giveTick: 'ALPHA',
            giveAmount: '10',
            giveEscrow: '100',
            getTick: 'BETA',
            getAmount: '20'
        });

        expect(result.version).to.equal(0);
        expect(result.actionString).to.equal('DISPENSER|0||ALPHA|10||100||BETA|20');
        expectEmptyCoinSlots(result, 2, 7);
    });
});
