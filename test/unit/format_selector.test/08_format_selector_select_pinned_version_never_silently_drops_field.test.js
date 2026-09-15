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
const { SDKFormatError } = require('../../../src/utils/errors.js');

// #3918: a PINNED version obeys the same no-data-loss rule as auto-selection.
// STAKE v3 alone carries TARGET_CONTRACT_INDEX|TICK; pinning v1 without this guard
// would serialize those routing fields away and stake to the wrong destination, silently.

describe('FormatSelector.select(): a pinned version never silently drops a field (#3918)', function () {

    const STAKE_ROUTED = {
        AMOUNT: '100', SIGNING_PUBKEY: 'aa'.repeat(32),
        TARGET_CONTRACT_INDEX: '42', TICK: 'XCHAIN',
    };

    it('STAKE v1 has no slot for TARGET_CONTRACT_INDEX/TICK, so pinning it throws', function () {
        expect(() => FormatSelector.select('STAKE', STAKE_ROUTED, 1))
            .to.throw(SDKFormatError, /has no slot for/);
    });

    it('the error is NO_MATCHING_FORMAT and names the dropped fields in its detail', function () {
        try {
            FormatSelector.select('STAKE', STAKE_ROUTED, 1);
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.code).to.equal('NO_MATCHING_FORMAT');
            expect(e.details.userFieldsNotInFormat).to.include('TARGET_CONTRACT_INDEX');
            expect(e.details.userFieldsNotInFormat).to.include('TICK');
            expect(e.details.version).to.equal(1);
        }
    });

    it('UNSTAKE v0 is the same shape of defect and throws too', function () {
        expect(() => FormatSelector.select('UNSTAKE', {
            AMOUNT: '5', SIGNING_PUBKEY: 'bb'.repeat(32),
            TARGET_CONTRACT_INDEX: '7', TICK: 'XCHAIN',
        }, 0)).to.throw(SDKFormatError, /has no slot for/);
    });

    it('STAKE v1 and v2 (identical field lists) still both select for a fitting payload', function () {
        const fitting = { AMOUNT: '100', SIGNING_PUBKEY: 'aa'.repeat(32) };
        expect(FormatSelector.select('STAKE', fitting, 1).version).to.equal(1);
        expect(FormatSelector.select('STAKE', fitting, 2).version).to.equal(2);
    });

    it('auto-selection (no pin) still finds STAKE v3 for the routed payload', function () {
        expect(FormatSelector.select('STAKE', STAKE_ROUTED).version).to.equal(3);
    });
});
