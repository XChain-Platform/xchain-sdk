'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier-2 mirrors of the bridge landing's ISSUE and DESTROY validity changes
// (the base bridge spec and the token bridge spec): the case-folded reserved
// names, the gas tick off BTC, the tick-namespace creation rules, ISSUE format 7
// (the bridge opt-in), the DESTROY supply-path refusals, and XBRIDGE's protocol
// fee. Every test drives the report through sdk.preflight with the explorer
// stubbed, so what is asserted is the verdict a wallet would see.

const { expect } = require('chai');
const { mockSdk, notFound } = require('./_mock.js');
const { getCoinConfig } = require('../../../src/coins/index.js');
const constants = require('../../../src/preflight/constants.js');

// `coin` is the explorer's chain code (BTC / TBTC / RDOGE ...); omit it to model an
// SDK with no chain coin configured. Tier 1 is neutralized (feeExempt => no verdict).
function reportFor(wire, explorerSpec, opts = {}) {
    const { coin, ...rest } = opts;
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    if (coin) sdk.explorer.coin = coin;
    return sdk.preflight(wire, { source: rest.source || 'me', preflight: rest.mode || 'report', ...rest });
}

const find = (r, code, rule) => r.findings.find(f => f.code === code && (!rule || (f.data && f.data.rule === rule)));
const has = (r, code, sev) => r.findings.some(f => f.code === code && (!sev || f.severity === sev));
const unverified = (r, check) => (r.unverified || []).some(u => u.check === check);

const fresh = { getToken: () => notFound() };
const mine = (extra = {}) => ({ getToken: () => ({ tick: 'JDOG', owner: 'me', ...extra }) });

