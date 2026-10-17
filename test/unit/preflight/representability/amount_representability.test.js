'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The client side of the indexer's amount-representability flag day.
//
// The indexer refuses amount text that does not denote the number the ledger
// credits (exponent notation, radix prefixes, a sign, an over-wide integer) wherever
// amount_representability_activation is armed: BTC, LTC and DOGE testnet at time
// 1791061097 and regtest from genesis (xchain-indexer src/protocol_changes/gates_1.js).
// Mainnet is unarmed. So pre-flight refuses that family where it is armed, accepts it
// where it is not and declares the rule there, and the two-argument SDK utility stays
// on the legacy rule the indexer keeps below the threshold.

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');
const Utility = require('../../../../src/utils/utility.js');
const numeric = require('../../../../src/preflight/numeric.js');

function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ network: opts.network || 'bitcoin-regtest',
        explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: opts.mode || 'report', ...opts });
}

const has = (r, code) => r.findings.some(f => f.code === code);
const unverified = (r, check) => (r.unverified || []).some(u => u.check === check);

let util;

function resetUtility() {
    util = new Utility();
}

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

describe('amount representability: the two-argument rule stays legacy', function () {
    beforeEach(resetUtility);

    it('the SDK amount-format rule still accepts the whole non-numeral family', function () {
        for (const [decimals, amount] of NON_NUMERAL_AMOUNTS) {
            expect(util.isValidAmountFormat(decimals, amount),
                `${amount} at ${decimals} dp must stay VALID on the two-argument legacy rule`)
                .to.equal(true);
        }
    });

    it('the pre-flight helper answers the same way unarmed, and refuses the family armed', function () {
        for (const [decimals, amount] of NON_NUMERAL_AMOUNTS) {
            expect(numeric.isValidAmountFormat(decimals, amount)).to.equal(true);
            expect(numeric.isValidAmountFormatWhere(decimals, amount, false)).to.equal(true);
            expect(numeric.isValidAmountFormatWhere(decimals, amount, true),
                `${amount} at ${decimals} dp is refused where the gate is armed`).to.equal(false);
        }
        expect(numeric.isValidAmountFormatWhere(8, '1.5', true)).to.equal(true);
        expect(numeric.isValidAmountFormatWhere(8, '007', true)).to.equal(true);
        expect(numeric.isValidAmountFormatWhere(18, '1'.repeat(42), true)).to.equal(true);
        expect(numeric.isValidAmountFormatWhere(null, '1000', true), 'NaN decimals refuse when armed').to.equal(false);
    });

    it('the rules the legacy body DOES enforce are untouched', function () {
        expect(util.isValidAmountFormat(0, '1.5')).to.equal(false);      // fraction on an indivisible tick
        expect(util.isValidAmountFormat(8, '1.000000001')).to.equal(false); // over-precision
        expect(util.isValidAmountFormat(8, '-1')).to.equal(false);       // negative
        expect(util.isValidAmountFormat(8, '1.2.3')).to.equal(false);    // multi-dot
        expect(util.isValidAmountFormat(8, '1.5')).to.equal(true);
        expect(util.isValidAmountFormat(8, '007')).to.equal(true);
    });
});

const JDOG18 = { getToken: () => ({ tick: 'JDOG', decimals: '18', max_supply: '0' }) };
const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

describe('amount representability: refused where armed, declared where not', function () {
    beforeEach(resetUtility);

    it('MINT refuses an exponent amount on regtest and files no declaration', async function () {
        const r = await reportFor('MINT|0|JDOG|5e-19', JDOG18);
        expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(true);
        expect(unverified(r, 'AMOUNT_REPRESENTABILITY')).to.equal(false);
    });

    it('MINT refuses it on bitcoin-testnet, armed by time', async function () {
        const r = await reportFor('MINT|0|JDOG|5e-19', JDOG18, { network: 'bitcoin-testnet' });
        expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(true);
    });

    it('MINT accepts it on mainnet, which is unarmed, and declares the rule', async function () {
        const r = await reportFor('MINT|0|JDOG|5e-19', JDOG18, { network: 'bitcoin-mainnet' });
        expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
        expect(unverified(r, 'AMOUNT_REPRESENTABILITY')).to.equal(true);
        expect(r.unverified.find(u => u.check === 'AMOUNT_REPRESENTABILITY').reason).to.contain('not armed');
    });

    // A radix-prefixed MAX_SUPPLY, not an exponent one: the static validator's
    // BigInt range check refuses '1e+5' outright (a rejection on the MAX_SUPPLY
    // field alone, unrelated to this rule), while '0x10' clears it and reaches the
    // decimals-aware amount-format check this rule is about.
    it('ISSUE refuses a radix MAX_SUPPLY where armed and declares it on mainnet', async function () {
        const armed = await reportFor('ISSUE|0|NEWTOK|0x10||8', { getToken: () => notFound() });
        expect(has(armed, 'AMOUNT_FORMAT_INVALID')).to.equal(true);
        const main = await reportFor('ISSUE|0|NEWTOK|0x10||8', { getToken: () => notFound() }, { network: 'bitcoin-mainnet' });
        expect(has(main, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
        expect(unverified(main, 'AMOUNT_REPRESENTABILITY')).to.equal(true);
    });

    it('a DISPENSER create refuses a plus-signed escrow where armed', async function () {
        const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|+1|BTC||0.001', {
            getToken: () => ({ tick: 'JDOG', decimals: 0 }), getBalances: () => [{ tick: 'JDOG', amount: '50' }],
        });
        expect(has(r, 'AMOUNT_FORMAT_INVALID')).to.equal(true);
    });

});

describe('amount representability: the actions the lane measured as false accepts', function () {
    beforeEach(resetUtility);

    // SEND, DESTROY, ORDER, SWAP, AIRDROP and DIVIDEND each refuse the family where
    // armed and declare it on mainnet.
    const WIRES = [
        ['SEND', 'SEND|0|JDOG|1e2|' + ADDR],
        ['DESTROY', 'DESTROY|0|JDOG|0x10|m'],
        ['ORDER', 'ORDER|0|BTC|JDOG|+1|0|BTC|EIGHT|1|0|||||m'],
        ['SWAP', 'SWAP|0|BTC|JDOG|1e2|0|BTC|EIGHT|1|0|||||m'],
        ['AIRDROP', 'AIRDROP|0|JDOG|1e2|5|m'],
        ['DIVIDEND', 'DIVIDEND|0|EIGHT|JDOG|0x10|m'],
    ];
    const spec = {
        getToken: (t) => ({ tick: String(t), decimals: 0 }),
        getBalances: () => [{ tick: 'JDOG', amount: '1000' }, { tick: 'EIGHT', amount: '1000' }],
        getAction: () => ({ action: 'LIST', status: 'valid' }),
    };
    for (const [action, wire] of WIRES) {
        it(`${action} refuses a non-numeral amount where armed and declares it on mainnet`, async function () {
            const armed = await reportFor(wire, spec);
            expect(has(armed, 'AMOUNT_FORMAT_INVALID'), action + ' armed').to.equal(true);
            const main = await reportFor(wire, spec, { network: 'bitcoin-mainnet' });
            expect(has(main, 'AMOUNT_FORMAT_INVALID'), action + ' mainnet').to.equal(false);
            expect(unverified(main, 'AMOUNT_REPRESENTABILITY'), action + ' declares').to.equal(true);
        });
    }
});
