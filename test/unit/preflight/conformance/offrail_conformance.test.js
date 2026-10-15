'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier-2 pre-flight against the indexer's own verdicts. Each case is a row the
// off-rail conformance lane (2026-10-15) measured with pre-flight disagreeing with
// the indexer: F rows were false refuses, A rows false accepts. The cited
// xchain-indexer lines are the verdict each case pins.

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');

const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const DAY = 86400;

// A regtest BTC SDK (explorer coin RBTC) over the given endpoint stubs. Tier 1 is
// neutralized (feeExempt) so the Tier-2 verdict stands on its own.
function sdkFor(spec, network = 'bitcoin-regtest', coin = 'RBTC') {
    const sdk = mockSdk({ network, explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...spec } });
    sdk.explorer.coin = coin;
    return sdk;
}

function reportFor(wire, spec, opts = {}) {
    return sdkFor(spec, opts.network, opts.coin).preflight(wire, { source: opts.source || 'me', preflight: 'report' });
}

const errors = (r, code) => r.findings.filter((f) => f.severity === 'error' && (!code || f.code === code));
const hasError = (r, code) => errors(r, code).length > 0;

// Token rows in the explorer's nested /token/ shape, keyed by stored name and id.
const TOKENS = {
    JDOG: { id: 5, decimals: 0, supply: '900', max: '1000', owner: 'me' },
    EIGHT: { id: 6, decimals: 8, supply: '10', max: '0', owner: 'me' },
    XCHAIN: { id: 1, decimals: 8, supply: '100000', max: '0', owner: 'gas' },
    LOCKM: { id: 7, decimals: 0, supply: '10', max: '0', owner: 'me', lockMint: true },
    FULL: { id: 8, decimals: 0, supply: '1000', max: '1000', owner: 'me' },
};

function tokenDoc(name) {
    const t = TOKENS[name];
    return {
        info: { tick: name, tick_id: t.id, owner: t.owner, decimals: t.decimals },
        mints: { max: '0', address_max: '0' },
        supply: { current: t.supply, max: t.max, decimals: t.decimals },
        locks: { mint: !!t.lockMint, max_mint: false, max_supply: false },
    };
}

// The explorer's getToken: a canonical ^<id> by id, else exact name, else case-insensitive.
function getToken(tick) {
    const s = String(tick);
    if (s.charAt(0) === '^') {
        const hit = Object.keys(TOKENS).find((k) => String(TOKENS[k].id) === String(Number(s.substring(1))));
        return hit ? tokenDoc(hit) : notFound();
    }
    const hit = Object.keys(TOKENS).find((k) => k === s) || Object.keys(TOKENS).find((k) => k.toLowerCase() === s.toLowerCase());
    return hit ? tokenDoc(hit) : notFound();
}

const balances = (rows) => () => ({ data: rows, total: rows.length });
const SPEC = { getToken, getBalances: balances([{ tick: 'JDOG', amount: '100' }, { tick: 'XCHAIN', amount: '50' }]) };

describe('pre-flight conformance F1 caret tick balance', function () {
    // F1: tickers.js:106-111 resolves a canonical ^<id> to its row, and the ledger row is
    // keyed by that token, so the balance is the named token's balance.
    it('F1 a caret tick reads the balance of the token it names', async function () {
        const r = await reportFor('SEND|0|^5|10|' + ADDR, SPEC);
        expect(hasError(r, 'BALANCE_INSUFFICIENT')).to.equal(false);
        const over = await reportFor('SEND|0|^5|101|' + ADDR, SPEC);
        expect(hasError(over, 'BALANCE_INSUFFICIENT')).to.equal(true);
    });
});

describe('pre-flight conformance F2 balances paging', function () {
    // F2: /balances/ serves 500 rows a page; a tick past the first page is still held.
    it('F2 the balance listing is paged past the 500-row cap', async function () {
        const seen = [];
        const page1 = Array.from({ length: 500 }, (_, i) => ({ tick: 'A' + String(i).padStart(4, '0'), amount: '1' }));
        const spec = {
            getToken: (t) => (t === 'ZZZZ' ? { info: { tick: 'ZZZZ', decimals: 0 } } : getToken(t)),
            getBalances: (addr, opts = {}) => {
                seen.push(opts.page || 1);
                return (opts.page || 1) === 1 ? { data: page1, total: 501 } : { data: [{ tick: 'ZZZZ', amount: '7' }], total: 501 };
            },
        };
        const r = await reportFor('SEND|0|ZZZZ|7|' + ADDR, spec);
        expect(hasError(r, 'BALANCE_INSUFFICIENT')).to.equal(false);
        expect(seen).to.deep.equal([1, 2]);
    });
});

