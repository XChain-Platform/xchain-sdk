'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { checkDividend } = require('../../../../src/preflight/checks/dividend.js');
const { FINDING_CODES } = require('../../../../src/preflight/constants.js');

function contextFor(amount) {
    const calls = { fields: [], findings: [], unverified: [] };
    const ctx = {
        field(name) {
            calls.fields.push([name]);
            return amount;
        },
        addFinding(...args) {
            calls.findings.push(args);
        },
        addUnverified(...args) {
            calls.unverified.push(args);
        },
    };
    return { calls, ctx };
}

function expectUnverified(calls) {
    expect(calls.unverified).to.have.length(1);
    expect(calls.unverified[0][0]).to.equal('DIVIDEND_DEBIT_TOTAL');
    expect(calls.unverified[0][1]).to.be.a('string').and.not.empty;
}

describe('pre-flight DIVIDEND check', function () {
    it('warns once when AMOUNT is not positive', async function () {
        for (const amount of ['0', '-1']) {
            const { calls, ctx } = contextFor(amount);
            await checkDividend(ctx);
            expect(calls.fields).to.deep.equal([['AMOUNT']]);
            expect(calls.findings).to.deep.equal([[
                FINDING_CODES.AMOUNT_NOT_POSITIVE,
                'warning',
                'Per-unit dividend amount is not positive.',
                { amount },
            ]]);
            expectUnverified(calls);
        }
    });

    it('does not warn when AMOUNT is positive or empty', async function () {
        for (const amount of ['1', '']) {
            const { calls, ctx } = contextFor(amount);
            await checkDividend(ctx);
            expect(calls.fields).to.deep.equal([['AMOUNT']]);
            expect(calls.findings).to.deep.equal([]);
            expectUnverified(calls);
        }
    });
});
