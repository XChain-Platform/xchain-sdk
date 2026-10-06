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

describe('x402 balance lookups page past the first page', () => {
    const rowsOf = (n, tick, from = 0) => Array.from({ length: n }, (_, i) => ({ tick: tick + (from + i), amount: '1', source: 'P', status: 'valid' }));

    it('dispenser finds a holding on page two', async () => {
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
    });

    it('dispenser stops after a short first page', async () => {
        const calls = [];
        const ctx = Object.assign({}, methods, {
            requireSignature: false,
            dispenser: { holdTick: 'HOLD', minBalance: '1' },
            explorer: { getBalances: async (a, o) => { calls.push(o.page); return { data: rowsOf(3, 'X') }; } },
        });
        const res = await ctx.verifyDispenser({ payer: 'P' });
        assert.strictEqual(res.code, 'X402_INSUFFICIENT_HOLDING');
        assert.deepStrictEqual(calls, [1]);
    });

    it('deposit sums deposits across pages', async () => {
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
    });
});
