'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The native-coin balance read comes from /address/, which carries the same
// explorer freshness marker as the token listing. A zero read from a mirror the
// explorer marks stale may predate the latest funding, so it is unverified, not
// an authoritative empty balance that fails a SEND.

const { expect } = require('chai');
const { mockSdk } = require('./helpers/mock.js');
const { CheckContext } = require('../../../src/preflight/context.js');
const { FINDING_CODES } = require('../../../src/preflight/constants.js');
const { checkSend } = require('../../../src/preflight/checks/send.js');

const H = 'n4LCDuwBxvTXAGQuswuTDAicNxtgUwxjDa';
const STALE = { stale: true, tipBlock: 416, tipAgeSeconds: 10657639 };

function build({ confirmed, freshness }) {
    const sdk = mockSdk({
        preflight: 'report',
        explorerSpec: { getFeeQuote: () => ({ feeExempt: true }) },
    });
    sdk.explorer.coin = 'BTC';
    sdk.explorer.freshness = () => freshness;
    sdk.getAddress = async () => ({ balances: { confirmed } });
    return sdk;
}

function ctxFor(sdk) {
    return new CheckContext({
        sdk, parsed: { params: {} }, source: H, mode: 'report', timeoutMs: 5000,
    });
}

// A native-coin leg as the balance check sees it: TICK names the chain coin.
function sendCtx(sdk) {
    const parsed = { action: 'SEND', version: '0', params: { TICK: 'BTC', AMOUNT: '1' } };
    return new CheckContext({ sdk, parsed, source: H, mode: 'report', timeoutMs: 5000 });
}

describe('pre-flight native balance read against a stale explorer mirror', function () {
    it('treats a zero native balance on a stale mirror as unverified, not zero', async function () {
        for (const zero of ['0', '0.00000000', '-0']) {
            const ctx = ctxFor(build({ confirmed: zero, freshness: STALE }));
            expect(await ctx.balance(H, 'BTC'), zero).to.equal(null);
            expect(ctx.unverified.map((u) => u.check), zero).to.include('NATIVE_BALANCE_LOOKUP');
        }
    });

    it('a stale zero does not raise BALANCE_INSUFFICIENT; the check lands unverified', async function () {
        const ctx = sendCtx(build({ confirmed: '0', freshness: STALE }));
        await checkSend(ctx);
        expect(ctx.findings.filter((f) => f.code === FINDING_CODES.BALANCE_INSUFFICIENT)).to.deep.equal([]);
        expect(ctx.unverified.map((u) => u.check)).to.include(FINDING_CODES.BALANCE_INSUFFICIENT);
    });

    it('control: a fresh zero still fails the balance check as an error', async function () {
        const ctx = sendCtx(build({ confirmed: '0', freshness: { stale: false, tipBlock: 114903 } }));
        await checkSend(ctx);
        expect(ctx.findings.some((f) => f.code === FINDING_CODES.BALANCE_INSUFFICIENT && f.severity === 'error')).to.equal(true);
    });

    it('control: a fresh zero native balance is still an authoritative zero', async function () {
        const sdk = build({ confirmed: '0', freshness: { stale: false, tipBlock: 114903 } });
        const ctx = ctxFor(sdk);
        expect(await ctx.balance(H, 'BTC')).to.equal('0');
        expect(ctx.unverified.map((u) => u.check)).to.not.include('NATIVE_BALANCE_LOOKUP');
    });

    it('control: a stale marker with a positive native balance still returns it', async function () {
        const ctx = ctxFor(build({ confirmed: '1.50000000', freshness: STALE }));
        expect(await ctx.balance(H, 'BTC')).to.equal('1.50000000');
    });

    it('control: no freshness marker leaves a zero native balance authoritative', async function () {
        const ctx = ctxFor(build({ confirmed: '0', freshness: null }));
        expect(await ctx.balance(H, 'BTC')).to.equal('0');
    });
});
