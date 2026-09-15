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
const { XChainSDK } = require('../../../index.js');

const DEADLINE = 1770000000;

function sdk() {
    // compactTickers:false keeps createAction off the network.
    return new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
}

describe('BET action-level validation', function () {

    it('accepts a well-formed create and rejects the documented violations', function () {
        const s = sdk();
        const base = {
            label: 'Superbowl LX winner', outcomes: 'Chiefs,49ers', tick: 'PEPECASH',
            fee: '1.00', deadline: String(DEADLINE)
        };
        expect(s.validateAction('BET', base).valid).to.equal(true);

        const codes = params => s.validateAction('BET', Object.assign({}, base, params)).errors.map(e => e.code);
        expect(codes({ label: '' })).to.include('MISSING_REQUIRED_FIELD');
        expect(codes({ outcomes: 'OnlyOne' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ outcomes: 'Yes,Yes' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ fee: '1.005' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ fee: '99' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ deadline: 'soon' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ refundWindow: '60' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ minAmount: '0' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ allowList: '5', blockList: '5' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ details: 'not base64!' })).to.include('INVALID_FIELD_VALUE');
    });

    it('does not demand create fields on the lifecycle formats', function () {
        // FEED_ACTION_INDEX marks an index operation, which exempts the create
        // required-field set. Without that entry every cancel would report four
        // spurious missing-field errors.
        const s = sdk();
        expect(s.validateAction('BET', { feedActionIndex: '1234' }).valid).to.equal(true);
        expect(s.validateAction('BET', { feedActionIndex: '1234', outcome: '1' }).valid).to.equal(true);
        expect(s.validateAction('BET', { feedActionIndex: '1234', outcome: '0', amount: '5' }).valid).to.equal(true);
    });

    it('rejects an AMOUNT with no OUTCOME, which would silently become a cancel', function () {
        const s = sdk();
        const res = s.validateAction('BET', { feedActionIndex: '1234', amount: '25' });
        expect(res.valid).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('MISSING_REQUIRED_FIELD');
    });

    it('rejects delimiters in the memo, like every other action', function () {
        const s = sdk();
        expect(s.validateAction('BET', { feedActionIndex: '1234', memo: 'a|b' }).valid).to.equal(false);
        expect(s.validateAction('BET', { feedActionIndex: '1234', memo: 'a;b' }).valid).to.equal(false);
    });

});
