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
const FormatSelector = require('../../../../src/protocol/format_selector.js');

// estimateLength()

describe('FormatSelector.estimateLength()', function () {

    it('returns a positive integer', function () {
        const len = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(len).to.be.a('number');
        expect(len).to.be.greaterThan(0);
        expect(Number.isInteger(len)).to.be.true;
    });

    it('computes correct byte count for SEND v0 with TOKEN/100/addr1', function () {
        // FORMAT: SEND|VERSION|TICK|AMOUNT|DESTINATION|MEMO
        // Serialized (trailing MEMO trimmed): SEND|0|TOKEN|100|addr1
        // estimateLength does NOT trim; it counts all fields including trailing empty ones.
        // Fields: VERSION=0(1), TICK=TOKEN(5), AMOUNT=100(3), DESTINATION=addr1(5), MEMO='empty'(0)
        // Pipes between fields: 4 (one between each of the 5 format fields)
        // action prefix: SEND|(5 chars)
        // total = 5 + 1 + 5 + 3 + 5 + 0 + 4 = 23
        const len = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(len).to.equal(23);
    });

    it('longer field values produce larger estimates', function () {
        const short = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'A', AMOUNT: '1', DESTINATION: 'B'
        });
        const long = FormatSelector.estimateLength('SEND', 0, {
            TICK: 'LONGTOKEN', AMOUNT: '999999999', DESTINATION: 'a_very_long_address_string'
        });
        expect(long).to.be.greaterThan(short);
    });

    it('returns a smaller estimate for a shorter format version', function () {
        // ISSUE v1 (4 fields) vs ISSUE v0 (25 fields) with only TICK populated
        const lenV1 = FormatSelector.estimateLength('ISSUE', 1, { TICK: 'TOKEN' });
        const lenV0 = FormatSelector.estimateLength('ISSUE', 0, { TICK: 'TOKEN' });
        expect(lenV1).to.be.lessThan(lenV0);
    });

    it('is consistent with actual serialized output length (no trailing trim)', function () {
        // estimateLength counts all format slots including trailing empty ones, so it may be
        // >= the trimmed serialized length. Confirm it is at least as large.
        const fields = { TICK: 'TOKEN', AMOUNT: '50', DESTINATION: 'addr1' };
        const estimated = FormatSelector.estimateLength('SEND', 0, fields);
        const serialized = FormatSelector.serialize('SEND', 0, fields);
        expect(estimated).to.be.at.least(serialized.length);
    });

});
