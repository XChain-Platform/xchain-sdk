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
 * Pins the src/cosigner/co_signer.js header to the decoder: every rest-field
 * format the decoder admits is named there, so an operator reading the header
 * learns which actions can reach policy at all.
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const { expect } = require('chai');

const { BOUNDED_REST_FORMATS } = require('../../../src/cosigner/psbt_action_decode.js');

// The leading block comment of co_signer.js, up to its first close.
function header() {
    const source = fs.readFileSync(path.join(__dirname, '../../../src/cosigner/co_signer.js'), 'utf8');
    return source.slice(0, source.indexOf('*/'));
}

describe('co_signer.js header names the decoder scope', () => {
    it('names every bounded rest-field format the decoder admits', () => {
        const keys = [...BOUNDED_REST_FORMATS.keys()];
        expect(keys).to.not.be.empty;
        for (const key of keys) {
            const [action, version] = key.split(' ');
            expect(header(), `co_signer.js header must name ${action} v${version}, which the decoder admits`)
                .to.include(`${action} v${version}`);
        }
    });

    it('points readers at BOUNDED_REST_FORMATS and drops the old refused-at-decode claim', () => {
        expect(header()).to.include('BOUNDED_REST_FORMATS');
        expect(header()).to.not.include("outside this co-signer's decodable");
    });
});
