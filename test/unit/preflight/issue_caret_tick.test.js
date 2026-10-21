'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { parseMap } = require('../../../bin/check-preflight-drift.js');
const { mockSdk, notFound } = require('./helpers/mock.js');

const DRIFT_MAP = path.join(__dirname, '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');

async function reportFor(network, coin, getToken) {
    const sdk = mockSdk({
        explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), getToken },
        network,
    });
    sdk.explorer.coin = coin;
    return sdk.preflight('ISSUE|0|^7|1000', { source: 'me', preflight: 'report' });
}

const finding = (report) => report.findings.find(
    (item) => item.code === 'TICK_FORMAT'
        && item.data
        && item.data.rule === 'ISSUE_CARET_TICK_NO_CREATE');

describe('pre-flight ISSUE caret TICK create warning', function () {
    it('warns on regtest and names the armed indexer rule', async function () {
        const result = await reportFor('bitcoin-regtest', 'RBTC', () => notFound());
        const warning = finding(result);

        expect(warning).to.not.equal(undefined);
        expect(warning.severity).to.equal('warning');
        expect(warning.message).to.contain('ISSUE_CARET_TICK_NO_CREATE');
        expect(warning.message).to.contain('from genesis on regtest');
    });

    it('warns on testnet before the rule is armed', async function () {
        const result = await reportFor('bitcoin-testnet', 'TBTC', () => notFound());

        expect(finding(result)).to.include({ severity: 'warning' });
    });

    it('does not warn on mainnet where proactive warning is out of scope', async function () {
        const result = await reportFor('bitcoin-mainnet', 'BTC', () => notFound());

        expect(finding(result)).to.equal(undefined);
        expect(result.unverified.some(
            (item) => item.check === 'ISSUE_CARET_TICK_NO_CREATE'
        )).to.equal(false);
    });

    it('does not warn when the caret resolves to an existing token', async function () {
        const result = await reportFor('bitcoin-regtest', 'RBTC', () => ({
            tick: 'EXISTING', owner: 'me', decimals: 0,
        }));

        expect(finding(result)).to.equal(undefined);
    });

    it('declares an unavailable lookup instead of treating it as a missing token', async function () {
        const result = await reportFor('bitcoin-regtest', 'RBTC', () => {
            throw new Error('offline');
        });

        expect(finding(result)).to.equal(undefined);
        expect(result.unverified).to.deep.include({
            check: 'ISSUE_CARET_TICK_NO_CREATE',
            reason: 'token lookup unavailable',
        });
    });

    it('keeps the caret rule covered by the issue handler drift map', function () {
        const issue = parseMap(DRIFT_MAP).find((row) => row.handler === 'src/actions/issue/');
        const map = fs.readFileSync(DRIFT_MAP, 'utf8');
        const heading = '### 2026-10-20 - ISSUE_CARET_TICK_NO_CREATE gate is added';
        const start = map.indexOf(heading);
        const end = map.indexOf('\n### ', start + heading.length);
        const entry = map.slice(start, end);

        expect(issue, 'checks/issue.js must map the complete issue handler').to.exist;
        expect(issue.hash).to.match(/^[0-9a-f]{64}$/);
        expect(start, 'caret rule drift-map review entry').to.be.greaterThan(-1);
        expect(entry).to.include('issue/tick_rules.js');
        expect(entry).to.include('ISSUE_CARET_TICK_NO_CREATE');
        expect(entry).to.include('checks/issue.js');
    });
});
