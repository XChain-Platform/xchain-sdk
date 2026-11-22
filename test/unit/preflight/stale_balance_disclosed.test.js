'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk } = require('./helpers/mock.js');
const { CheckContext } = require('../../../src/preflight/context.js');
const { FINDING_CODES } = require('../../../src/preflight/constants.js');

const H = 'n4LCDuwBxvTXAGQuswuTDAicNxtgUwxjDa';
const DEST = 'mxNAZQtCRBG3dYu2ufVxSsc7V3c8jh9HDM';
const STALE = { stale: true, tipBlock: 416, tipAgeSeconds: 10657639 };
const FRESH = { stale: false, tipBlock: 114903 };

function http429() {
    const e = new Error('Explorer returned HTTP 429 for /RBTC/api/preflight, retry after 1 seconds');
    e.code = 'EXPLORER_HTTP_429';
    throw e;
}

// An explorer whose balance listing holds `quantity` of XCHAIN, marked with
// `freshness`, and whose Tier 1 dry run is rate limited or answers `preflight`.
function build({ quantity, freshness, getPreflight = http429, mode = 'report' }) {
    const sdk = mockSdk({
        preflight: mode,
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getToken: (t) => ({ info: { tick: String(t) }, decimals: 8 }),
            getBalances: () => [{ tick: 'XCHAIN', quantity }],
            getPreflight,
        },
    });
    sdk.explorer.freshness = () => freshness;
    return sdk;
}

const wire = (amount) => `SEND|0|XCHAIN|${amount}|${DEST}|memo`;
const balanceErrors = (r) => r.findings.filter((f) => f.code === FINDING_CODES.BALANCE_INSUFFICIENT && f.severity === 'error');

describe('pre-flight stale balance read that is not zero', function () {
    it('discloses a stale positive balance as unverified and still returns it', async function () {
        const sdk = build({ quantity: '5.00000000', freshness: STALE });
        const ctx = new CheckContext({ sdk, parsed: { params: {} }, source: H, mode: 'report', timeoutMs: 5000 });
        expect(await ctx.balance(H, 'XCHAIN')).to.equal('5.00000000');
        expect(ctx.unverified.map((u) => u.check)).to.include('BALANCE_LOOKUP');
        expect(ctx.unverified.find((u) => u.check === 'BALANCE_LOOKUP').reason).to.match(/stale mirror/);
    });

    it('a stale balance that covers the total is disclosed, not a silent pass', async function () {
        const sdk = build({ quantity: '5.00000000', freshness: STALE });
        const r = await sdk.preflight(wire('1'), { source: H, preflight: 'report' });
        expect(balanceErrors(r)).to.deep.equal([]);
        expect(r.unverified.map((u) => u.check)).to.include('BALANCE_LOOKUP');
    });

    it('a stale shortfall is a warning tagged staleMirror when Tier 1 gives no verdict', async function () {
        const sdk = build({ quantity: '0.50000000', freshness: STALE });
        const r = await sdk.preflight(wire('1'), { source: H, preflight: 'report' });
        expect(balanceErrors(r)).to.deep.equal([]);
        const f = r.findings.find((x) => x.code === FINDING_CODES.BALANCE_INSUFFICIENT);
        expect(f.severity).to.equal('warning');
        expect(f.data.staleMirror).to.equal(true);
        expect(f.overridable).to.equal(undefined);
        expect(r.verdict).to.equal('warn');
    });

    it('a stale shortfall does not throw in enforce mode when Tier 1 gives no verdict', async function () {
        const sdk = build({ quantity: '0.50000000', freshness: STALE, mode: 'enforce' });
        const r = await sdk.preflight(wire('1'), { source: H, preflight: 'enforce' });
        expect(r.verdict).to.equal('warn');
    });

    it('control: a fresh shortfall is still a certified error', async function () {
        const sdk = build({ quantity: '0.50000000', freshness: FRESH });
        const r = await sdk.preflight(wire('1'), { source: H, preflight: 'report' });
        const errors = balanceErrors(r);
        expect(errors).to.have.lengthOf(1);
        expect(errors[0].data.staleMirror).to.equal(undefined);
        expect(r.verdict).to.equal('fail');
    });

    it('control: a stale shortfall is still an error when the network dry run rejects it', async function () {
        const getPreflight = () => ({ valid: false, status: 'insufficient funds', reason: 'insufficient funds' });
        const sdk = build({ quantity: '0.50000000', freshness: STALE, getPreflight });
        const r = await sdk.preflight(wire('1'), { source: H, preflight: 'report' });
        expect(r.verdict).to.equal('fail');
    });
});
