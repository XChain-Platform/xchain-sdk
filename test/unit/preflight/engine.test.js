'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight engine suite: modes, input normalization, report shape,
// tier precedence, and the severity/trust model (spec §4.1-4.3).

const { expect } = require('chai');
const { mockSdk } = require('./helpers/mock.js');
const { SDKPreflightError } = require('../../../src/utils/errors.js');

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
});