describe('pre-flight conformance F2 balances paging on an explorer without ?page', function () {
    it('F2 an explorer that ignores ?page leaves the balance unverified, never a refusal', async function () {
        const page1 = Array.from({ length: 500 }, (_, i) => ({ tick: 'A' + String(i).padStart(4, '0'), amount: '1' }));
        const spec = { getToken: () => ({ info: { tick: 'ZZZZ', decimals: 0 } }), getBalances: () => ({ data: page1, total: 501 }) };
        const r = await reportFor('SEND|0|ZZZZ|7|' + ADDR, spec);
        expect(hasError(r, 'BALANCE_INSUFFICIENT')).to.equal(false);
        expect(r.unverified.map((u) => u.check)).to.include('BALANCE_INSUFFICIENT');
    });
});

describe('pre-flight conformance F3 case-variant tick balance', function () {
    // F3: tickers.js:117-125 resolves a name case-insensitively.
    it('F3 a case-variant tick reads the balance of the token it resolves to', async function () {
        for (const wire of ['SEND|0|jdog|10|' + ADDR, 'DESTROY|0|Jdog|10|m', 'ORDER|0|BTC|jdog|10|0|BTC|EIGHT|1|0|||||m']) {
            const r = await reportFor(wire, SPEC);
            expect(hasError(r, 'BALANCE_INSUFFICIENT'), wire).to.equal(false);
        }
    });
});

describe('pre-flight conformance F4 cancelling dispenser', function () {
    // F4: dispense_matching.js:51 matches a dispenser whose latest status is open or cancelling.
    it('F4 a DISPENSE against a cancelling dispenser is not refused', async function () {
        const dispenser = (status) => ({ getAction: () => ({
            action: 'DISPENSER', action_index: '42', source: 'seller', give_tick: 'JDOG', give_amount: '1',
            get_amount: '0.0001', status: 'valid', state: { status, give_remaining: '10' },
        }) });
        const cancelling = await reportFor('DISPENSE|0|42|1', dispenser('cancelling'));
        expect(hasError(cancelling, 'DISPENSER_NOT_OPEN')).to.equal(false);
        const closed = await reportFor('DISPENSE|0|42|1', dispenser('closed'));
        expect(hasError(closed, 'DISPENSER_NOT_OPEN')).to.equal(true);
    });
});

describe('pre-flight conformance F5 PRICE v1 TICK', function () {
    // F5: price/v1.js:41-43 only format-checks TICK, and COIN can be another chain.
    it('F5 a PRICE v1 TICK need not exist locally, but its length is still checked', async function () {
        const r = await reportFor('PRICE|1|LTC|SOMELTCTOKEN|USD|1.5||m', { getToken: () => notFound() });
        expect(hasError(r, 'TOKEN_NOT_FOUND')).to.equal(false);
        const long = await reportFor('PRICE|1|BTC|' + 'T'.repeat(251) + '|USD|1.5||m', { getToken: () => notFound() });
        expect(hasError(long, 'VALIDATOR_SEMANTICS')).to.equal(true);
    });
});

