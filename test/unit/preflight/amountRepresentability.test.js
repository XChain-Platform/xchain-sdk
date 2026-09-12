'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The client side of the indexer's amount-representability flag day.
//
// Two properties, and they pull in opposite directions on purpose.
//
// NOT STRICTER THAN CONSENSUS. The indexer gate rejects amount text that does
// not denote the number the ledger credits (exponent notation, radix prefixes,
// an over-wide integer), but it is flag-day gated and mainnet and testnet are
// both unarmed. So this SDK must keep ACCEPTING that family: rejecting it here
// would block a broadcast both public planes take. These assertions are the
// falsification of a premature mirror. If someone vendors the rule into
// src/utility.js or src/preflight/numeric.js before mainnet arms, they go red.
//
// AND DECLARED, NOT SILENT. The three checks modules that judge amount format
// must say the rule exists, as an unverified aspect, so a caller is told the
// verdict is legacy-only rather than reading silence as "checked, fine".

const { expect } = require('chai');
const { mockSdk, notFound } = require('./_mock.js');
const Utility = require('../../../src/utility.js');
const numeric = require('../../../src/preflight/numeric.js');

function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: opts.mode || 'report', ...opts });
}

const has = (r, code) => r.findings.some(f => f.code === code);
const unverified = (r, check) => (r.unverified || []).some(u => u.check === check);

// The family the indexer gate refuses above its flag day, paired with the
// decimals that make each one a live defect on the consensus side.
const NON_NUMERAL_AMOUNTS = [
    [18, '5e-19'],   // validates, and the ledger credits 1e-18 instead
    [0,  '1e-1'],    // validates on an INDIVISIBLE tick, credits 0
    [8,  '1e+5'],
    [8,  '0x10'],
    [8,  '+1.5'],
    [8,  '1.'],
    [18, '1'.repeat(43)], // one integer digit past the ledger aggregation width
];

describe('amount representability: the client stays on the legacy rule', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    it('the SDK amount-format rule still accepts the whole non-numeral family', function () {
        for (const [decimals, amount] of NON_NUMERAL_AMOUNTS) {
            expect(util.isValidAmountFormat(decimals, amount),
                `${amount} at ${decimals} dp must stay VALID client-side while both public planes are unarmed`)
                .to.equal(true);
        }
    });

    it('the pre-flight numeric helper answers the same way (no mirror slipped in below it)', function () {
        for (const [decimals, amount] of NON_NUMERAL_AMOUNTS) {
            expect(numeric.isValidAmountFormat(decimals, amount),
                `${amount} at ${decimals} dp must stay VALID through the pre-flight helper too`)
                .to.equal(true);
        }
    });

    it('the rules the legacy body DOES enforce are untouched', function () {
        expect(util.isValidAmountFormat(0, '1.5')).to.equal(false);      // fraction on an indivisible tick
        expect(util.isValidAmountFormat(8, '1.000000001')).to.equal(false); // over-precision
        expect(util.isValidAmountFormat(8, '-1')).to.equal(false);       // negative
        expect(util.isValidAmountFormat(8, '1.2.3')).to.equal(false);    // multi-dot
        expect(util.isValidAmountFormat(8, '1.5')).to.equal(true);
        expect(util.isValidAmountFormat(8, '007')).to.equal(true);
    });

    it('MINT declares the representability rule instead of passing it over in silence', async function () {
        const r = await reportFor('MINT|0|JDOG|5e-19', {
            getToken: () => ({ tick: 'JDOG', decimals: '18', max_supply: '0' }),
        });
        expect(has(r, 'AMOUNT_FORMAT_INVALID'),
            'an exponent amount must NOT be an error while both public planes are unarmed').to.equal(false);
        expect(unverified(r, 'AMOUNT_REPRESENTABILITY'),
            'MINT must declare the rule it cannot decide').to.equal(true);
    });

    // A radix-prefixed MAX_SUPPLY, not an exponent one: the static validator's
    // BigInt range check refuses '1e+5' outright (a pre-existing rejection on the
    // MAX_SUPPLY field alone, unrelated to this rule), while '0x10' clears it and
    // reaches the decimals-aware amount-format check this rule is about.
    it('ISSUE declares it on the MAX_SUPPLY path', async function () {
        const r = await reportFor('ISSUE|0|NEWTOK|0x10||8', { getToken: () => notFound() });
        expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
        expect(unverified(r, 'AMOUNT_REPRESENTABILITY')).to.equal(true);
    });

    it('a DISPENSER create declares it', async function () {
        const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|100|BTC||0.001', {});
        expect(unverified(r, 'AMOUNT_REPRESENTABILITY')).to.equal(true);
    });

    // An action with no amount-format verdict to qualify must not file the
    // aspect: a declaration on every action is noise, and noise is what makes a
    // real one unreadable.
    it('SEND does not file it (it never judged amount format in the first place)', async function () {
        const r = await reportFor('SEND|0|JDOG|10|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: () => ({ tick: 'JDOG' }),
            getBalances: () => [{ tick: 'JDOG', amount: '50' }],
        });
        expect(unverified(r, 'AMOUNT_REPRESENTABILITY')).to.equal(false);
    });
});
