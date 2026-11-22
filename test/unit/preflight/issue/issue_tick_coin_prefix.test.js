'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');

const VERDICT = 'invalid: TICK (reserved)';

function reportFor(tick, { network = 'bitcoin-regtest', coin = 'RBTC', existing = false,
    lookupError = false, tokenPending = false, statusPending = false, statusError = false,
    status, onStatus, preflight = 'report', timeoutMs } = {}) {
    const sdk = mockSdk({
        network,
        explorerSpec: {
            getFeeQuote: () => ({ feeExempt: true }),
            getStatus: () => {
                if (onStatus) onStatus();
                if (statusPending) return new Promise(() => {});
                if (statusError) throw new Error('status unavailable');
                return status === undefined ? { last_block: { [coin]: 10 } } : status;
            },
            getToken: () => {
                if (tokenPending) return new Promise(() => {});
                if (lookupError) throw new Error('lookup unavailable');
                if (existing) return { tick, owner: 'me' };
                return notFound();
            },
        },
    });
    sdk.explorer.coin = coin;
    return sdk.preflight(`ISSUE|0|${tick}|1000`, { source: 'me', preflight, timeoutMs });
}

const reservedFinding = (report) => report.findings.find(
    (finding) => finding.data && finding.data.verdict === VERDICT);
const expectUnverified = (report, reason) => expect(report.unverified).to.deep.include({
    check: 'ISSUE_TICK_COIN_PREFIX', reason,
});

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
        expectUnverified(report, 'token lookup unavailable');
    });

    it('bounds an unavailable activation lookup instead of hanging', async function () {
        const started = Date.now();
        const report = await reportFor('BTC:FOO', {
            network: 'bitcoin-testnet', coin: 'TBTC', statusPending: true,
        });
        expect(Date.now() - started).to.be.lessThan(3000);
        expect(reservedFinding(report)).to.equal(undefined);
        expectUnverified(report, 'activation lookup unavailable');
    });

    it('declares a failed activation lookup instead of treating the gate as unarmed', async function () {
        const report = await reportFor('BTC:FOO', {
            network: 'bitcoin-testnet', coin: 'TBTC', statusError: true,
        });
        expect(reservedFinding(report)).to.equal(undefined);
        expectUnverified(report, 'activation lookup unavailable');
    });

    it('keeps local mode network-free on armed testnet and regtest planes', async function () {
        for (const plane of [
            { network: 'bitcoin-testnet', coin: 'TBTC' },
            { network: 'bitcoin-regtest', coin: 'RBTC' },
        ]) {
            let statusReads = 0;
            await reportFor('BTC:FOO', Object.assign({}, plane, {
                preflight: 'local', onStatus: () => { statusReads += 1; },
            }));
            expect(statusReads, plane.network).to.equal(0);
        }
    });

    it('does not start the activation read after the run deadline is spent', async function () {
        let statusReads = 0;
        const report = await reportFor('BTC:FOO', {
            network: 'bitcoin-testnet', coin: 'TBTC', tokenPending: true, timeoutMs: 30,
            onStatus: () => { statusReads += 1; },
        });
        expect(statusReads).to.equal(0);
        expectUnverified(report, 'activation lookup unavailable');
    });

    it('declares a missing activation tip unverified instead of inactive', async function () {
        const report = await reportFor('BTC:FOO', {
            network: 'bitcoin-testnet', coin: 'TBTC', status: { last_block: {} },
        });
        expect(reservedFinding(report)).to.equal(undefined);
        expectUnverified(report, 'activation lookup unavailable');
    });

    it('distinguishes reached and unreached testnet activation tips', async function () {
        const active = await reportFor('BTC:FOO', {
            network: 'bitcoin-testnet', coin: 'TBTC',
            status: { last_block: { TBTC: 154776 } },
        });
        const inactive = await reportFor('BTC:FOO', {
            network: 'bitcoin-testnet', coin: 'TBTC',
            status: { last_block: { TBTC: 1000 } },
        });
        expect(reservedFinding(active)).to.exist;
        expect(reservedFinding(inactive)).to.equal(undefined);
    });
});