describe('pre-flight bridge landing: ISSUE tick rules', function () {

    describe('reserved names, case-folded and unconditional', function () {
        it('a lower-cased coin root is refused like the upper-cased one', async function () {
            for (const tick of ['btc', 'BTC', 'Doge', 'ltc']) {
                const r = await reportFor(`ISSUE|0|${tick}|1000`, fresh, { coin: 'BTC' });
                const f = find(r, 'TICK_FORMAT', 'reserved');
                expect(f, tick).to.not.equal(undefined);
                expect(f.severity, tick).to.equal('warning');
            }
        });

        it('the gas tick from an ordinary source is reserved on mainnet', async function () {
            const r = await reportFor('ISSUE|0|XCHAIN|1000', fresh, { coin: 'BTC' });
            expect(find(r, 'TICK_FORMAT', 'reserved')).to.not.equal(undefined);
            expect(find(r, 'TICK_FORMAT', 'btc-only')).to.equal(undefined);
        });

        it('the GAS address may issue the gas tick on BTC', async function () {
            const gas = getCoinConfig('BTC', 'mainnet').addresses.GAS;
            const r = await reportFor('ISSUE|0|XCHAIN|1000', fresh, { coin: 'BTC', source: gas });
            expect(has(r, 'TICK_FORMAT')).to.equal(false);
        });

        it('on regtest every source clears the reserved gate for the gas tick, but only on BTC', async function () {
            const ok = await reportFor('ISSUE|0|xchain|1000', fresh, { coin: 'RBTC' });
            expect(has(ok, 'TICK_FORMAT')).to.equal(false);
            const off = await reportFor('ISSUE|0|xchain|1000', fresh, { coin: 'RDOGE' });
            expect(find(off, 'TICK_FORMAT', 'reserved')).to.equal(undefined);
            expect(find(off, 'TICK_FORMAT', 'btc-only')).to.not.equal(undefined);
        });

        it('the gas tick is refused off BTC even from that chain\'s GAS address', async function () {
            const gas = getCoinConfig('DOGE', 'mainnet').addresses.GAS;
            const r = await reportFor('ISSUE|0|XCHAIN|1000', fresh, { coin: 'DOGE', source: gas });
            const f = find(r, 'TICK_FORMAT', 'btc-only');
            expect(f).to.not.equal(undefined);
            expect(f.data.coin).to.equal('DOGE');
        });

        it('with no chain coin configured the gas tick is declared, never guessed', async function () {
            const r = await reportFor('ISSUE|0|XCHAIN|1000', fresh);
            expect(has(r, 'TICK_FORMAT')).to.equal(false);
            expect(unverified(r, 'ISSUE_GAS_TICK')).to.equal(true);
        });

        it('a coin root needs no chain coin to be refused', async function () {
            const r = await reportFor('ISSUE|0|ltc|1000', fresh);
            expect(find(r, 'TICK_FORMAT', 'reserved')).to.not.equal(undefined);
        });
    });

    describe('tick namespace (activation-keyed, creation-only)', function () {
        it('a new top-level name under four characters warns on the floor', async function () {
            const r = await reportFor('ISSUE|0|ABC|1000', fresh, { coin: 'BTC' });
            const f = find(r, 'TICK_FORMAT', 'length');
            expect(f).to.not.equal(undefined);
            expect(f.severity).to.equal('warning');
        });

        it('a four-character name clears the floor', async function () {
            const r = await reportFor('ISSUE|0|ABCD|1000', fresh, { coin: 'BTC' });
            expect(has(r, 'TICK_FORMAT')).to.equal(false);
        });

        it('a reserved future root warns as reserved, and reserved wins over short', async function () {
            const r = await reportFor('ISSUE|0|ETH|1000', fresh, { coin: 'BTC' });
            expect(find(r, 'TICK_FORMAT', 'reserved-root')).to.not.equal(undefined);
            expect(find(r, 'TICK_FORMAT', 'length')).to.equal(undefined);
        });

        it('the future-root list is matched case-folded and covers the four-plus letter codes', async function () {
            for (const tick of ['eth', 'Near', 'hbar']) {
                const r = await reportFor(`ISSUE|0|${tick}|1000`, fresh, { coin: 'BTC' });
                expect(find(r, 'TICK_FORMAT', 'reserved-root'), tick).to.not.equal(undefined);
            }
        });

        it('every vendored future root is refused as a fresh create', async function () {
            for (const root of constants.RESERVED_FUTURE_ROOTS) {
                const r = await reportFor(`ISSUE|0|${root}|1000`, fresh, { coin: 'BTC' });
                expect(find(r, 'TICK_FORMAT', 'reserved-root'), root).to.not.equal(undefined);
            }
        });

        it('an existing row keeps its short name: the rule is creation-only', async function () {
            const r = await reportFor('ISSUE|1|ABC|new desc', { getToken: () => ({ tick: 'ABC', owner: 'me' }) }, { coin: 'BTC' });
            expect(has(r, 'TICK_FORMAT')).to.equal(false);
            expect(has(r, 'NOT_OWNER')).to.equal(false);
        });

        it('a dotted child is measured on its full length, so a short child of a root passes', async function () {
            const r = await reportFor('ISSUE|0|ABCD.X|1000', fresh, { coin: 'BTC' });
            expect(has(r, 'TICK_FORMAT')).to.equal(false);
        });

        it('a caret reference is never a short create', async function () {
            const r = await reportFor('ISSUE|1|^12|new desc', fresh, { coin: 'BTC' });
            expect(find(r, 'TICK_FORMAT', 'length')).to.equal(undefined);
        });

        it('a short name with the row lookup down is declared, not warned', async function () {
            const r = await reportFor('ISSUE|0|ABC|1000', { getToken: () => { throw new Error('boom'); } }, { coin: 'BTC' });
            expect(has(r, 'TICK_FORMAT')).to.equal(false);
            expect(unverified(r, 'ISSUE_TICK_NAMESPACE')).to.equal(true);
        });

        it('a long unlisted name with the row lookup down declares nothing about the namespace', async function () {
            const r = await reportFor('ISSUE|0|PEPECASH|1000', { getToken: () => { throw new Error('boom'); } }, { coin: 'BTC' });
            expect(unverified(r, 'ISSUE_TICK_NAMESPACE')).to.equal(false);
        });

        it('the floor and the vendored roots match the indexer constants', function () {
            expect(constants.MIN_NEW_TOP_LEVEL_TICK_LENGTH).to.equal(4);
            expect(constants.RESERVED_FUTURE_ROOTS).to.have.lengthOf(53);
            expect(new Set(constants.RESERVED_FUTURE_ROOTS).size).to.equal(53);
            for (const root of constants.RESERVED_FUTURE_ROOTS)
                expect(root, root).to.equal(root.toUpperCase());
        });
    });

    describe('format 7: the bridge opt-in', function () {
        it('a well-formed opt-in by the owner raises no error and declares the activation and the policy exclusion', async function () {
            const r = await reportFor('ISSUE|7|JDOG|DOGE,LTC|6|0', mine(), { coin: 'BTC' });
            expect(r.findings.filter(f => f.severity === 'error')).to.deep.equal([]);
            expect(unverified(r, 'ISSUE_BRIDGE_ACTIVATION')).to.equal(true);
            expect(unverified(r, 'ISSUE_BRIDGE_POLICY_EXCLUSION')).to.equal(true);
        });

        it('the activation is not declared on formats that exist below it', async function () {
            const r = await reportFor('ISSUE|1|JDOG|new desc', mine(), { coin: 'BTC' });
            expect(unverified(r, 'ISSUE_BRIDGE_ACTIVATION')).to.equal(false);
        });

        it('an unknown tick is a TOKEN_NOT_FOUND error, unlike every creating format', async function () {
            const r = await reportFor('ISSUE|7|NEWTOK|DOGE', fresh, { coin: 'BTC' });
            const f = find(r, 'TOKEN_NOT_FOUND');
            expect(f).to.not.equal(undefined);
            expect(f.severity).to.equal('error');
            expect(f.overridable).to.equal(true);
            const create = await reportFor('ISSUE|0|NEWTOK|1000', fresh, { coin: 'BTC' });
            expect(has(create, 'TOKEN_NOT_FOUND')).to.equal(false);
        });

        it('the owner gate still applies', async function () {
            const r = await reportFor('ISSUE|7|JDOG|DOGE', mine({ owner: 'someone-else' }), { coin: 'BTC' });
            expect(has(r, 'NOT_OWNER', 'error')).to.equal(true);
        });

        it('a subasset is refused on the whole format', async function () {
            const r = await reportFor('ISSUE|7|JDOG.SUB|-', { getToken: () => ({ tick: 'JDOG.SUB', owner: 'me' }) }, { coin: 'BTC' });
            expect(find(r, 'TICK_FORMAT', 'subasset')).to.not.equal(undefined);
        });

        it('a caret reference that resolves to a subasset is refused on the resolved name', async function () {
            const r = await reportFor('ISSUE|7|^12|DOGE', { getToken: () => ({ tick: 'JDOG.SUB', owner: 'me' }) }, { coin: 'BTC' });
            const f = find(r, 'TICK_FORMAT', 'subasset');
            expect(f).to.not.equal(undefined);
            expect(f.data.tick).to.equal('JDOG.SUB');
        });

        it('BRIDGE_CHAINS must name other chain coins', async function () {
            const bad = ['ETH', 'BTC', 'DOGE,BTC', 'DOGE, LTC', 'XCHAIN'];
            for (const chains of bad) {
                const r = await reportFor(`ISSUE|7|JDOG|${chains}`, mine(), { coin: 'BTC' });
                const f = r.findings.find(x => x.code === 'VALIDATOR_SEMANTICS' && x.data.field === 'BRIDGE_CHAINS');
                expect(f, chains).to.not.equal(undefined);
                expect(f.severity, chains).to.equal('error');
                expect(f.overridable, chains).to.equal(false);
            }
            for (const chains of ['DOGE', 'doge,ltc', 'LTC,DOGE', '-', '']) {
                const r = await reportFor(`ISSUE|7|JDOG|${chains}`, mine(), { coin: 'BTC' });
                expect(has(r, 'VALIDATOR_SEMANTICS'), JSON.stringify(chains)).to.equal(false);
            }
        });

        it('the self-chain half of BRIDGE_CHAINS follows the configured chain', async function () {
            const r = await reportFor('ISSUE|7|JDOG|BTC', mine(), { coin: 'TDOGE' });
            expect(has(r, 'VALIDATOR_SEMANTICS')).to.equal(false);
            const self = await reportFor('ISSUE|7|JDOG|DOGE', mine(), { coin: 'TDOGE' });
            expect(has(self, 'VALIDATOR_SEMANTICS', 'error')).to.equal(true);
        });

        it('without a chain coin only the membership half is judged', async function () {
            const r = await reportFor('ISSUE|7|JDOG|BTC', mine());
            expect(has(r, 'VALIDATOR_SEMANTICS')).to.equal(false);
            const bad = await reportFor('ISSUE|7|JDOG|ETH', mine());
            expect(has(bad, 'VALIDATOR_SEMANTICS', 'error')).to.equal(true);
        });

        it('MIN_DEPTH is digits only', async function () {
            for (const depth of ['abc', '1.5', '-1', '1e2']) {
                const r = await reportFor(`ISSUE|7|JDOG||${depth}`, mine(), { coin: 'BTC' });
                const f = r.findings.find(x => x.code === 'VALIDATOR_SEMANTICS' && x.data.field === 'MIN_DEPTH');
                expect(f, depth).to.not.equal(undefined);
                expect(f.severity, depth).to.equal('error');
            }
            for (const depth of ['0', '12', '']) {
                const r = await reportFor(`ISSUE|7|JDOG||${depth}`, mine(), { coin: 'BTC' });
                expect(has(r, 'VALIDATOR_SEMANTICS'), JSON.stringify(depth)).to.equal(false);
            }
        });

        it('LOCK_BRIDGE is 0 or 1', async function () {
            const r = await reportFor('ISSUE|7|JDOG|||2', mine(), { coin: 'BTC' });
            const f = r.findings.find(x => x.code === 'VALIDATOR_SEMANTICS' && x.data.field === 'LOCK_BRIDGE');
            expect(f).to.not.equal(undefined);
            expect(f.severity).to.equal('error');
            for (const lock of ['0', '1', '']) {
                const ok = await reportFor(`ISSUE|7|JDOG|||${lock}`, mine(), { coin: 'BTC' });
                expect(has(ok, 'VALIDATOR_SEMANTICS'), JSON.stringify(lock)).to.equal(false);
            }
        });

        it('the field rules run even when the row lookup is down', async function () {
            const r = await reportFor('ISSUE|7|JDOG|ETH|x|2', { getToken: () => { throw new Error('boom'); } }, { coin: 'BTC' });
            const fields = r.findings.filter(f => f.code === 'VALIDATOR_SEMANTICS').map(f => f.data.field);
            expect(fields).to.have.members(['BRIDGE_CHAINS', 'MIN_DEPTH', 'LOCK_BRIDGE']);
        });
    });
});

