// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const { XChainSDK } = require('../../../../index.js');
const { parse } = require('../../../../src/decoder/index.js');

describe('BET FEE width matches the indexer column', function () {
    const sdk = new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
    const rawFeeFindings = (fee) => parse(`BET|0|Market|Yes,No|JDOG|${fee}|2000000000`)
        .validation.findings.filter((f) => f.details.field === 'FEE');

    it('a raw action string accepts an 11-character FEE and refuses a 12-character one', function () {
        expect(rawFeeFindings('00000005.50')).to.have.length(0);
        const refused = rawFeeFindings('000000005.50');
        expect(refused).to.have.length(1);
        expect(refused[0].message).to.include('at most 11 characters');
        expect(rawFeeFindings('000000000005')).to.have.length(1);
    });

    it('keeps the format and range refusals ahead of the width rule', function () {
        expect(rawFeeFindings('1.005')[0].message).to.include('2 decimal places');
        expect(rawFeeFindings('99')[0].message).to.include('at most 10 percent');
    });

    it('the compose path canonicalizes a padded FEE, so it never reaches the wire padded', function () {
        const compose = (fee) => sdk.actions.composeActionString({
            action: 'BET',
            params: { label: 'x y', outcomes: 'A,B', tick: 'PEPECASH', deadline: '1770000000', fee }
        }).actionString;
        expect(compose('000000005.50')).to.equal('BET|0|x y|A,B|PEPECASH|5.5|1770000000');
        expect(compose('0000000000005')).to.equal('BET|0|x y|A,B|PEPECASH|5|1770000000');
    });
});