describe('pre-flight conformance A1 amount fields', function () {
    // A1: dispenser/validate_format.js:45 judges GIVE_ESCROW as an amount.
    it('A1 a text GIVE_ESCROW is an amount-format refusal, a zero one is not', async function () {
        const r = await reportFor('DISPENSER|0|BTC|JDOG|1|0|abc|BTC||0.0001||||||||m', SPEC);
        expect(hasError(r, 'AMOUNT_FORMAT_INVALID')).to.equal(true);
        const zero = await reportFor('DISPENSER|0|BTC|JDOG|1|0|0|BTC||0.0001||||||||m', SPEC);
        expect(hasError(zero, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
    });
});

describe('pre-flight conformance A3 halt-class fields', function () {
    // A3: the indexer halts on these (normalize.js nulls the field into a NOT NULL row).
    const HALTS = ['DISPENSER|1||m', 'DISPENSER|2||1||||m', 'STAKE|1|10|', 'STAKE|2|10|', 'STAKE|3|10||5|JDOG',
        'ORDER|1|-1|m', 'ORDER|2||1800000000|||m', 'SWAP|1|-1|m', 'SWAP|1||m', 'BET|2|-1|0|5|m', 'BET|2|abc|0|5|m',
        'ORDER|1|18446744073709551616|m', 'BATCH|0|DISPENSER|1||m', 'BATCH|0|STAKE|1|10|'];
    for (const wire of HALTS) {
        it(`A3 ${wire} is a non-overridable refusal`, async function () {
            const r = await reportFor(wire, { getToken, getAction: () => notFound(), getBalances: balances([]) });
            const halt = errors(r, 'VALIDATOR_SEMANTICS').filter((f) => f.data && f.data.haltClass);
            expect(halt, wire).to.have.length(1);
            expect(halt[0].overridable).to.equal(false);
        });
    }
});

describe('pre-flight conformance A3 ordinary missing fields', function () {
    it('A3 other missing fields stay warnings', async function () {
        const r = await reportFor('ORDER|0|BTC|JDOG|1|0|BTC|EIGHT||0|||||m', SPEC);
        expect(errors(r, 'VALIDATOR_SEMANTICS')).to.deep.equal([]);
    });
});

describe('pre-flight conformance A5 native-coin tick', function () {
    // A5: send/validate.js:33-34 and siblings resolve no token for the native coin.
    const NATIVE = ['SEND|0|BTC|1|' + ADDR, 'MINT|0|BTC|1', 'DESTROY|0|BTC|1|m', 'ORDER|0|BTC|BTC|1|0|BTC|EIGHT|1|0|||||m',
        'DIVIDEND|0|BTC|EIGHT|0.00000001|m', 'AIRDROP|0|BTC|1|5|m', 'DISPENSER|0|BTC||1|0|10|BTC||0.0001||||||||m'];
    for (const wire of NATIVE) {
        it(`A5 ${wire.split('|')[0]} of the native coin is refused`, async function () {
            const r = await reportFor(wire, { ...SPEC, getAction: () => ({ action: 'LIST', status: 'valid' }) });
            expect(hasError(r, 'TOKEN_NOT_FOUND'), wire).to.equal(true);
        });
    }
});

describe('pre-flight conformance A5 cross-chain GET_TICK', function () {
    it('A5 a cross-chain ORDER GET_TICK is not judged locally', async function () {
        const r = await reportFor('ORDER|0|BTC|JDOG|1|0|LTC|LTC|1|0|' + ADDR + '||||m', SPEC);
        expect(errors(r, 'TOKEN_NOT_FOUND').filter((f) => f.data.field === 'GET_TICK')).to.deep.equal([]);
    });
});

describe('pre-flight conformance A4 MINT lock', function () {
    // A4: mint/validate.js:121-123.
    it('A4 MINT of a token with LOCK_MINT set is refused', async function () {
        const r = await reportFor('MINT|0|LOCKM|1', SPEC);
        expect(hasError(r, 'MINT_OVER_MAX')).to.equal(true);
        const open = await reportFor('MINT|0|JDOG|1', SPEC);
        expect(hasError(open, 'MINT_OVER_MAX')).to.equal(false);
    });
});

describe('pre-flight conformance A4 ISSUE supply rules', function () {
    // A4: issue/supply_rules.js:41-42, :126-127, :140-145.
    it('A4 ISSUE supply rules: MAX_SUPPLY below supply, MINT_SUPPLY over MAX_SUPPLY, cumulative cap', async function () {
        const below = await reportFor('ISSUE|0|JDOG|10||0|d', SPEC);
        expect(hasError(below, 'SUPPLY_EXCEEDED')).to.equal(true);
        const over = await reportFor('ISSUE|2|JDOG||10000|||||m', SPEC);
        expect(hasError(over, 'SUPPLY_EXCEEDED')).to.equal(true);
        const cumulative = await reportFor('ISSUE|2|FULL||1|||||m', SPEC);
        expect(hasError(cumulative, 'SUPPLY_EXCEEDED')).to.equal(true);
        const fits = await reportFor('ISSUE|2|JDOG||100|||||m', SPEC);
        expect(hasError(fits, 'SUPPLY_EXCEEDED')).to.equal(false);
    });
});

describe('pre-flight conformance A4 capability STAKE balance', function () {
    // A4: stake/capability_stake.js:69-75.
    it('A4 a capability STAKE over the gas-token balance is refused', async function () {
        const r = await reportFor('STAKE|1|51|' + 'cd'.repeat(32), SPEC);
        expect(hasError(r, 'BALANCE_INSUFFICIENT')).to.equal(true);
        const eq = await reportFor('STAKE|1|50|' + 'cd'.repeat(32), SPEC);
        expect(hasError(eq, 'BALANCE_INSUFFICIENT')).to.equal(false);
    });
});

describe('pre-flight conformance A4 DISPENSER refill balance', function () {
    // A4: dispenser/validate.js:213-215 runs the escrow balance check on a refill too.
    it('A4 a DISPENSER refill over the give-token balance is refused', async function () {
        const spec = { ...SPEC, getAction: () => ({ action: 'DISPENSER', action_index: '42', source: 'me', give_tick: 'JDOG',
            give_amount: '1', get_amount: '0.0001', status: 'valid', state: { status: 'open', give_remaining: '1' } }) };
        const r = await reportFor('DISPENSER|2|42|101||||m', spec);
        expect(hasError(r, 'BALANCE_INSUFFICIENT')).to.equal(true);
        const eq = await reportFor('DISPENSER|2|42|100||||m', spec);
        expect(hasError(eq, 'BALANCE_INSUFFICIENT')).to.equal(false);
    });
});

describe('pre-flight conformance A4 ORDER and SWAP amount decimals', function () {
    // A4: order/validate.js:76-87 and swap/validate.js:70-75.
    it('A4 ORDER and SWAP amounts are checked against token decimals', async function () {
        for (const wire of ['ORDER|0|BTC|JDOG|0.5|0|BTC|EIGHT|1|0|||||m', 'ORDER|0|BTC|JDOG|1|0|BTC|JDOG|0.5|0|||||m',
            'SWAP|0|BTC|JDOG|0.5|0|BTC|EIGHT|1|0|||||m', 'SWAP|0|BTC|JDOG|1|0|BTC|EIGHT|0.000000001|0|||||m']) {
            const r = await reportFor(wire, SPEC);
            expect(hasError(r, 'AMOUNT_FORMAT_INVALID'), wire).to.equal(true);
        }
        const ok = await reportFor('ORDER|0|BTC|JDOG|1|0|BTC|EIGHT|0.5|0|||||m', SPEC);
        expect(hasError(ok, 'AMOUNT_FORMAT_INVALID')).to.equal(false);
    });
});

describe('pre-flight conformance A4 expiration fee outside BATCH', function () {
    // A4: order/fees.js:77-78 refuses a create whose expiration fee the balance cannot pay.
    it('A4 the expiration fee of a lone ORDER or DISPENSER is checked against the gas balance', async function () {
        const exp = Math.floor(Date.now() / 1000) + 400 * DAY;
        const poor = { getToken, getBalances: balances([{ tick: 'JDOG', amount: '100' }]) };
        const order = await reportFor(`ORDER|0|BTC|JDOG|1|0|BTC|EIGHT|1|0||${exp}|||m`, poor);
        expect(hasError(order, 'BALANCE_INSUFFICIENT')).to.equal(true);
        const disp = await reportFor(`DISPENSER|0|BTC|JDOG|1|0|10|BTC||0.0001|||||${exp}|||m`, poor);
        expect(hasError(disp, 'BALANCE_INSUFFICIENT')).to.equal(true);
        const free = await reportFor(`ORDER|0|BTC|JDOG|1|0|BTC|EIGHT|1|0||${exp - 320 * DAY}|||m`, poor);
        expect(hasError(free, 'BALANCE_INSUFFICIENT')).to.equal(false);
    });
});

describe('pre-flight conformance A4 non-canonical caret tick', function () {
    // A4: tickers.js:106 takes the caret path only for a canonical id.
    it('A4 a non-canonical ^012 tick is refused even when the explorer answers it by number', async function () {
        for (const wire of ['MINT|0|^05|1', 'DIVIDEND|0|^05|EIGHT|0.00000001|m', 'AIRDROP|0|^05|1|5|m']) {
            const r = await reportFor(wire, { ...SPEC, getAction: () => ({ action: 'LIST', status: 'valid' }) });
            expect(errors(r, 'TOKEN_NOT_FOUND').some((f) => f.data.nonCanonicalCaret), wire).to.equal(true);
        }
    });
});
