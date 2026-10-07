// Copyright © 2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const { XChainSDK } = require('../../../../index.js');
const BettingHelpers = require('../../../../src/actions/betting.js');
const formats = require('../../../../src/protocol/formats.js');
const { parse } = require('../../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

function sdk() {
    return new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
}

describe('BET v4 edit feed list composition', function () {

    it('registers the canonical wire field order and composes retain/detach exactly', async function () {
        expect(formats.BET[4]).to.equal('VERSION|FEED_ACTION_INDEX|ALLOW_LIST|BLOCK_LIST|MEMO');

        const params = new BettingHelpers().editMarketListsParams({
            feedActionIndex: 1234,
            blockList: 0,
            memo: 'Open the market'
        });
        expect(params).to.deep.equal({
            version: 4,
            feedActionIndex: '1234',
            allowList: '',
            blockList: '0',
            memo: 'Open the market'
        });

        const result = await sdk().bet(params);
        expect(result.version).to.equal(4);
        expect(result.actionString).to.equal('BET|4|1234||0|Open the market');
        expect((await sdk().bet(new BettingHelpers().editMarketListsParams({
            feedActionIndex: 1234, allowList: 0, blockList: 0
        }))).actionString).to.equal('BET|4|1234|0|0');
    });

    it('composes independent positive replacement references', async function () {
        const params = new BettingHelpers().editMarketListsParams({
            feedActionIndex: '42',
            allowList: '101',
            blockList: 202
        });
        expect((await sdk().bet(params)).actionString).to.equal('BET|4|42|101|202');
        expect((await sdk().bet({ feedActionIndex: 42, allowList: 101 })).actionString)
            .to.equal('BET|4|42|101');
    });
});

describe('BET v4 edit feed list safeguards', function () {

    it('rejects no-op edits, malformed references, and equal replacement lists', function () {
        const betting = new BettingHelpers();
        expect(() => betting.editMarketListsParams({ feedActionIndex: 42 }))
            .to.throw(/allowList or blockList is required/);
        expect(() => betting.editMarketListsParams({ feedActionIndex: 42, allowList: 'abc' }))
            .to.throw(/ALLOW_LIST must be a numeric ACTION_INDEX/);
        expect(() => betting.editMarketListsParams({ feedActionIndex: 42, allowList: 7, blockList: '7' }))
            .to.throw(/cannot be set to the same list/);
        expect(() => betting.editMarketListsParams({ allowList: 7 }))
            .to.throw(/FEED_ACTION_INDEX is required/);
    });

    it('validates the v4 list edit semantics on raw action params', function () {
        const s = sdk();
        expect(s.validateAction('BET', {
            version: 4, feedActionIndex: 42, allowList: '', blockList: 0
        })).to.deep.equal({ valid: true, errors: [] });

        const noop = s.validateAction('BET', { version: 4, feedActionIndex: 42 });
        expect(noop.valid).to.equal(false);
        expect(noop.errors.map(e => e.message).join('\n')).to.include('requires ALLOW_LIST or BLOCK_LIST');

        const malformed = s.validateAction('BET', {
            feedActionIndex: 42, allowList: '-1'
        });
        expect(malformed.valid).to.equal(false);
        expect(malformed.errors.map(e => e.message).join('\n')).to.include('positive numeric ACTION_INDEX');

        const wrongVersion = s.validateAction('BET', {
            version: 1, feedActionIndex: 42, allowList: 7
        });
        expect(wrongVersion.valid).to.equal(false);
        expect(wrongVersion.errors.map(e => e.message).join('\n')).to.include('require VERSION 4');
    });

    it('describes retain and detach semantics plus the stateful restrictions', function () {
        const decoded = describeAction(parse('BET|4|1234||0|Open the market'));
        expect(decoded.summary).to.equal('Edit membership lists for market 1234');
        expect(decoded.details.find(row => row.label === 'Allow list').value).to.equal('Retain current');
        expect(decoded.details.find(row => row.label === 'Block list').value).to.equal('Detach');
        expect(decoded.warnings.join('\n')).to.include('market creator');
        expect(decoded.warnings.join('\n')).to.include('market is open');
        expect(decoded.warnings.join('\n')).to.include('future bets only');
    });
});
