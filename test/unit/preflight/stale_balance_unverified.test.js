'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk } = require('./helpers/mock.js');
const { CheckContext } = require('../../../src/preflight/context.js');
const { FINDING_CODES } = require('../../../src/preflight/constants.js');

const H = 'n4LCDuwBxvTXAGQuswuTDAicNxtgUwxjDa';
const WIRE = 'SEND|0|XCHAIN|1|mxNAZQtCRBG3dYu2ufVxSsc7V3c8jh9HDM|memo';

function http429() {
    const e = new Error('Explorer returned HTTP 429 for /RBTC/api/preflight, retry after 1 seconds');
    e.code = 'EXPLORER_HTTP_429';
    throw e;
}

// An explorer whose balance listing is `rows`, marked with `freshness`, and whose
// Tier 1 dry run is rate limited.
function build({ rows, freshness, mode = 'report' }) {
    const sdk = mockSdk({
        preflight: mode,
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getToken: (t) => ({ info: { tick: String(t) }, decimals: 8 }),
            getBalances: () => rows,
            getPreflight: http429,
        },
    });
    sdk.explorer.freshness = () => freshness;
    return sdk;
}

const STALE = { stale: true, tipBlock: 416, tipAgeSeconds: 10657639 };
const ROW = [{ tick: 'XCHAIN', quantity: '1.00000000' }];

function ctxFor(sdk) {
    return new CheckContext({
        sdk, parsed: { params: {} }, source: H, mode: 'report', timeoutMs: 5000,
    });
}

describe('pre-flight balance read against a stale explorer mirror', function () {
    it('treats a missing row on a stale listing as unverified, not zero', async function () {
        const ctx = ctxFor(build({ rows: [], freshness: STALE }));
        expect(await ctx.balance(H, 'XCHAIN')).to.equal(null);
        expect(ctx.unverified.map((u) => u.check)).to.include('BALANCE_LOOKUP');
    });

    it('does not fail the verdict when Tier 1 is rate limited', async function () {
        const sdk = build({ rows: [], freshness: STALE });
        const r = await sdk.preflight(WIRE, { source: H, preflight: 'report' });
        expect(r.verdict).to.not.equal('fail');
        expect(r.findings.filter((f) => f.code === FINDING_CODES.BALANCE_INSUFFICIENT && f.severity === 'error')).to.deep.equal([]);
        expect(r.unverified.map((u) => u.check)).to.include(FINDING_CODES.BALANCE_INSUFFICIENT);
    });

    it('does not throw in enforce mode', async function () {
        const sdk = build({ rows: [], freshness: STALE, mode: 'enforce' });
        const r = await sdk.preflight(WIRE, { source: H, preflight: 'enforce' });
        expect(r.verdict).to.not.equal('fail');
    });

    it('control: a fresh empty listing is still an authoritative zero', async function () {
        const sdk = build({ rows: [], freshness: { stale: false, tipBlock: 114903 } });
        const ctx = ctxFor(sdk);
        expect(await ctx.balance(H, 'XCHAIN')).to.equal('0');
        const r = await sdk.preflight(WIRE, { source: H, preflight: 'report' });
        expect(r.findings.some((f) => f.code === FINDING_CODES.BALANCE_INSUFFICIENT && f.severity === 'error')).to.equal(true);
    });

    it('control: a stale marker with a matching row still returns the row quantity', async function () {
        const ctx = ctxFor(build({ rows: ROW, freshness: STALE }));
        expect(await ctx.balance(H, 'XCHAIN')).to.equal('1.00000000');
    });
});