describe('pre-flight bridge landing: DESTROY supply-path refusals', function () {
    const held = (tick) => ({
        getToken: () => ({ tick }),
        getBalances: () => [{ tick, amount: '100' }],
    });

    it('the gas tick off BTC is a use-XBRIDGE-v1 warning', async function () {
        for (const coin of ['DOGE', 'TLTC', 'RDOGE']) {
            const r = await reportFor('DESTROY|0|XCHAIN|1', held('XCHAIN'), { coin });
            const f = find(r, 'TICK_FORMAT', 'use-xbridge-v1');
            expect(f, coin).to.not.equal(undefined);
            expect(f.severity, coin).to.equal('warning');
        }
    });

    it('the gas tick on BTC destroys as it always has', async function () {
        for (const coin of ['BTC', 'TBTC', 'RBTC']) {
            const r = await reportFor('DESTROY|0|XCHAIN|1', held('XCHAIN'), { coin });
            expect(has(r, 'TICK_FORMAT'), coin).to.equal(false);
        }
    });

    it('a bridged copy from another chain is a use-XBRIDGE-v4 warning', async function () {
        const r = await reportFor('DESTROY|0|BTC.PEPE|1', held('BTC.PEPE'), { coin: 'DOGE' });
        const f = find(r, 'TICK_FORMAT', 'use-xbridge-v4');
        expect(f).to.not.equal(undefined);
        expect(f.data.origin).to.equal('BTC');
        const folded = await reportFor('DESTROY|0|btc.PEPE|1', held('btc.PEPE'), { coin: 'LTC' });
        expect(find(folded, 'TICK_FORMAT', 'use-xbridge-v4')).to.not.equal(undefined);
    });

    it('a same-chain child of a coin root is a native subasset, not a copy', async function () {
        const r = await reportFor('DESTROY|0|BTC.PEPE|1', held('BTC.PEPE'), { coin: 'BTC' });
        expect(has(r, 'TICK_FORMAT')).to.equal(false);
    });

    it('a prefix that is not a chain coin, or a deeper dotted name, is not a copy', async function () {
        for (const tick of ['ETH.PEPE', 'BTC.PEPE.CASH', 'PEPE']) {
            const r = await reportFor(`DESTROY|0|${tick}|1`, held(tick), { coin: 'DOGE' });
            expect(has(r, 'TICK_FORMAT'), tick).to.equal(false);
        }
    });

    it('every leg of a multi-leg destroy is judged', async function () {
        const spec = {
            getToken: (t) => ({ tick: t }),
            getBalances: () => [{ tick: 'PEPE', amount: '100' }, { tick: 'BTC.PEPE', amount: '100' }],
        };
        const r = await reportFor('DESTROY|1|PEPE|1|BTC.PEPE|1|m', spec, { coin: 'DOGE' });
        const f = find(r, 'TICK_FORMAT', 'use-xbridge-v4');
        expect(f).to.not.equal(undefined);
        expect(f.data.tick).to.equal('BTC.PEPE');
    });

    it('with no chain coin configured both refusals are declared, never guessed', async function () {
        const r = await reportFor('DESTROY|0|XCHAIN|1', held('XCHAIN'));
        expect(has(r, 'TICK_FORMAT')).to.equal(false);
        expect(unverified(r, 'DESTROY_BRIDGE_SUPPLY')).to.equal(true);
    });

    it('SEND carries neither refusal', async function () {
        const r = await reportFor('SEND|0|BTC.PEPE|1|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', held('BTC.PEPE'), { coin: 'DOGE' });
        expect(has(r, 'TICK_FORMAT')).to.equal(false);
        expect(unverified(r, 'DESTROY_BRIDGE_SUPPLY')).to.equal(false);
    });
});

describe('pre-flight bridge landing: XBRIDGE charges a protocol fee', function () {
    it('XBRIDGE is on FEE_CHARGING_ACTIONS', function () {
        expect(constants.FEE_CHARGING_ACTIONS).to.include('XBRIDGE');
    });

    it('a lock and a burn both warn about native-fee forfeiture', async function () {
        const lock = await reportFor('XBRIDGE|0|DOGE|DDogeAddressDoesNotMatterHere|1|m', held(), { coin: 'BTC' });
        expect(has(lock, 'NATIVE_FEE_FORFEIT', 'warning')).to.equal(true);
        const burn = await reportFor('XBRIDGE|1|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4|1|m', held(), { coin: 'DOGE' });
        expect(has(burn, 'NATIVE_FEE_FORFEIT', 'warning')).to.equal(true);
    });

    function held() {
        return { getToken: () => ({ tick: 'XCHAIN' }), getBalances: () => [{ tick: 'XCHAIN', amount: '100' }] };
    }
});
