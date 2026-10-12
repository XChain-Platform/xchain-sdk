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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { seg } = require('../../../../src/clients/explorer/path_segment.js');

const FREE_TEXT_TICK = '$$$$$$$$$$$78324%@##*(@#';
const VALUES = ['SAT', 12, FREE_TEXT_TICK, 'one/two three', undefined, null];

describe('explorer path segment', function () {
    it('returns plain ticks and numbers as strings', function () {
        expect(seg('SAT')).to.equal('SAT');
        expect(seg(12)).to.equal('12');
    });

    it('percent-encodes reserved characters in a free-text tick', function () {
        const encoded = seg(FREE_TEXT_TICK);
        expect(encoded).to.include('%24').and.include('%25');
        expect(encoded).to.include('%40').and.include('%23');
        expect(encoded).to.not.include('$').and.not.include('%@').and.not.include('#');
    });

    it('keeps slashes and spaces within one path segment', function () {
        expect(seg('one/two three')).to.equal('one%2Ftwo%20three');
    });

    it('stringifies nullish values', function () {
        expect(seg(undefined)).to.equal('undefined');
        expect(seg(null)).to.equal('null');
    });

    it('round-trips every supported input through URI decoding', function () {
        for (const value of VALUES) {
            expect(decodeURIComponent(seg(value))).to.equal(String(value));
        }
    });
});
