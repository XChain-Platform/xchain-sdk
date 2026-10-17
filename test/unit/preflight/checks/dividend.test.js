'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk } = require('../helpers/mock.js');
const { FINDING_CODES } = require('../../../../src/preflight/constants.js');

// TICK and DIVIDEND_TICK both exist; DIVIDEND_TICK pays at 8 decimals.
function reportFor(wire) {
    const sdk = mockSdk({
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getToken: (t) => ({ tick: String(t), decimals: 8 }),
        },
    });
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}

const of = (r, code) => r.findings.filter((f) => f.code === code);

function expectUnverified(r) {
    const u = (r.unverified || []).filter((x) => x.check === 'DIVIDEND_DEBIT_TOTAL');
    expect(u).to.have.length(1);
    expect(u[0].reason).to.be.a('string').and.not.empty;
}

describe('pre-flight DIVIDEND check', function () {
    it('warns once when AMOUNT is not positive', async function () {
        for (const amount of ['0', '-1']) {
            const r = await reportFor(`DIVIDEND|0|JDOG|EIGHT|${amount}|m`);
            const warned = of(r, FINDING_CODES.AMOUNT_NOT_POSITIVE).filter((f) => f.message === 'Per-unit dividend amount is not positive.');
            expect(warned, amount).to.have.length(1);
            expect(warned[0].severity).to.equal('warning');
            expect(warned[0].data).to.deep.equal({ amount });
            expectUnverified(r);
        }
    });

    it('does not warn when AMOUNT is positive', async function () {
        const r = await reportFor('DIVIDEND|0|JDOG|EIGHT|1|m');
        expect(of(r, FINDING_CODES.AMOUNT_NOT_POSITIVE)).to.deep.equal([]);
        expect(of(r, FINDING_CODES.AMOUNT_FORMAT_INVALID)).to.deep.equal([]);
        expectUnverified(r);
    });

    // dividend/validate.js:41-43 refuses a null AMOUNT as AMOUNT (format).
    it('refuses an empty AMOUNT, which the indexer rejects as AMOUNT (format)', async function () {
        const r = await reportFor('DIVIDEND|0|JDOG|EIGHT||m');
        expect(of(r, FINDING_CODES.AMOUNT_FORMAT_INVALID).map((f) => f.severity)).to.include('error');
        expect(of(r, FINDING_CODES.AMOUNT_NOT_POSITIVE)).to.deep.equal([]);
    });

    // The per-unit AMOUNT is measured against DIVIDEND_TICK's decimals (8 here).
    it('refuses an AMOUNT finer than DIVIDEND_TICK decimals', async function () {
        const r = await reportFor('DIVIDEND|0|JDOG|EIGHT|0.000000001|m');
        expect(of(r, FINDING_CODES.AMOUNT_FORMAT_INVALID).map((f) => f.severity)).to.include('error');
    });
});
