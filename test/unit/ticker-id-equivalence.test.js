// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Ticker NAME vs TICK_ID (^N) equivalence across every ticker-bearing ACTION.
//
// A token may be referenced by its full name (TOKENA) or by its numeric id with
// a caret prefix (^11). This proves the SDK accepts and serializes BOTH forms
// for every action that carries a ticker field, and that the two forms produce
// structurally identical action strings differing ONLY in the token reference.
// (The indexer-side proof that both resolve to the same token lives in
// xchain-indexer/test/unit/db.queries.test.js.)

const { expect } = require('chai');
const { XChainSDK } = require('../../index.js');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Each case: the action, its ticker field(s), and a minimal set of valid
// non-ticker fields. The ticker fields get filled with names in one variant and
// ^ids in the other.
const CASES = [
    { action: 'SEND',     tickFields: ['TICK'],                  base: { AMOUNT: '1', DESTINATION: ADDR } },
    { action: 'MINT',     tickFields: ['TICK'],                  base: { AMOUNT: '1', DESTINATION: ADDR } },
    { action: 'DESTROY',  tickFields: ['TICK'],                  base: { AMOUNT: '1' } },
    { action: 'AIRDROP',  tickFields: ['TICK'],                  base: { AMOUNT: '1', LIST_ACTION_INDEX: '5' } },
    { action: 'CALLBACK', tickFields: ['TICK'],                  base: {} },
    { action: 'DEPOSIT',  tickFields: ['TICK'],                  base: { CONTRACT_ACTION_INDEX: '5', QUANTITY: '1' } },
    { action: 'WITHDRAW', tickFields: ['TICK'],                  base: { CONTRACT_ACTION_INDEX: '5', QUANTITY: '1' } },
    { action: 'DIVIDEND', tickFields: ['TICK', 'DIVIDEND_TICK'], base: { AMOUNT: '1' } },
    { action: 'ORDER',    tickFields: ['GIVE_TICK', 'GET_TICK'], base: {
        GIVE_COIN: 'BTC', GIVE_AMOUNT: '1', GIVE_OWNERSHIP: 0,
        GET_COIN: 'BTC',  GET_AMOUNT: '1',  GET_OWNERSHIP: 0,
        GET_ADDRESS: ADDR, EXPIRATION: '100' } },
    { action: 'SWAP',     tickFields: ['GIVE_TICK', 'GET_TICK'], base: {
        GIVE_COIN: 'BTC', GIVE_AMOUNT: '1', GIVE_OWNERSHIP: 0,
        GET_COIN: 'BTC',  GET_AMOUNT: '1',  GET_OWNERSHIP: 0,
        GET_ADDRESS: ADDR, EXPIRATION: '100' } },
    { action: 'DISPENSER', tickFields: ['GIVE_TICK', 'GET_TICK'], base: {
        GIVE_COIN: 'BTC', GIVE_AMOUNT: '1', GIVE_OWNERSHIP: 0, GIVE_ESCROW: '1',
        GET_COIN: 'BTC',  GET_AMOUNT: '1',
        GET_ADDRESS: ADDR, FIAT_CODE: '', FIAT_AMOUNT: '', ORACLE_ADDRESS: '', EXPIRATION: '100' } },
];

// Names and the ids they map to, applied positionally to a case's tickFields.
const NAMES = ['TOKENA', 'TOKENB'];
const IDS   = ['^11', '^22'];

describe('Ticker NAME vs TICK_ID (^N) equivalence', function () {

    // compactTickers:false so createAction never reaches out to resolve names;
    // we pass the ticker reference (name or ^id) explicitly and check serialization.
    const sdk = new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });

    function buildWith(tickValues, c) {
        const params = Object.assign({}, c.base);
        c.tickFields.forEach((f, i) => { params[f] = tickValues[i]; });
        // Use the synchronous inner builder: pure validate + format-select + serialize.
        return sdk.actions.createAction({ action: c.action, params }).actionString;
    }

    for (const c of CASES) {
        const names = c.tickFields.map((_, i) => NAMES[i]);
        const ids   = c.tickFields.map((_, i) => IDS[i]);

        it(`${c.action}: serializes with ticker NAME(s) [${names.join(', ')}]`, function () {
            const str = buildWith(names, c);
            expect(str).to.be.a('string');
            for (const n of names) expect(str.split('|')).to.include(n);
        });

        it(`${c.action}: serializes with TICK_ID(s) [${ids.join(', ')}]`, function () {
            const str = buildWith(ids, c);
            expect(str).to.be.a('string');
            for (const id of ids) expect(str.split('|')).to.include(id);
        });

        it(`${c.action}: NAME and ^id forms are identical except for the token reference`, function () {
            const nameStr = buildWith(names, c);
            const idStr   = buildWith(ids, c);
            // Substituting each ^id back to its name must reproduce the name form
            // exactly. This proves nothing else in the action shifted.
            let normalized = idStr;
            ids.forEach((id, i) => { normalized = normalized.split(id).join(names[i]); });
            expect(normalized).to.equal(nameStr);
        });
    }

    it('rejects a ^id with a non-numeric body on a reference field', function () {
        expect(() => sdk.actions.createAction({
            action: 'SEND', params: { TICK: '^abc', AMOUNT: '1', DESTINATION: ADDR }
        })).to.throw();
    });

    it('rejects a ^-led name as the defining TICK of an ISSUE', function () {
        expect(() => sdk.actions.createAction({
            action: 'ISSUE', params: { TICK: '^1234', MAX_SUPPLY: '1000', DECIMALS: '0' }
        })).to.throw();
    });
});
