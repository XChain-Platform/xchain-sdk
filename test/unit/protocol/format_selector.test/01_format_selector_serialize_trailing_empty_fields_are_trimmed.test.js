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

// serialize() - trailing empty fields are trimmed

describe('FormatSelector.serialize(): trailing empty fields are trimmed', function () {

    it('SEND v0 without MEMO has no trailing pipe', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(result).to.equal('SEND|0|TOKEN|100|addr1');
        expect(result.endsWith('|')).to.be.false;
    });

    it('SWEEP v0 with only DESTINATION trims trailing empty fields', function () {
        // v0: VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO
        // All flags and MEMO are empty → trimmed
        const result = FormatSelector.serialize('SWEEP', 0, { DESTINATION: 'myaddr' });
        expect(result).to.equal('SWEEP|0|myaddr');
        expect(result.endsWith('|')).to.be.false;
    });

    it('BROADCAST v0 with only MESSAGE trims empty VALUE', function () {
        // v0: VERSION|MESSAGE|VALUE (VALUE is empty and trailing, so trimmed)
        const result = FormatSelector.serialize('BROADCAST', 0, { MESSAGE: 'ping' });
        expect(result).to.equal('BROADCAST|0|ping');
    });

    it('does not trim fields that are empty but not trailing', function () {
        // SLEEP v1: VERSION|RESUME_BLOCK|TICK|MEMO
        // If RESUME_BLOCK is provided and TICK is empty but MEMO is provided,
        // TICK must appear as an empty segment between them.
        const result = FormatSelector.serialize('SLEEP', 1, {
            RESUME_BLOCK: '800000', TICK: '', MEMO: 'wake up'
        });
        expect(result).to.equal('SLEEP|1|800000||wake up');
    });

});
