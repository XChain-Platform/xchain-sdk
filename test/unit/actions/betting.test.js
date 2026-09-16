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
// BET (parimutuel betting) SDK surface.
//
// Two things are under test and they fail differently. The COMPOSE half must put
// exactly the right bytes in exactly the right slots: BET has three formats that
// all lead with FEED_ACTION_INDEX and differ only by which trailing fields are
// present, so a resolve with a stray AMOUNT silently becomes a place-bet, and a
// place-bet with no OUTCOME silently becomes a cancel. The VALIDATE half must
// reject every §6 violation client-side, because the alternative is paying a fee
// to be rejected on-chain, and it must reject NOTHING consensus accepts, because
// that blocks legitimate markets with no recourse.

const { expect } = require('chai');
const formats = require('../../../src/protocol/formats.js');

describe('BET formats', function () {

    it('registers all four formats with the field order BET.md declares', function () {
        expect(formats.BET[0]).to.equal(
            'VERSION|LABEL|OUTCOMES|TICK|FEE|DEADLINE|REFUND_WINDOW|MIN_AMOUNT|ALLOW_LIST|BLOCK_LIST|DETAILS|MEMO');
        expect(formats.BET[1]).to.equal('VERSION|FEED_ACTION_INDEX|MEMO');
        expect(formats.BET[2]).to.equal('VERSION|FEED_ACTION_INDEX|OUTCOME|AMOUNT|MEMO');
        expect(formats.BET[3]).to.equal('VERSION|FEED_ACTION_INDEX|OUTCOME|MEMO');
    });

    it('has no edit format: markets are immutable from creation', function () {
        // Reinstating one would reopen the first-bettor edit race, which is why
        // the whole FEED_HASH apparatus was cut. If a v4 appears, that decision
        // is being reversed and the spec needs revisiting first.
        expect(Object.keys(formats.BET)).to.deep.equal(['0', '1', '2', '3']);
    });

});
