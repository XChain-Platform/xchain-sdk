'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The client side of the indexer's EXPIRATION representability bound.
//
// The handlers that carry an EXPIRATION (xchain-indexer src/actions/order.js,
// swap.js, dispenser.js) refuse a value outside the unsigned range its storage
// column holds, as `invalid: EXPIRATION (format)`. It is not normalized to NULL
// on the way to storage, so pre-flight silence here would tell an author "valid"
// for a payload every node refuses, and the silent outcome it replaced - no
// expiration at all - is an escrow that never expires.
//
// Two properties, pulling opposite ways, exactly as the amount-representability
// suite next door.
//
// EXACTLY AS WIDE AS CONSENSUS. The bound is [0, 18446744073709551615], read off
// config['INTEGER_FIELDS']['EXPIRATION']. The largest storable value is accepted
// and the first unstorable one is refused, which is the pair that pins the
// comparison to BigInt: through a double those two numbers are equal.
//
// AND NO WIDER. A spelling the predicate cannot prove out of range keeps the
// verdict it has today; this check never refuses an action on a value the chain
// would take.

const { expect } = require('chai');
const { mockSdk } = require('./_mock.js');
const numeric = require('../../../src/preflight/numeric.js');
const { EXPIRATION_MAX } = require('../../../src/preflight/constants.js');

function reportFor(wire, explorerSpec = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}

// This check's own findings, identified by what it asserts rather than by the
// shared code it rides: VALIDATOR_SEMANTICS carries every mirrored field rule.
function expiryRangeFindings(report) {
    return (report.findings || []).filter(f =>
        f.code === 'VALIDATOR_SEMANTICS' && f.data && f.data.field === 'EXPIRATION' && f.data.constraint);
}

// The three wire shapes that carry EXPIRATION on the create, and the two edit
// formats that carry it again (format 1 cancels carry no EXPIRATION at all).
const WIRES = {
    ORDER:          (exp) => 'ORDER|0||JDOG|1|0||GET|2|0||' + exp,
    SWAP:           (exp) => 'SWAP|0||JDOG|1|0||GET|2|0||' + exp,
    DISPENSER:      (exp) => 'DISPENSER|0||JDOG|1|0|10||GET|1|||||' + exp,
    ORDER_EDIT:     (exp) => 'ORDER|2|42|' + exp,
    SWAP_EDIT:      (exp) => 'SWAP|2|42|' + exp,
    DISPENSER_EDIT: (exp) => 'DISPENSER|2|42||' + exp,
};

const LARGEST_ACCEPTED  = '18446744073709551615';
const SMALLEST_REJECTED = '18446744073709551616';

describe('EXPIRATION representability: the client refuses what the chain refuses', function () {
    it('the vendored constant is the u64 ceiling, as a digit string', function () {
        expect(EXPIRATION_MAX).to.equal(LARGEST_ACCEPTED);
        expect(typeof EXPIRATION_MAX).to.equal('string');
    });

    describe('the predicate, at the boundary', function () {
        it('accepts the largest storable expiration and refuses the next integer up', function () {
            expect(numeric.exceedsUnsignedColumn(LARGEST_ACCEPTED, EXPIRATION_MAX)).to.equal(false);
            expect(numeric.exceedsUnsignedColumn(SMALLEST_REJECTED, EXPIRATION_MAX)).to.equal(true);
            // The pair above is the whole reason the comparison is BigInt: a
            // double cannot tell these two numbers apart.
            expect(Number(LARGEST_ACCEPTED) === Number(SMALLEST_REJECTED)).to.equal(true);
        });

        it('refuses below zero and accepts zero itself', function () {
            expect(numeric.exceedsUnsignedColumn('-1', EXPIRATION_MAX)).to.equal(true);
            expect(numeric.exceedsUnsignedColumn('0', EXPIRATION_MAX)).to.equal(false);
        });

        it('reads an integer-valued exponent through the double branch', function () {
            expect(numeric.exceedsUnsignedColumn('1e30', EXPIRATION_MAX)).to.equal(true);
            expect(numeric.exceedsUnsignedColumn('-1e3', EXPIRATION_MAX)).to.equal(true);
            expect(numeric.exceedsUnsignedColumn('1e5', EXPIRATION_MAX)).to.equal(false);
        });

        it('answers false for anything it cannot prove out of range', function () {
            for (const v of ['abc', '', 'NaN', 'Infinity', null, undefined]) {
                expect(numeric.exceedsUnsignedColumn(v, EXPIRATION_MAX),
                    `${String(v)} is unprovable and must keep its current verdict`).to.equal(false);
            }
        });

        it('tolerates surrounding whitespace and a leading sign, as the handler does', function () {
            expect(numeric.exceedsUnsignedColumn('  ' + SMALLEST_REJECTED + ' ', EXPIRATION_MAX)).to.equal(true);
            expect(numeric.exceedsUnsignedColumn('+' + LARGEST_ACCEPTED, EXPIRATION_MAX)).to.equal(false);
            expect(numeric.exceedsUnsignedColumn('+' + SMALLEST_REJECTED, EXPIRATION_MAX)).to.equal(true);
        });
    });

    describe('pre-flight raises it on every action and format that carries the field', function () {
        for (const [name, wire] of Object.entries(WIRES)) {
            it(`${name}: the first unstorable expiration is a non-overridable error`, async function () {
                const r = await reportFor(wire(SMALLEST_REJECTED));
                const found = expiryRangeFindings(r);
                expect(found.length, JSON.stringify(r.findings)).to.equal(1);
                expect(found[0].severity).to.equal('error');
                expect(found[0].overridable).to.equal(false);
                expect(found[0].data.value).to.equal(SMALLEST_REJECTED);
                expect(found[0].data.constraint).to.deep.equal({ min: '0', max: EXPIRATION_MAX });
            });

            it(`${name}: the largest storable expiration raises nothing`, async function () {
                const r = await reportFor(wire(LARGEST_ACCEPTED));
                expect(expiryRangeFindings(r), JSON.stringify(r.findings)).to.have.length(0);
            });

            it(`${name}: a negative expiration is an error`, async function () {
                const r = await reportFor(wire('-1'));
                expect(expiryRangeFindings(r)).to.have.length(1);
            });

            it(`${name}: an ordinary expiration raises nothing`, async function () {
                const r = await reportFor(wire('1799999999'));
                expect(expiryRangeFindings(r), JSON.stringify(r.findings)).to.have.length(0);
            });
        }

        it('an absent EXPIRATION is not judged (the handler guards with isNull)', async function () {
            for (const wire of [WIRES.ORDER, WIRES.SWAP, WIRES.DISPENSER]) {
                const r = await reportFor(wire(''));
                expect(expiryRangeFindings(r), wire('')).to.have.length(0);
            }
            // Format 1 carries no EXPIRATION field at all.
            expect(expiryRangeFindings(await reportFor('ORDER|1|42'))).to.have.length(0);
        });

        it('an exponent expiration past the ceiling is refused too', async function () {
            expect(expiryRangeFindings(await reportFor(WIRES.ORDER('1e30')))).to.have.length(1);
        });

        it('a non-numeric expiration is left to the handler, not refused here', async function () {
            // isNumeric/isInteger reject it server-side with the same error string,
            // but this check must not claim a verdict its predicate cannot prove.
            expect(expiryRangeFindings(await reportFor(WIRES.ORDER('soon')))).to.have.length(0);
        });
    });
});
