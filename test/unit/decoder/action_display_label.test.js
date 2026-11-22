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
 **********************************************************************/
'use strict';

const { expect } = require('chai');
const {
    actionDisplayLabel,
    DISPLAY_MAP,
} = require('../../../src/decoder/action_display_label.js');

describe('decoder.actionDisplayLabel', function () {
    it('returns an empty string for an empty, null, or undefined name', function () {
        for (const name of ['', null, undefined]) {
            expect(actionDisplayLabel(name)).to.equal('');
        }
    });

    it('normalizes case and surrounding whitespace before mapping names', function () {
        expect(actionDisplayLabel('  sEnD ')).to.equal('Send');
        expect(actionDisplayLabel('\tCOINPAY\n')).to.equal('Coin payment');
        expect(actionDisplayLabel(' link ')).to.equal('Cross-chain');
        expect(actionDisplayLabel(' CrossChain ')).to.equal('Cross-chain');
    });

    it('humanizes an unmapped name', function () {
        expect(actionDisplayLabel('some_new-action')).to.equal('Some new action');
    });

    it('defines uppercase keys with non-empty string labels', function () {
        for (const [key, value] of Object.entries(DISPLAY_MAP)) {
            expect(key).to.equal(key.toUpperCase());
            expect(value).to.be.a('string').and.not.equal('');
        }
    });
});
