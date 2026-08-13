'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Intra-BATCH projected-delta suite (spec §4.4/§4.7). The load-bearing
// rule: a legitimate MINT-then-SEND-the-minted batch must NOT
// false-alarm on the SEND leg, because the MINT credited the balance.

const { expect } = require('chai');
const { mockSdk } = require('./_mock.js');

function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: 'report', ...opts });
}

const has = (r, code, sev) => r.findings.some(f => f.code === code && (!sev || f.severity === sev));

describe('pre-flight intra-BATCH projection', function () {

    it('MINT-then-SEND-the-minted does not false-error on the SEND leg', async function () {
        // Start balance 0; MINT 10 credits it; SEND 5 is then covered.
        const r = await reportFor('BATCH|0|MINT|0|JDOG|10;SEND|0|JDOG|5|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '0' }],
        });
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
    });

    it('SEND-more-than-minted still errors', async function () {
        const r = await reportFor('BATCH|0|MINT|0|JDOG|3;SEND|0|JDOG|5|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '0' }],
        });
        // minted 3, balance 0 -> effective 3, send 5 exceeds
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
    });

    it('carries the non-atomicity standing warning', async function () {
        const r = await reportFor('BATCH|0|MINT|0|JDOG|1', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '0' }],
        });
        expect(has(r, 'BATCH_NOT_ATOMIC', 'warning')).to.equal(true);
    });

    it('an unparseable sub-command errors on that command only', async function () {
        const r = await reportFor('BATCH|0|NOPE|0|x;MINT|0|JDOG|1', {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [],
        });
        expect(has(r, 'PARSE_INVALID', 'error')).to.equal(true);
        const f = r.findings.find(x => x.code === 'PARSE_INVALID');
        expect(f.data.commandIndex).to.equal(0);
    });

    it('after an unprojectable command, a dependent balance error caps at warning', async function () {
        // SWEEP moves everything the address holds and cannot be projected
        // client-side; a following SEND that may depend on it must not hard-block.
        const r = await reportFor('BATCH|0|SWEEP|0|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4|1;'
            + 'SEND|0|NEWT|500|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: (t) => (t === 'NEWT' ? { tick: 'NEWT', decimals: '0' } : null),
            getBalances: () => [{ tick: 'NEWT', amount: '0' }],
        });
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
    });

    it('ISSUE with MINT_SUPPLY is projectable: the SEND of that supply does not false-error', async function () {
        // F10: ISSUE used to be unprojectable outright, which downgraded every
        // later balance finding to a warning. It is priced now, and its
        // MINT_SUPPLY credit is what keeps this legitimate shape clean.
        const r = await reportFor('BATCH|0|ISSUE|0|NEWT|1000|1000|0||500;'
            + 'SEND|0|NEWT|500|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: () => null,
            getBalances: () => [{ tick: 'NEWT', amount: '0' }, { tick: 'XCHAIN', amount: '100' }],
        });
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
        expect(has(r, 'BALANCE_INSUFFICIENT', 'warning')).to.equal(false);
    });

    it('ISSUE-then-SEND-more-than-minted now errors instead of degrading to a warning', async function () {
        const r = await reportFor('BATCH|0|ISSUE|0|NEWT|1000|1000|0||500;'
            + 'SEND|0|NEWT|900|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {
            getToken: () => null,
            getBalances: () => [{ tick: 'NEWT', amount: '0' }, { tick: 'XCHAIN', amount: '100' }],
        });
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
    });
});

// F10 / row 12: the batch-wide issuance-fee budget. 250 child issuances cost
// 250 x ISSUE_SUBTOKEN and no per-command check can see the total.
describe('pre-flight BATCH issuance-fee budget', function () {

    const CHILDREN = (n) => 'BATCH|0|' + Array.from({ length: n }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
    const feeFinding = (r) => r.findings.find(f => f.code === 'BALANCE_INSUFFICIENT' && f.data && f.data.tick === 'XCHAIN');

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

// F7 / row 12: the global command cap, surfaced once.
describe('pre-flight BATCH command cap', function () {

    const capFinding = (r) => r.findings.filter(f => f.code === 'BATCH_LIMIT_EXCEEDED'
        && f.data && f.data.action === 'COMMAND');

    it('251 commands raises exactly one cap finding', async function () {
        const wire = 'BATCH|0|' + Array.from({ length: 251 }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
        const r = await reportFor(wire, { getToken: () => null, getBalances: () => [{ tick: 'XCHAIN', amount: '999' }] });
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].data.count).to.equal(251);
        expect(caps[0].data.limit).to.equal(250);
    });

    it('exactly 250 commands raises none', async function () {
        const wire = 'BATCH|0|' + Array.from({ length: 250 }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
        const r = await reportFor(wire, { getToken: () => null, getBalances: () => [{ tick: 'XCHAIN', amount: '999' }] });
        expect(capFinding(r)).to.have.length(0);
    });

    it('the check owns the cap when the caller supplies a ParsedAction with no findings', async function () {
        // A pre-parsed input (validate:false) carries no validator findings, so
        // the decoder-side cap never reaches the report and checks/batch.js is
        // the only thing standing between the caller and a batch the chain
        // rejects wholesale.
        const { parse } = require('../../../src/decoder/parse.js');
        const wire = 'BATCH|0|' + Array.from({ length: 251 }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
        const parsed = parse(wire, { validate: false });
        expect(parsed.validation).to.equal(null);
        const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }),
            getToken: () => null, getBalances: () => [{ tick: 'XCHAIN', amount: '999' }] } });
        const r = await sdk.preflight(parsed, { source: 'me', preflight: 'report' });
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].data.count).to.equal(251);
    });
});
