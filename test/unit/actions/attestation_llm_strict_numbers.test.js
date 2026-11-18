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
 * AttestationHelpers.llm numeric options: only a number or a plain decimal
 * string is a value; null, empty strings, booleans, arrays and hex or
 * exponent strings are refused rather than coerced into a request.
 */

'use strict';

const { expect } = require('chai');
const Attestation = require('../../../src/actions/attestation.js');

const refused = [null, '', ' ', [], [7], true, false, '0x10', '1e3', {}];
const show = (v) => (typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : `${typeof v} ${JSON.stringify(v)}`);

describe('AttestationHelpers.llm strict numeric options', function () {
    for (const value of refused) {
        it(`refuses maxTokens ${show(value)}`, function () {
            expect(() => Attestation.llm({ prompt: 'x', maxTokens: value })).to.throw(/maxTokens/);
        });

        it(`refuses temperature ${show(value)}`, function () {
            expect(() => Attestation.llm({ prompt: 'x', temperature: value })).to.throw(/temperature/);
        });

        it(`refuses envelopeVersion ${show(value)}`, function () {
            expect(() => Attestation.llm({ prompt: 'x', envelopeVersion: value })).to.throw(/envelopeVersion/);
        });
    }

    it('still accepts plain decimal strings for the numeric options', function () {
        const parsed = JSON.parse(Attestation.llm({
            prompt: 'x', maxTokens: '256', temperature: '0.5', envelopeVersion: '1',
        }));
        expect(parsed.max_tokens).to.equal(256);
        expect(parsed.temperature).to.equal(0.5);
        expect(parsed.envelope_version).to.equal(1);
    });

    it('applies the temperature range to a decimal string', function () {
        expect(() => Attestation.llm({ prompt: 'x', temperature: '-0.5' })).to.throw(/\[0, 2\]/);
    });
});
