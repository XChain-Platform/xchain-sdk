'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier-1 classification suite (spec §4.3). The load-bearing rule set:
// several fee-quote response shapes are NOT validity verdicts and must
// fall through to Tier 2 exclusively, never becoming a `dryrun`
// finding. feeExempt is the COINPAY false-PASS trap.

const { expect } = require('chai');
const { runTier1 } = require('../../../src/preflight/tier1.js');
const { parse } = require('../../../src/decoder/parse.js');

function sdkWith(getFeeQuote) {
    return { explorer: { getFeeQuote: async (a) => getFeeQuote(a) } };
}

async function tier1For(wire, quote) {
    const parsed = parse(wire, { validate: false });
    return runTier1({ sdk: sdkWith(() => quote), parsed, source: 's', timeoutMs: 1000 });
}

describe('pre-flight Tier 1 classification', function () {

    it('valid verdict passes through as a verdict', async function () {
        const out = await tier1For('SEND|0|JDOG|1|addr', { supported: true, valid: true, status: 'valid', blockIndex: 100 });
        expect(out.kind).to.equal('verdict');
        expect(out.valid).to.equal(true);
        expect(out.blockIndex).to.equal(100);
    });

    // /preflight echoes the fee its dry-run already computed, and Tier 1
    // carries the raw response as `quote`, which is what lands on report.quote.
    // A confirm screen reads the fee from there, so filtering it here would cost
    // the caller an extra /feequote round-trip.
    it('carries the echoed xchainFee through to the outcome quote', async function () {
        const out = await tier1For('ISSUE|0|NEWTICK', { supported: true, valid: true, status: 'valid', xchainFee: '0.50000000', blockIndex: 100 });
        expect(out.kind).to.equal('verdict');
        expect(out.quote.xchainFee).to.equal('0.50000000');
    });

    it('invalid verdict passes through with status/error', async function () {
        const out = await tier1For('SEND|0|JDOG|1|addr', { supported: true, valid: false, status: 'insufficient', error: 'balance' });
        expect(out.kind).to.equal('verdict');
        expect(out.valid).to.equal(false);
        expect(out.status).to.equal('insufficient');
    });

    it('feeExempt is NOT a verdict (COINPAY false-PASS trap)', async function () {
        const out = await tier1For('COINPAY|0|42', { supported: true, valid: true, feeExempt: true });
        expect(out.kind).to.equal('no-verdict');
        expect(out.reason).to.equal('feeExempt');
    });

    it('supported:false is NOT a verdict', async function () {
        const out = await tier1For('SEND|0|JDOG|1|addr', { supported: false });
        expect(out.kind).to.equal('no-verdict');
        expect(out.reason).to.equal('unsupported');
    });

    it('guardInert is NOT a verdict', async function () {
        const out = await tier1For('SEND|0|JDOG|1|addr', { supported: true, valid: true, guardInert: true });
        expect(out.kind).to.equal('no-verdict');
        expect(out.reason).to.equal('guardInert');
    });

    it('FEE_QUOTE_CONTROLLER_UNSUPPORTED string is NOT a verdict', async function () {
        const out = await tier1For('SEND|0|JDOG|1|addr', { supported: true, error: 'FEE_QUOTE_CONTROLLER_UNSUPPORTED' });
        expect(out.kind).to.equal('no-verdict');
        expect(out.reason).to.equal('guardInert');
    });

    it('VM denylisted actions never call the endpoint', async function () {
        let called = false;
        const parsed = parse('EXECUTE|0|9|m|p', { validate: false });
        const out = await runTier1({ sdk: { explorer: { getFeeQuote: async () => { called = true; return {}; } } }, parsed, source: 's', timeoutMs: 1000 });
        expect(out.kind).to.equal('no-verdict');
        expect(out.reason).to.equal('denylisted');
        expect(called).to.equal(false);
    });

    it('busy/retryable responses are unavailable', async function () {
        const out = await tier1For('SEND|0|JDOG|1|addr', { busy: true });
        expect(out.kind).to.equal('unavailable');
    });

    it('endpoint throw is unavailable, never a throw out of Tier 1', async function () {
        const parsed = parse('SEND|0|JDOG|1|addr', { validate: false });
        const out = await runTier1({ sdk: { explorer: { getFeeQuote: async () => { throw new Error('boom'); } } }, parsed, source: 's', timeoutMs: 1000 });
        expect(out.kind).to.equal('unavailable');
    });

    it('no verdict field in a supported response is unavailable', async function () {
        const out = await tier1For('SEND|0|JDOG|1|addr', { supported: true });
        expect(out.kind).to.equal('unavailable');
    });

    it('no explorer client is unavailable', async function () {
        const parsed = parse('SEND|0|JDOG|1|addr', { validate: false });
        const out = await runTier1({ sdk: {}, parsed, source: 's', timeoutMs: 1000 });
        expect(out.kind).to.equal('unavailable');
    });

    describe('/preflight endpoint preference', function () {
        it('prefers getPreflight when the explorer exposes it', async function () {
            let usedPreflight = false, usedFeeQuote = false;
            const sdk = { explorer: {
                getPreflight: async () => { usedPreflight = true; return { supported: true, valid: true, status: 'valid', blockIndex: 7 }; },
                getFeeQuote: async () => { usedFeeQuote = true; return {}; },
            } };
            const parsed = parse('SEND|0|JDOG|1|addr', { validate: false });
            const out = await runTier1({ sdk, parsed, source: 's', timeoutMs: 1000 });
            expect(usedPreflight).to.equal(true);
            expect(usedFeeQuote).to.equal(false);
            expect(out.kind).to.equal('verdict');
            expect(out.blockIndex).to.equal(7);
        });

        it('falls back to feequote on a 404 from getPreflight', async function () {
            let usedFeeQuote = false;
            const sdk = { explorer: {
                getPreflight: async () => { const e = new Error('nf'); e.code = 'EXPLORER_HTTP_404'; throw e; },
                getFeeQuote: async () => { usedFeeQuote = true; return { supported: true, valid: true, status: 'valid' }; },
            } };
            const parsed = parse('SEND|0|JDOG|1|addr', { validate: false });
            const out = await runTier1({ sdk, parsed, source: 's', timeoutMs: 1000 });
            expect(usedFeeQuote).to.equal(true);
            expect(out.kind).to.equal('verdict');
        });

        it('denied:true from /preflight is a no-verdict (denylisted)', async function () {
            const sdk = { explorer: { getPreflight: async () => ({ supported: false, denied: true, valid: null }) } };
            const parsed = parse('SEND|0|JDOG|1|addr', { validate: false });
            const out = await runTier1({ sdk, parsed, source: 's', timeoutMs: 1000 });
            expect(out.kind).to.equal('no-verdict');
            expect(out.reason).to.equal('denylisted');
        });

        it('guardInert:true boolean from /preflight is a no-verdict', async function () {
            const sdk = { explorer: { getPreflight: async () => ({ supported: true, guardInert: true, valid: null }) } };
            const parsed = parse('SEND|0|CTRL|1|addr', { validate: false });
            const out = await runTier1({ sdk, parsed, source: 's', timeoutMs: 1000 });
            expect(out.kind).to.equal('no-verdict');
            expect(out.reason).to.equal('guardInert');
        });
    });
});

