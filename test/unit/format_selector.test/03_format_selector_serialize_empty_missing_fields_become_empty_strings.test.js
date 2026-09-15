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
 * XChain Platform SDK - FormatSelector Tests
 *
 * Comprehensive Mocha + Chai test suite for the FormatSelector class.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const FormatSelector = require('../../../src/protocol/format_selector.js');

// serialize() - empty / missing fields become empty strings between pipes

describe('FormatSelector.serialize(): empty / missing fields become empty strings', function () {

    it('ORDER v0 with GIVE_TICK and GET_TICK but no GIVE_COIN produces empty segment for GIVE_COIN', function () {
        // v0: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
        const result = FormatSelector.serialize('ORDER', 0, {
            GIVE_TICK: 'TOK1',
            GET_TICK: 'TOK2'
        });
        const parts = result.split('|');
        // parts[0]=ORDER, parts[1]=0, parts[2]=GIVE_COIN, parts[3]=GIVE_TICK, parts[4]=GIVE_AMOUNT, parts[5]=GIVE_OWNERSHIP, parts[6]=GET_COIN, parts[7]=GET_TICK
        expect(parts[2]).to.equal('');      // GIVE_COIN is empty
        expect(parts[3]).to.equal('TOK1'); // GIVE_TICK is present
        expect(parts[4]).to.equal('');      // GIVE_AMOUNT is empty
        expect(parts[5]).to.equal('');      // GIVE_OWNERSHIP is empty
        expect(parts[6]).to.equal('');      // GET_COIN is empty
        expect(parts[7]).to.equal('TOK2'); // GET_TICK is present
    });

    it('undefined field becomes empty string', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: undefined, DESTINATION: 'addr1'
        });
        const parts = result.split('|');
        // parts: SEND|0|TOKEN||addr1
        expect(parts[3]).to.equal(''); // AMOUNT is undefined → empty string
        expect(parts[4]).to.equal('addr1');
    });

    it('null field becomes empty string', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: null, DESTINATION: 'addr1'
        });
        const parts = result.split('|');
        expect(parts[3]).to.equal(''); // AMOUNT is null → empty string
    });

});
