'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight engine suite: modes, input normalization, report shape,
// tier precedence, and the severity/trust model (spec §4.1-4.3).

const { expect } = require('chai');
const { mockSdk, notFound } = require('./_mock.js');
const { SDKFormatError, SDKPreflightError } = require('../../../src/errors.js');

describe('pre-flight engine', function () {

    describe('modes', function () {
        it('false skips entirely (returns null)', async function () {
            const sdk = mockSdk({ preflight: false });
            expect(await sdk.preflight('SEND|0|JDOG|1|addr')).to.equal(null);
        });

        it('per-call false overrides an enforcing default', async function () {
            const sdk = mockSdk({ preflight: 'enforce' });
            expect(await sdk.preflight('SEND|0|JDOG|1|bad', { preflight: false, source: 's' })).to.equal(null);
        });

        it('enforce throws SDKPreflightError on fail (SDK default mode)', async function () {
            const sdk = mockSdk({ preflight: 'enforce', explorerSpec: null });
            let err;
            try { await sdk.preflight('SEND|0|JDOG|1|not-an-address', { source: 's' }); }
            catch (e) { err = e; }
            expect(err).to.be.instanceof(SDKPreflightError);
            expect(err.code).to.equal('PREFLIGHT_FAIL');
            expect(err.report.verdict).to.equal('fail');
        });

        it('report never throws (SDK default mode)', async function () {
            const sdk = mockSdk({ preflight: 'report', explorerSpec: null });
            const r = await sdk.preflight('SEND|0|JDOG|1|not-an-address', { source: 's' });
            expect(r.verdict).to.equal('fail');
        });

        it('local mode makes zero network calls', async function () {
            let calls = 0;
            const sdk = mockSdk({ explorerSpec: {
                getBalances: () => { calls++; return []; },
                getToken: () => { calls++; return {}; },
                getFeeQuote: () => { calls++; return {}; },
            } });
            const r = await sdk.preflight('SEND|0|JDOG|1|addr', { source: 's', preflight: 'local' });
            expect(calls).to.equal(0);
            expect(r.unverified.length).to.be.greaterThan(0);
        });
    });

    describe('input normalization', function () {
        it('unparseable string throws SDKFormatError, not SDKPreflightError', async function () {
            const sdk = mockSdk();
            let err;
            try { await sdk.preflight('!!!garbage', { preflight: 'local' }); } catch (e) { err = e; }
            expect(err).to.be.instanceof(SDKFormatError);
            expect(err).to.not.be.instanceof(SDKPreflightError);
        });

        it('accepts a ParsedAction directly', async function () {
            const { parse } = require('../../../src/decoder/parse.js');
            const sdk = mockSdk();
            const r = await sdk.preflight(parse('MINT|0|JDOG|5'), { source: 's', preflight: 'local' });
            expect(r).to.have.property('verdict');
        });

        it('accepts an {action, params} object', async function () {
            const sdk = mockSdk();
            const r = await sdk.preflight({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'x' } }, { source: 's', preflight: 'local' });
            expect(r).to.have.property('verdict');
        });
    });

    describe('report shape (§4.2)', function () {
        it('has every normative field', async function () {
            const sdk = mockSdk({ explorerSpec: null });
            const r = await sdk.preflight('MINT|0|JDOG|5', { source: 's', preflight: 'local' });
            expect(r).to.include.keys(['schemaVersion', 'verdict', 'restricted', 'checksRun', 'findings', 'unverified', 'quote', 'stateHeight', 'elapsedMs']);
            expect(r.schemaVersion).to.equal(1);
            expect(r.restricted).to.equal(false);
            expect(r.checksRun).to.be.an('array');
        });
    });

    describe('tier precedence (§4.2)', function () {
        it('Tier-1 valid downgrades a contradicting Tier-2 client error to info', async function () {
            // Token missing (client would error TOKEN_NOT_FOUND) but the
            // dry-run says valid: the server is authoritative.
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => notFound(),
                getBalances: () => [],
                getFeeQuote: () => ({ supported: true, valid: true, status: 'valid', blockIndex: 5 }),
            } });
            const r = await sdk.preflight('SEND|0|MISSING|1|addr', { source: 's', preflight: 'report' });
            const tokenFinding = r.findings.find(f => f.code === 'TOKEN_NOT_FOUND');
            expect(tokenFinding.severity).to.equal('info');
            expect(r.verdict).to.not.equal('fail');
            expect(r.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(true);
        });

        it('Tier-1 invalid adds an overridable dryrun error', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                getFeeQuote: () => ({ supported: true, valid: false, status: 'some-reject' }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|1|addr', { source: 's', preflight: 'report' });
            const dry = r.findings.find(f => f.code === 'DRYRUN_INVALID');
            expect(dry.severity).to.equal('error');
            expect(dry.overridable).to.equal(true);
            expect(dry.source).to.equal('dryrun');
            expect(r.verdict).to.equal('fail');
        });

        it('Tier-1 unavailable leaves Tier-2 errors standing', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => notFound(),
                getBalances: () => [],
                getFeeQuote: () => { throw new Error('down'); },
            } });
            const r = await sdk.preflight('SEND|0|MISSING|1|addr', { source: 's', preflight: 'report' });
            const tokenFinding = r.findings.find(f => f.code === 'TOKEN_NOT_FOUND');
            expect(tokenFinding.severity).to.equal('error');
            expect(r.findings.some(f => f.code === 'DRYRUN_UNAVAILABLE')).to.equal(true);
        });
    });

    describe('severity/trust model (§4.2)', function () {
        it('local-provable errors are non-overridable', async function () {
            const sdk = mockSdk({ explorerSpec: null });
            const r = await sdk.preflight('SEND|0|JDOG|1|not-an-address', { source: 's', preflight: 'local' });
            const f = r.findings.find(x => x.code === 'DEST_ADDRESS_INVALID');
            expect(f.severity).to.equal('error');
            expect(f.overridable).to.equal(false);
        });

        it('network-sourced errors are overridable', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => notFound(),
                getBalances: () => [],
            } });
            const r = await sdk.preflight('SEND|0|MISSING|1|addr', { source: 's', preflight: 'report' });
            const f = r.findings.find(x => x.code === 'TOKEN_NOT_FOUND');
            expect(f.severity).to.equal('error');
            expect(f.overridable).to.equal(true);
        });

        it('a passing report emits DRYRUN_VALID info so tests see why it passed', async function () {
            const sdk = mockSdk({ explorerSpec: {
                getToken: () => ({ tick: 'JDOG' }),
                getBalances: () => [{ tick: 'JDOG', amount: '100' }],
                getFeeQuote: () => ({ supported: true, valid: true, status: 'valid', blockIndex: 9 }),
            } });
            const r = await sdk.preflight('SEND|0|JDOG|1|addr', { source: 's', preflight: 'report' });
            expect(r.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(true);
            expect(r.stateHeight).to.equal(9);
        });
    });
});
