'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk } = require('../helpers/mock.js');
const { CheckContext } = require('../../../../src/preflight/context.js');
const { FINDING_CODES } = require('../../../../src/preflight/constants.js');

const H = 'n4LCDuwBxvTXAGQuswuTDAicNxtgUwxjDa';
const WIRE = 'SEND|0|XCHAIN|1|mxNAZQtCRBG3dYu2ufVxSsc7V3c8jh9HDM|memo';
const FRESH = { stale: false, tipBlock: 114903 };

function rateLimited() {
    const error = new Error('rate limited');
    error.code = 'EXPLORER_HTTP_429';
    throw error;
}

function tokenSdk(rows, mode = 'report') {
    const sdk = mockSdk({
        preflight: mode,
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getToken: (tick) => ({ info: { tick: String(tick) }, decimals: 8 }),
            getBalances: () => rows,
            getPreflight: rateLimited,
        },
    });
    sdk.explorer.freshness = () => FRESH;
    return sdk;
}

function nativeSdk(confirmed) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }) } });
    sdk.explorer.coin = 'BTC';
    sdk.explorer.freshness = () => FRESH;
    sdk.getAddress = async () => ({ balances: { confirmed } });
    return sdk;
}

function context(sdk) {
    return new CheckContext({
        sdk, parsed: { params: {} }, source: H, mode: 'report', timeoutMs: 5000,
    });
}

describe('pre-flight unreadable balance amounts', function () {
    for (const raw of [undefined, null, 'abc', '', '1.2.3']) {
        it('treats token amount ' + JSON.stringify(raw) + ' as unverified', async function () {
            const row = { tick: 'XCHAIN' };
            if (raw !== undefined) row.quantity = raw;
            const ctx = context(tokenSdk([row]));
            expect(await ctx.balance(H, 'XCHAIN')).to.equal(null);
            expect(ctx.unverified.map((u) => u.check)).to.include('BALANCE_LOOKUP');
        });
    }

    it('does not turn an unreadable amount into a certified shortfall', async function () {
        const sdk = tokenSdk([{ tick: 'XCHAIN', quantity: 'abc' }]);
        const result = await sdk.preflight(WIRE, { source: H, preflight: 'report' });
        expect(result.verdict).to.not.equal('fail');
        expect(result.findings.filter((finding) =>
            finding.code === FINDING_CODES.BALANCE_INSUFFICIENT && finding.severity === 'error'
        )).to.deep.equal([]);
        expect(result.unverified.map((entry) => entry.check)).to.include(FINDING_CODES.BALANCE_INSUFFICIENT);
    });

    it('does not throw in enforce mode for an unreadable amount', async function () {
        const sdk = tokenSdk([{ tick: 'XCHAIN' }], 'enforce');
        const result = await sdk.preflight(WIRE, { source: H, preflight: 'enforce' });
        expect(result.verdict).to.not.equal('fail');
    });

    it('treats an unreadable native amount as unverified', async function () {
        const ctx = context(nativeSdk('abc'));
        expect(await ctx.balance(H, 'BTC')).to.equal(null);
        expect(ctx.unverified.map((u) => u.check)).to.include('NATIVE_BALANCE_LOOKUP');
    });

    it('preserves authoritative zero and readable amount controls', async function () {
        expect(await context(tokenSdk([])).balance(H, 'XCHAIN')).to.equal('0');
        expect(await context(tokenSdk([{ tick: 'XCHAIN', quantity: '1.00000000' }]))
            .balance(H, 'XCHAIN')).to.equal('1.00000000');
        expect(await context(nativeSdk('0')).balance(H, 'BTC')).to.equal('0');
    });

    it('recognizes only readable exact zero amounts as zero', function () {
        const ctx = context(tokenSdk([]));
        expect(ctx.isZeroAmount('0')).to.equal(true);
        expect(ctx.isZeroAmount('0.00000000')).to.equal(true);
        for (const value of ['1', '-1', 'abc', '']) expect(ctx.isZeroAmount(value), value).to.equal(false);
    });
});