// The fee mode reaches the network dry run (found live on regtest).
//
// /preflight answers for the CHAIN'S DEFAULT mode when `feeMode` is absent, so
// a Bitcoin action whose author opted into paying the protocol fee in coin was
// judged against their XCHAIN balance instead. Measured on the venue: the same
// endpoint, same action, same source answers `invalid: insufficient funds
// (FEE)` with no feeMode and `valid` with `feeMode=native`. The user that hits
// it is exactly the one the native lane exists for - somebody with no XCHAIN -
// and what they are shown is "Will likely fail" with Approve disabled behind
// "Sign anyway", which is the override that teaches people to click through
// real refusals.
describe('pre-flight Tier 1 fee mode', function () {

    function sdkCapturing(seen) {
        return {
            explorer: {
                getPreflight: async (args) => { seen.push(args); return { supported: true, valid: true, status: 'valid' }; },
                getFeeQuote: async (args) => { seen.push(args); return { supported: true, valid: true, status: 'valid' }; },
            },
        };
    }

    it('passes feeMode to the dry run when the caller states one', async function () {
        const seen = [];
        const parsed = parse('ISSUE|0|NEWTICK', { validate: false });
        await runTier1({ sdk: sdkCapturing(seen), parsed, source: 's', feeMode: 'native', timeoutMs: 1000 });
        expect(seen).to.have.lengthOf(1);
        expect(seen[0].feeMode).to.equal('native');
    });

    // An `undefined` key would serialize into the query string as the literal
    // "undefined", which the endpoint rejects as an invalid feeMode - so the
    // absent case has to be absent, not undefined.
    it('omits the key entirely when the caller states nothing', async function () {
        const seen = [];
        const parsed = parse('ISSUE|0|NEWTICK', { validate: false });
        await runTier1({ sdk: sdkCapturing(seen), parsed, source: 's', timeoutMs: 1000 });
        expect(seen).to.have.lengthOf(1);
        expect(Object.prototype.hasOwnProperty.call(seen[0], 'feeMode')).to.equal(false);
    });
});
