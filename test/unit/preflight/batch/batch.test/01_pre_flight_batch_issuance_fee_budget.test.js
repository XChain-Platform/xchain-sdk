'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./helpers/setup.js');

// F10: the batch-wide issuance-fee budget. 250 child issuances cost
// 250 x ISSUE_SUBTOKEN and no per-command check can see the total.
const CHILDREN = (n) => 'BATCH|0|' + Array.from({ length: n }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
const feeFinding = (r) => r.findings.find(f => f.code === 'BALANCE_INSUFFICIENT' && f.data && f.data.tick === 'XCHAIN');

describe('pre-flight BATCH issuance-fee budget', function () {

    it('an underfunded 250-child batch is an ERROR, not a warning', async function () {
        const r = await reportFor(CHILDREN(250), {
            getToken: () => null,
            getBalances: () => [{ tick: 'XCHAIN', amount: '0' }],
        });
        const f = feeFinding(r);
        expect(f, 'a fee finding was raised').to.exist;
        expect(f.severity).to.equal('error');
        // The chain's own whole-batch collapse: not even the cheapest fee is covered.
        expect(f.data.wholeBatch).to.equal(true);
        expect(f.data.cheapest).to.equal('0.5');
        expect(f.data.total).to.equal('125');
    });

    it('a funded 250-child batch raises nothing', async function () {
        const r = await reportFor(CHILDREN(250), {
            getToken: () => null,
            getBalances: () => [{ tick: 'XCHAIN', amount: '125' }],
        });
        expect(feeFinding(r)).to.equal(undefined);
    });

    it('a PARTIALLY funded batch warns with the count that lands, and never errors', async function () {
        // Gas is billed greedily in list order, so a source holding gas for K of
        // N lands exactly K commands; erroring on the SUM would refuse a
        // transaction the chain accepts.
        const r = await reportFor(CHILDREN(250), {
            getToken: () => null,
            getBalances: () => [{ tick: 'XCHAIN', amount: '10' }],
        });
        const f = feeFinding(r);
        expect(f.severity).to.equal('warning');
        expect(f.data.affordable).to.equal(20);
        expect(f.data.wholeBatch).to.equal(undefined);
    });
});

describe('pre-flight BATCH issuance-fee budget', function () {

    it('one non-ISSUE command disables the whole-batch collapse, exactly as it does on-chain', async function () {
        const r = await reportFor('BATCH|0|SEND|0|NEWT|1|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4;'
            + 'ISSUE|0|JDOG.1|1;ISSUE|0|JDOG.2|1', {
            getToken: (t) => (t === 'NEWT' ? { tick: 'NEWT', decimals: '0' } : null),
            getBalances: () => [{ tick: 'NEWT', amount: '5' }, { tick: 'XCHAIN', amount: '0' }],
        });
        const f = feeFinding(r);
        expect(f.severity).to.equal('warning');
    });

    it('a re-issue of an existing TICK is free and raises nothing', async function () {
        const r = await reportFor('BATCH|0|ISSUE|0|JDOG|1000;ISSUE|0|JDOG|2000', {
            getToken: () => ({ tick: 'JDOG', decimals: '0', info: { owner: 'me' } }),
            getBalances: () => [{ tick: 'XCHAIN', amount: '0' }],
        });
        expect(feeFinding(r)).to.equal(undefined);
    });

    it('a caret TICK is not priced client-side, so no fee verdict is claimed', async function () {
        const r = await reportFor('BATCH|0|ISSUE|0|^12|1;ISSUE|0|^13|1', {
            getToken: () => null,
            getBalances: () => [{ tick: 'XCHAIN', amount: '0' }],
        });
        expect(feeFinding(r)).to.equal(undefined);
    });

    it('native fee mode raises nothing and says why', async function () {
        const r = await reportFor(CHILDREN(250), {
            getToken: () => null,
            getBalances: () => [{ tick: 'XCHAIN', amount: '0' }],
        }, { feeMode: 'native' });
        expect(feeFinding(r)).to.equal(undefined);
        expect(r.unverified.some(u => u.check === 'BALANCE_INSUFFICIENT'
            && /native-coin output/.test(u.reason))).to.equal(true);
    });
});
