'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight engine suite: modes, input normalization, report shape,
// tier precedence, and the severity/trust model (spec §4.1-4.3).

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');

describe('pre-flight engine', function () {

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
