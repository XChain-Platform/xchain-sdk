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

// serialize() - VERSION is auto-populated

describe('FormatSelector.serialize(): VERSION is auto-populated', function () {

    it('VERSION appears as the first pipe-separated field after the action name', function () {
        const result = FormatSelector.serialize('SEND', 0, {
            TICK: 'TOKEN', AMOUNT: '1', DESTINATION: 'addr1'
        });
        const parts = result.split('|');
        // parts[0] = action name, parts[1] = VERSION value
        expect(parts[0]).to.equal('SEND');
        expect(parts[1]).to.equal('0');
    });

    it('correct version number appears for v1', function () {
        const result = FormatSelector.serialize('ISSUE', 1, { TICK: 'TOKEN' });
        const parts = result.split('|');
        expect(parts[1]).to.equal('1');
    });

    it('correct version number appears for v3', function () {
        // SEND v3 is a repeated-field format, so it is built from LEGS
        const result = FormatSelector.serialize('SEND', 3, {
            LEGS: [{ TICK: 'TOKEN', AMOUNT: '1', DESTINATION: 'addr1' }]
        });
        const parts = result.split('|');
        expect(parts[1]).to.equal('3');
    });

});
