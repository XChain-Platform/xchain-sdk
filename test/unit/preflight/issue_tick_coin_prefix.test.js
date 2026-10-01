'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk, notFound } = require('./helpers/mock.js');

const VERDICT = 'invalid: TICK (reserved)';

function reportFor(tick, { network = 'bitcoin-regtest', coin = 'RBTC', existing = false,
    lookupError = false } = {}) {
    const sdk = mockSdk({
        network,
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getStatus: () => ({ last_block: { [coin]: 10 } }),
            getToken: () => {
                if (lookupError) throw new Error('lookup unavailable');
                if (existing) return { tick, owner: 'me' };
                return notFound();
            },
        },
    });
    sdk.explorer.coin = coin;
    return sdk.preflight(`ISSUE|0|${tick}|1000`, { source: 'me', preflight: 'report' });
}

const reservedFinding = (report) => report.findings.find(
    (finding) => finding.data && finding.data.verdict === VERDICT);

describe('ISSUE coin-qualified tick prefix pre-flight', function () {
    it('blocks fresh coin and future-root prefixes on regtest', async function () {
        for (const [tick, root] of [['BTC:FOO', 'BTC'], ['eth:FOO', 'ETH']]) {
            const report = await reportFor(tick);
            const finding = reservedFinding(report);
            expect(finding, tick).to.include({
                code: 'VALIDATOR_SEMANTICS',
                severity: 'error',
                message: VERDICT,
                overridable: false,
            });
            expect(finding.data, tick).to.include({ field: 'TICK', tick, root, verdict: VERDICT });
        }
    });

    it('passes the same prefixes while the gate is unarmed on mainnet', async function () {
        for (const tick of ['BTC:FOO', 'eth:FOO']) {
            const report = await reportFor(tick, { network: 'bitcoin-mainnet', coin: 'BTC' });
            expect(reservedFinding(report), tick).to.equal(undefined);
        }
    });

    it('passes an existing coin-qualified tick', async function () {
        const report = await reportFor('BTC:OLD', { existing: true });
        expect(reservedFinding(report)).to.equal(undefined);
    });

    it('passes a colon whose prefix is not a coin root', async function () {
        const report = await reportFor('FOO:BTC');
        expect(reservedFinding(report)).to.equal(undefined);
    });

    it('declares an unavailable token lookup instead of guessing', async function () {
        const report = await reportFor('BTC:FOO', { lookupError: true });
        expect(reservedFinding(report)).to.equal(undefined);
        expect(report.unverified).to.deep.include({
            check: 'ISSUE_TICK_COIN_PREFIX',
            reason: 'token lookup unavailable',
        });
    });
});
