// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const methods = require('../../../src/utils/x402/payment_verification.js');

const invoice = { payTo: 'bc1qpayto', tick: 'GAS', amount: '5', nonce: 'a'.repeat(32) };
const send = (dest, tick = 'GAS') => ({ tick, amount: '5', destination: dest, memo: invoice.nonce });

describe('x402 zero-conf matcher caret ids', () => {
    it('accepts a canonical ^id destination and tick', () => {
        assert.strictEqual(methods.outputMatches(invoice, send('^12', '^7'), { payToId: '12', tickId: '7' }), true);
    });

    it('rejects a non-canonical ^id the indexer would refuse', () => {
        for (const id of ['0', '012', '1.5', '-1'])
            assert.strictEqual(methods.outputMatches(invoice, send('^' + id), { payToId: id, tickId: null }), false, id);
        assert.strictEqual(methods.outputMatches(invoice, send('bc1qpayto', '^007'), { payToId: null, tickId: '007' }), false);
    });

    it('still matches the literal form without ids', () => {
        assert.strictEqual(methods.outputMatches(invoice, send('bc1qpayto')), true);
    });

    it('does not cache a non-canonical address id', async () => {
        const ctx = Object.assign({}, methods, {
            explorer: {
                getAddress: async () => ({ info: { address_id: '0' } }),
                getToken: async () => ({ info: { tick_id: '09' } }),
            },
        });
        assert.deepStrictEqual(await ctx.resolveWireIds(invoice), { payToId: null, tickId: null });
    });
});

const rowsOf = (n, tick, from = 0) => Array.from({ length: n }, (_, i) => ({ tick: tick + (from + i), amount: '1', source: 'P', status: 'valid' }));

async function findsHoldingOnPageTwo() {
    const calls = [];
    const ctx = Object.assign({}, methods, {
        requireSignature: false,
        dispenser: { holdTick: 'HOLD', minBalance: '1' },
        explorer: {
            getBalances: async (addr, o) => {
                calls.push(o.page);
                return o.page === 1
                    ? { data: rowsOf(500, 'X'), total: 501 }
                    : { data: [{ tick: 'hold', amount: '2' }], total: 501 };
            },
        },
    });
    const res = await ctx.verifyDispenser({ payer: 'P' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(calls, [1, 2]);
}

async function stopsAfterShortFirstPage() {
    const calls = [];
    const ctx = Object.assign({}, methods, {
        requireSignature: false,
        dispenser: { holdTick: 'HOLD', minBalance: '1' },
        explorer: { getBalances: async (a, o) => { calls.push(o.page); return { data: rowsOf(3, 'X') }; } },
    });
    const res = await ctx.verifyDispenser({ payer: 'P' });
    assert.strictEqual(res.code, 'X402_INSUFFICIENT_HOLDING');
    assert.deepStrictEqual(calls, [1]);
}

async function sumsDepositsAcrossPages() {
    const os = require('os'), fs = require('fs'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-dep-'));
    const dep = (n) => Array.from({ length: n }, () => ({ source: 'P', tick: 'GAS', amount: '1', status: 'valid' }));
    const ctx = Object.assign({}, methods, {
        requireSignature: false,
        _depositLocks: new Map(),
        deposit: { depositAddress: 'D', tick: 'GAS', pricePerCall: '1', ledgerDir: dir },
        explorer: { getSends: async (q, t, o) => ({ data: dep(o.page === 1 ? 100 : 20), total: 120 }) },
    });
    const res = await ctx.verifyDeposit({ payer: 'P' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.remaining, '119');
    fs.rmSync(dir, { recursive: true, force: true });
}

async function pagesByDistinctActions() {
    const os = require('os'), fs = require('fs'), path = require('path');
    const dir = path.join(os.tmpdir(), 'x402-dep-' + process.pid + '-' + Date.now());
    fs.mkdirSync(dir, { recursive: false });
    const calls = [];
    const ctx = Object.assign({}, methods, {
        requireSignature: false,
        _depositLocks: new Map(),
        deposit: { depositAddress: 'D', tick: 'GAS', pricePerCall: '1', ledgerDir: dir },
        explorer: { getSends: async (q, t, o) => {
            calls.push(o.page);
            const first = (o.page - 1) * o.limit, end = Math.min(o.page * o.limit, 150);
            const data = [];
            for (let action_index = first; action_index < end; action_index++)
                data.push({ action_index, source: 'P', tick: 'GAS', amount: '1', status: 'valid' },
                    { action_index, source: 'P', tick: 'GAS', amount: '1', status: 'valid' });
            return { data, total: 150 };
        } },
    });
    const res = await ctx.verifyDeposit({ payer: 'P' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.remaining, '299');
    assert.deepStrictEqual(calls, [1, 2]);
}

async function recognizesShortActionPage() {
    const os = require('os'), fs = require('fs'), path = require('path');
    const dir = path.join(os.tmpdir(), 'x402-short-' + process.pid + '-' + Date.now());
    fs.mkdirSync(dir, { recursive: false });
    const calls = [];
    const data = [];
    for (let action_index = 0; action_index < 60; action_index++)
        data.push({ action_index, source: 'P', tick: 'GAS', amount: '1' },
            { action_index, source: 'P', tick: 'GAS', amount: '1' });
    const ctx = Object.assign({}, methods, {
        requireSignature: false, _depositLocks: new Map(),
        deposit: { depositAddress: 'D', tick: 'GAS', pricePerCall: '1', ledgerDir: dir },
        explorer: { getSends: async (q, t, o) => { calls.push(o.page); return { data }; } },
    });
    const res = await ctx.verifyDeposit({ payer: 'P' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(calls, [1]);
}

describe('x402 balance lookups page past the first page', () => {
    it('dispenser finds a holding on page two', findsHoldingOnPageTwo);
    it('dispenser stops after a short first page', stopsAfterShortFirstPage);
    it('deposit sums deposits across pages', sumsDepositsAcrossPages);
    it('deposit pages by distinct actions while retaining every leg', pagesByDistinctActions);
    it('deposit recognizes a short page in action units', recognizesShortActionPage);
});
