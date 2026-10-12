'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Intra-BATCH projected-delta suite (spec §4.4/§4.7). The load-bearing
// rule: a legitimate MINT-then-SEND-the-minted batch must NOT
// false-alarm on the SEND leg, because the MINT credited the balance.

const { expect, has, reportFor } = require('./batch.test/helpers/setup.js');

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

    // A settled SEND writes a debit AND a credit, so a leg addressed to the
    // source nets to zero for every later command. A projection that shares
    // DESTROY's debit-only branch false-errors the next command.
    const held10 = {
        getToken: () => ({ tick: 'JDOG', decimals: '0' }),
        getBalances: () => [{ tick: 'JDOG', amount: '10' }],
    };
    const OTHER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

    it('a self-send leaves the balance intact for the next command', async function () {
        const r = await reportFor(`BATCH|0|SEND|0|JDOG|10|me;SEND|0|JDOG|10|${OTHER}`, held10);
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
    });

    it('a send to another address still errors the next command', async function () {
        const r = await reportFor(`BATCH|0|SEND|0|JDOG|10|${OTHER};SEND|0|JDOG|10|${OTHER}`, held10);
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
    });

    it('DESTROY stays debit-only: a following self-send is not rescued', async function () {
        const r = await reportFor('BATCH|0|DESTROY|0|JDOG|10;SEND|0|JDOG|10|me', held10);
        expect(has(r, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
    });

    it('a mixed multi-leg SEND debits only the leg that leaves the wallet', async function () {
        // 10 held; one leg of 5 to self, one leg of 5 away -> 5 left.
        const ok = await reportFor(`BATCH|0|SEND|1|JDOG|5|me|5|${OTHER}|m;SEND|0|JDOG|5|${OTHER}`, held10);
        expect(has(ok, 'BALANCE_INSUFFICIENT', 'error')).to.equal(false);
        const over = await reportFor(`BATCH|0|SEND|1|JDOG|5|me|5|${OTHER}|m;SEND|0|JDOG|6|${OTHER}`, held10);
        expect(has(over, 'BALANCE_INSUFFICIENT', 'error')).to.equal(true);
    });
});

describe('pre-flight intra-BATCH projection', function () {

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
