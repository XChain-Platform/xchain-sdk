'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');
const { COLUMN_TEXT_WIDTHS } = require('../../../../src/preflight/universal/column_widths.js');

// PRICE v1 VALUE and FEE (prices.value and prices.fee, VARCHAR(250); xchain-indexer
// src/actions/price/v1.js) and the BET create-feed FEE (bet_feeds.fee, VARCHAR(11);
// bet/create_feed.js) admit leading zeros, so a value their format rules accept can be
// wider than its column. The indexer refuses each from genesis as '<FIELD> (length)'.
const padded = (width, digit) => '0'.repeat(width - 1) + digit;
const token = () => ({ info: { tick: 'JDOG', owner: 'other', decimals: 8, tick_id: 4 } });

async function reportFor(wire) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), getToken: token,
        getAction: notFound } });
    sdk.explorer.coin = 'RBTC';
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}
const widthFindings = (r, field) => r.findings.filter((f) => f.code === 'VALIDATOR_SEMANTICS'
    && f.severity === 'error' && f.data && f.data.field === field && f.data.limit !== undefined);

async function expectRefused(wire, field, width, limit, action) {
    const found = widthFindings(await reportFor(wire), field);
    expect(found, field).to.have.length(1);
    expect(found[0].overridable).to.equal(false);
    expect(found[0].message).to.include(`the indexer refuses this ${action} as invalid: ${field} (length)`);
    expect(found[0].data).to.include({ width, limit, verdict: `invalid: ${field} (length)`, haltClass: true });
}
async function expectClear(wire, field) {
    expect(widthFindings(await reportFor(wire), field), field).to.deep.equal([]);
}

describe('pre-flight universal: valid wire text wider than its column', function () {
    it('pins the column widths the indexer checks', function () {
        expect(COLUMN_TEXT_WIDTHS).to.deep.equal({ PRICE: { 1: { VALUE: 250, FEE: 250 } }, BET: { 0: { FEE: 11 } } });
    });

    describe('PRICE v1', function () {
        const price = (value, fee) => `PRICE|1|BTC|JDOG|USD|${value}|${fee}`;

        it('refuses a 251-character VALUE and keeps a 250-character one', async function () {
            await expectRefused(price(padded(251, 1), ''), 'VALUE', 251, 250, 'PRICE');
            await expectClear(price(padded(250, 1), ''), 'VALUE');
        });

        it('refuses a 251-character FEE and keeps a 250-character one', async function () {
            await expectRefused(price('1', padded(251, 1)), 'FEE', 251, 250, 'PRICE');
            await expectClear(price('1', padded(250, 1)), 'FEE');
        });

        it('never measures an absent FEE', async function () {
            await expectClear(price('1', ''), 'FEE');
        });
    });

    describe('BET create feed', function () {
        const feed = (fee) => `BET|0|L|A,B|JDOG|${fee}|9999999999|86400|1|||`;

        it('refuses a 12-character FEE and keeps an 11-character one', async function () {
            await expectRefused(feed(padded(12, 5)), 'FEE', 12, 11, 'BET');
            await expectRefused(feed('0000000005.5'), 'FEE', 12, 11, 'BET');
            await expectClear(feed(padded(11, 5)), 'FEE');
            await expectClear(feed('5.25'), 'FEE');
        });

        it('applies to the create format only', async function () {
            await expectClear(`BET|2|5|0|${padded(12, 1)}|`, 'AMOUNT');
            await expectClear(`BET|1|${padded(20, 5)}|`, 'FEE');
        });
    });
});
