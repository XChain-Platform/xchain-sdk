// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const { SDKValidationError } = require('../../../../src/utils/errors.js');
const {
    BET_LIMITS,
    OUTCOME_FORBIDDEN,
    BET_DETAILS_SCHEMA,
    isSet,
    fail,
    jsonDepth
} = require('../../../../src/actions/betting/bet_rules.js');

const EXPECTED_LIMITS = {
    MAX_BET_LABEL_LENGTH: 250,
    MAX_BET_OUTCOMES: 16,
    MAX_BET_OUTCOME_LENGTH: 64,
    MAX_FEED_FEE: 10,
    DEFAULT_BET_REFUND_WINDOW: 1209600,
    MIN_BET_REFUND_WINDOW: 3600,
    MAX_BET_REFUND_WINDOW: 31536000,
    MAX_BET_DETAILS_LENGTH: 4096,
    MAX_BET_DETAILS_DEPTH: 8,
    MAX_BETS_PER_FEED: 10000,
    MAX_BET_DEADLINE_HORIZON: 31536000
};

const LIMIT_CASES = {
    MAX_BET_LABEL_LENGTH: value => value.length <= BET_LIMITS.MAX_BET_LABEL_LENGTH,
    MAX_BET_OUTCOMES: value => value.length <= BET_LIMITS.MAX_BET_OUTCOMES,
    MAX_BET_OUTCOME_LENGTH: value => value.length <= BET_LIMITS.MAX_BET_OUTCOME_LENGTH,
    MAX_FEED_FEE: value => value <= BET_LIMITS.MAX_FEED_FEE,
    DEFAULT_BET_REFUND_WINDOW: value => value === BET_LIMITS.DEFAULT_BET_REFUND_WINDOW,
    MIN_BET_REFUND_WINDOW: value => value >= BET_LIMITS.MIN_BET_REFUND_WINDOW,
    MAX_BET_REFUND_WINDOW: value => value <= BET_LIMITS.MAX_BET_REFUND_WINDOW,
    MAX_BET_DETAILS_LENGTH: value => value.length <= BET_LIMITS.MAX_BET_DETAILS_LENGTH,
    MAX_BET_DETAILS_DEPTH: value => jsonDepth(value) <= BET_LIMITS.MAX_BET_DETAILS_DEPTH,
    MAX_BETS_PER_FEED: value => value <= BET_LIMITS.MAX_BETS_PER_FEED,
    MAX_BET_DEADLINE_HORIZON: value => value <= BET_LIMITS.MAX_BET_DEADLINE_HORIZON
};

const LIMIT_VALUES = {
    MAX_BET_LABEL_LENGTH: ['x'.repeat(250), 'x'.repeat(251)],
    MAX_BET_OUTCOMES: [Array(16), Array(17)],
    MAX_BET_OUTCOME_LENGTH: ['x'.repeat(64), 'x'.repeat(65)],
    MAX_FEED_FEE: [10, 11],
    DEFAULT_BET_REFUND_WINDOW: [1209600, 1209601],
    MIN_BET_REFUND_WINDOW: [3600, 3599],
    MAX_BET_REFUND_WINDOW: [31536000, 31536001],
    MAX_BET_DETAILS_LENGTH: [Buffer.alloc(4096), Buffer.alloc(4097)],
    MAX_BET_DETAILS_DEPTH: [nestedValue(7), nestedValue(8)],
    MAX_BETS_PER_FEED: [10000, 10001],
    MAX_BET_DEADLINE_HORIZON: [31536000, 31536001]
};

function nestedValue(levels) {
    let value = 'leaf';
    for (let index = 0; index < levels; index++) value = { nested: value };
    return value;
}

describe('bet_rules', function () {

    it('exports every consensus limit at its pinned value', function () {
        expect(BET_LIMITS).to.deep.equal(EXPECTED_LIMITS);
    });

    it('accepts the boundary and refuses the adjacent value for every limit', function () {
        for (const [name, accepts] of Object.entries(LIMIT_CASES)) {
            const [accepted, refused] = LIMIT_VALUES[name];
            expect(accepts(accepted), `${name} accepted boundary`).to.equal(true);
            expect(accepts(refused), `${name} refused neighbor`).to.equal(false);
        }
    });

    it('pins the documented DETAILS schema', function () {
        expect(BET_DETAILS_SCHEMA).to.deep.equal({
            title: { type: 'string', required: true, maxLength: 250 },
            description: { type: 'string', required: false, maxLength: 2000 },
            outcomes: { type: 'string[]', required: false },
            outcome_details: { type: 'string[]', required: false },
            resolution_criteria: { type: 'string', required: false, maxLength: 1000 },
            source: { type: 'string', required: false, maxLength: 500 },
            category: { type: 'string', required: false, maxLength: 64 }
        });
    });

    it('distinguishes allowed labels from forbidden delimiters and controls', function () {
        expect(OUTCOME_FORBIDDEN.test('Kansas City Chiefs (AFC)')).to.equal(false);
        for (const label of ['a,b', 'a|b', 'a;b', 'a\nb', 'a\x7fb'])
            expect(OUTCOME_FORBIDDEN.test(label), JSON.stringify(label)).to.equal(true);
    });

    it('treats null and empty strings as unset while preserving zero', function () {
        expect(isSet(null)).to.equal(false);
        expect(isSet('')).to.equal(false);
        expect(isSet(0)).to.equal(true);
    });

    it('throws a typed validation error with the supplied fields', function () {
        const context = { field: 'OUTCOMES' };
        expect(() => fail('INVALID_FIELD_VALUE', 'invalid outcome', context))
            .to.throw(SDKValidationError, 'invalid outcome')
            .with.property('code', 'INVALID_FIELD_VALUE');
        try {
            fail('INVALID_FIELD_VALUE', 'invalid outcome', context);
        } catch (error) {
            expect(error.details).to.equal(context);
        }
        expect(() => fail('MISSING_REQUIRED_FIELD', 'missing value'))
            .to.throw(SDKValidationError)
            .with.property('details').that.deep.equals({});
    });

    it('measures flat, nested, and array JSON inputs', function () {
        expect(jsonDepth({ title: 'flat' })).to.equal(2);
        expect(jsonDepth({ outer: { inner: 'nested' } })).to.equal(3);
        expect(jsonDepth([{ inner: ['nested'] }])).to.equal(4);
    });

});
