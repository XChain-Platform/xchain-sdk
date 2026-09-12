/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

// SDK half of the bridge work rows: xchain-bridge.md row 8 (XBRIDGE v0/v1, the
// coin-aware address validator, the lock and burn recipes) and
// xchain-token-bridge.md row 7 (v3/v4, ISSUE format 7, parseBridgedTick, the
// opt-in recipe).
//
// The wire formats are consensus: a field order the indexer does not parse the
// same way produces a valid-looking action that is refused on arrival, after the
// fee is spent. They are therefore pinned here against the literal strings in the
// two specs, not against whatever formats.js happens to hold.

const assert   = require('assert');
const formats  = require('../../src/formats.js');
const Actions  = require('../../src/actions.js');
const Utility  = require('../../src/utility.js');
const config   = require('../../src/config.js');
const Workflows = require('../../src/workflows.js');

// Spec literals. xchain-bridge.md section 4 (v0, v1), xchain-token-bridge.md
// section 5 (v3, v4) and section 7 (ISSUE format 7).
const SPEC_XBRIDGE = {
    0: 'VERSION|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO',
    1: 'VERSION|BTC_ADDRESS|AMOUNT|MEMO',
    3: 'VERSION|TICK|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO',
    4: 'VERSION|TICK|ORIGIN_ADDRESS|AMOUNT|MEMO'
};
const SPEC_ISSUE_7 = 'VERSION|TICK|BRIDGE_CHAINS|MIN_DEPTH|LOCK_BRIDGE|MEMO';

// Address vectors over a hash160 of 0x01 bytes, one per (coin, network) the
// registry declares, plus the two segwit forms BTC carries.
const ADDR = {
    BTC_MAIN_P2PKH:  '16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf',
    BTC_MAIN_P2SH:   '31nKoVLBc2BXUeKQKhnimyrt9DD12VwG6p',
    BTC_REG_P2PKH:   'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC',
    BTC_MAIN_BECH32: 'bc1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpyfl4f3',
    BTC_REG_BECH32:  'bcrt1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpvxat9t',
    DOGE_MAIN_P2PKH: 'D5EQRCnPMXmRvUoZwC7gu7fYspean3PQ9a',
    LTC_MAIN_P2PKH:  'LKKG9A9a8n7CeHK8Nk7RdNZiCuHZW2U789'
};

function newActions(){
    return new Actions({ config: config, util: new Utility(), options: { network: 'regtest' } });
}

// A Workflows bound to a stub sdk that records the submitted action instead of
// broadcasting it, so the recipes are exercised end to end with no network.
function stubWorkflows(network){
    let calls = [];
    let sdk = {
        options: { network: network },
        util:    new Utility(),
        session: () => ({
            submit: async (actionData) => { calls.push(actionData); return { submitted: true }; }
        })
    };
    return { flows: new Workflows(sdk), calls: calls };
}


describe('bridge: SDK wire formats', () => {

    it('XBRIDGE carries exactly the four user-broadcast formats, byte-equal to the specs', () => {
        assert.ok(formats.XBRIDGE, 'formats.js declares no XBRIDGE action');
        assert.deepStrictEqual(Object.keys(formats.XBRIDGE).sort(), ['0', '1', '3', '4']);
        for (let v of Object.keys(SPEC_XBRIDGE))
            assert.strictEqual(formats.XBRIDGE[v], SPEC_XBRIDGE[v], 'XBRIDGE v' + v + ' does not match the spec format');
    });

    it('omits the system-injected settle formats v2 and v5', () => {
        // A broadcast v2/v5 is refused on every chain ('invalid: XBRIDGE v2 is
        // system-injected'), so an SDK that could build one could only build a
        // guaranteed-rejected transaction.
        assert.strictEqual(formats.XBRIDGE['2'], undefined);
        assert.strictEqual(formats.XBRIDGE['5'], undefined);
    });

    it('ISSUE gains format 7 and leaves formats 0 to 6 untouched', () => {
        assert.strictEqual(formats.ISSUE[7], SPEC_ISSUE_7);
        assert.deepStrictEqual(Object.keys(formats.ISSUE).sort(), ['0', '1', '2', '3', '4', '5', '6', '7']);
    });

    it('XBRIDGE is a known action name to the SDK', () => {
        assert.ok(new Utility().getActions().includes('XBRIDGE'));
    });

});


describe('bridge: action composition', () => {

    it('serializes each version to the wire string the indexer parses', () => {
        let a = newActions();
        assert.strictEqual(
            a.composeActionString({ action: 'XBRIDGE', params: { version: '0', destCoin: 'DOGE', destAddress: ADDR.DOGE_MAIN_P2PKH, amount: '5', memo: 'hi' } }).actionString,
            'XBRIDGE|0|DOGE|' + ADDR.DOGE_MAIN_P2PKH + '|5|hi');
        assert.strictEqual(
            a.composeActionString({ action: 'XBRIDGE', params: { version: '1', btcAddress: ADDR.BTC_REG_P2PKH, amount: '2', memo: 'x' } }).actionString,
            'XBRIDGE|1|' + ADDR.BTC_REG_P2PKH + '|2|x');
        assert.strictEqual(
            a.composeActionString({ action: 'XBRIDGE', params: { version: '3', tick: 'FUFU', destCoin: 'DOGE', destAddress: ADDR.DOGE_MAIN_P2PKH, amount: '5', memo: 'm' } }).actionString,
            'XBRIDGE|3|FUFU|DOGE|' + ADDR.DOGE_MAIN_P2PKH + '|5|m');
        assert.strictEqual(
            a.composeActionString({ action: 'XBRIDGE', params: { version: '4', tick: 'BTC.FUFU', originAddress: ADDR.BTC_REG_P2PKH, amount: '2', memo: 'm' } }).actionString,
            'XBRIDGE|4|BTC.FUFU|' + ADDR.BTC_REG_P2PKH + '|2|m');
        assert.strictEqual(
            a.composeActionString({ action: 'ISSUE', params: { version: '7', tick: 'FUFU', bridgeChains: 'DOGE,LTC', minDepth: '3', lockBridge: '1', memo: 'm' } }).actionString,
            'ISSUE|7|FUFU|DOGE,LTC|3|1|m');
    });

    it('auto-selects v0 for a gas lock and v3 the moment a TICK is present', () => {
        let a = newActions();
        assert.strictEqual(a.composeActionString({ action: 'XBRIDGE', params: { destCoin: 'DOGE', destAddress: ADDR.DOGE_MAIN_P2PKH, amount: '5' } }).version, 0);
        assert.strictEqual(a.composeActionString({ action: 'XBRIDGE', params: { tick: 'FUFU', destCoin: 'DOGE', destAddress: ADDR.DOGE_MAIN_P2PKH, amount: '5' } }).version, 3);
        assert.strictEqual(a.composeActionString({ action: 'XBRIDGE', params: { btcAddress: ADDR.BTC_REG_P2PKH, amount: '2' } }).version, 1);
        assert.strictEqual(a.composeActionString({ action: 'XBRIDGE', params: { tick: 'BTC.FUFU', originAddress: ADDR.BTC_REG_P2PKH, amount: '2' } }).version, 4);
    });

    it('refuses a pinned version with no slot for a supplied field instead of dropping it', () => {
        let a = newActions();
        assert.throws(
            () => a.composeActionString({ action: 'XBRIDGE', params: { version: '0', tick: 'FUFU', destCoin: 'DOGE', destAddress: ADDR.DOGE_MAIN_P2PKH, amount: '5' } }),
            /no slot for TICK/);
    });

    it('does not disturb ISSUE auto-selection for the pre-bridge formats', () => {
        // Format 7 is six slots wide, so it must never out-score the shorter
        // formats an ordinary edit picks today.
        let a = newActions();
        assert.strictEqual(a.composeActionString({ action: 'ISSUE', params: { tick: 'FUFU', description: 'hi' } }).version, 1);
        assert.strictEqual(a.composeActionString({ action: 'ISSUE', params: { tick: 'FUFU', memo: 'm' } }).version, 1);
        assert.strictEqual(a.composeActionString({ action: 'ISSUE', params: { tick: 'FUFU', allowList: '12' } }).version, 5);
        assert.strictEqual(a.composeActionString({ action: 'ISSUE', params: { tick: 'FUFU', bridgeChains: 'DOGE' } }).version, 7);
    });

});


describe('bridge: coin-and-network-aware address validation', () => {

    let util = new Utility();

    it('accepts an address on the chain and network it belongs to', () => {
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_P2PKH,  'BTC',  'mainnet'), true);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_P2SH,   'BTC',  'mainnet'), true);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_REG_P2PKH,   'BTC',  'regtest'), true);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_BECH32, 'BTC',  'mainnet'), true);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_REG_BECH32,  'BTC',  'regtest'), true);
        assert.strictEqual(util.isCryptoAddress(ADDR.DOGE_MAIN_P2PKH, 'DOGE', 'mainnet'), true);
        assert.strictEqual(util.isCryptoAddress(ADDR.LTC_MAIN_P2PKH,  'LTC',  'mainnet'), true);
    });

    it('refuses the same address on the wrong coin or the wrong network', () => {
        // The exact loss the bridge cannot survive: a DOGE mainnet address used as
        // a DOGE regtest destination is a credit nobody can spend.
        assert.strictEqual(util.isCryptoAddress(ADDR.DOGE_MAIN_P2PKH, 'DOGE', 'regtest'), false);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_P2PKH,  'BTC',  'regtest'), false);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_REG_P2PKH,   'BTC',  'mainnet'), false);
        assert.strictEqual(util.isCryptoAddress(ADDR.LTC_MAIN_P2PKH,  'DOGE', 'mainnet'), false);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_BECH32, 'BTC',  'regtest'), false);
        // DOGE has no segwit at all, so no bech32 form can be right there.
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_BECH32, 'DOGE', 'mainnet'), false);
    });

    it('refuses a checksum typo that the length heuristic would have accepted', () => {
        let typo = ADDR.BTC_MAIN_P2PKH.slice(0, -1) + (ADDR.BTC_MAIN_P2PKH.slice(-1) === 'a' ? 'b' : 'a');
        assert.strictEqual(typo.length, ADDR.BTC_MAIN_P2PKH.length);
        assert.strictEqual(util.isCryptoAddress(typo), true, 'the legacy heuristic accepts it, which is why the coin-aware form exists');
        assert.strictEqual(util.isCryptoAddress(typo, 'BTC', 'mainnet'), false);
    });

    it('fails closed on an unknown coin or network rather than borrowing another chain', () => {
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_P2PKH, 'XXX', 'mainnet'), false);
        assert.strictEqual(util.isCryptoAddress(ADDR.BTC_MAIN_P2PKH, 'BTC', 'devnet'), false);
        assert.strictEqual(util.isCryptoAddress(null, 'BTC', 'mainnet'), false);
    });

    it('leaves the one-argument heuristic exactly as it was', () => {
        assert.strictEqual(util.isCryptoAddress(ADDR.DOGE_MAIN_P2PKH), true);
        assert.strictEqual(util.isCryptoAddress('short'), false);
        assert.strictEqual(util.isCryptoAddress('x'.repeat(100)), false);
    });

});


describe('bridge: parseBridgedTick', () => {

    let util = new Utility();

    it('splits a rooted tick into its origin and native name', () => {
        assert.deepStrictEqual(util.parseBridgedTick('BTC.FUFU'), { origin: 'BTC', name: 'FUFU' });
        assert.deepStrictEqual(util.parseBridgedTick('DOGE.WOW'), { origin: 'DOGE', name: 'WOW' });
    });

    it('answers null for anything that is not a bridged row name', () => {
        assert.strictEqual(util.parseBridgedTick('FUFU'), null, 'a native tick has no root');
        assert.strictEqual(util.parseBridgedTick('XYZ.FUFU'), null, 'the prefix must be a coin in the registry');
        assert.strictEqual(util.parseBridgedTick('BTC.PEPE.CASH'), null, 'exactly one dot: subassets are not bridgeable yet');
        assert.strictEqual(util.parseBridgedTick('BTC.'), null);
        assert.strictEqual(util.parseBridgedTick(null), null);
    });

    it('refuses a root that is the reading chain own coin', () => {
        // BTC.FUFU read ON BTC is a plain subasset of the reserved BTC root, not a
        // bridged copy; treating it as one would let a v4 burn a native subasset.
        assert.strictEqual(util.parseBridgedTick('BTC.FUFU', 'BTC'), null);
        assert.deepStrictEqual(util.parseBridgedTick('BTC.FUFU', 'DOGE'), { origin: 'BTC', name: 'FUFU' });
    });

});


describe('bridge: workflow recipes', () => {

    it('bridgeLock pins v0 and submits the caller fields', async () => {
        let { flows, calls } = stubWorkflows('regtest');
        await flows.bridgeLock('wif', { destCoin: 'BTC', destAddress: ADDR.BTC_REG_P2PKH, amount: '5', memo: 'go' });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].action, 'XBRIDGE');
        assert.strictEqual(calls[0].params.VERSION, '0');
        assert.strictEqual(calls[0].params.DEST_ADDRESS, ADDR.BTC_REG_P2PKH);
    });

    it('bridgeLock refuses a destination that is not valid on the destination chain', async () => {
        let { flows, calls } = stubWorkflows('regtest');
        await assert.rejects(
            () => flows.bridgeLock('wif', { destCoin: 'DOGE', destAddress: ADDR.DOGE_MAIN_P2PKH, amount: '5' }),
            /not a valid DOGE regtest address/);
        assert.strictEqual(calls.length, 0, 'nothing may be broadcast once the destination is refused');
    });

    it('bridgeBurn validates against BTC whatever chain it is broadcast on, and pins v1', async () => {
        let { flows, calls } = stubWorkflows('regtest');
        await flows.bridgeBurn('wif', { btcAddress: ADDR.BTC_REG_P2PKH, amount: '2' });
        assert.strictEqual(calls[0].params.VERSION, '1');
        await assert.rejects(
            () => flows.bridgeBurn('wif', { btcAddress: ADDR.DOGE_MAIN_P2PKH, amount: '2' }),
            /BTC_ADDRESS .* not a valid BTC regtest address/);
    });

    it('bridgeTokenLock pins v3 and refuses a dotted or missing tick', async () => {
        let { flows, calls } = stubWorkflows('regtest');
        await flows.bridgeTokenLock('wif', { tick: 'FUFU', destCoin: 'BTC', destAddress: ADDR.BTC_REG_P2PKH, amount: '5' });
        assert.strictEqual(calls[0].params.VERSION, '3');
        await assert.rejects(() => flows.bridgeTokenLock('wif', { tick: 'BTC.FUFU', destCoin: 'BTC', destAddress: ADDR.BTC_REG_P2PKH, amount: '5' }), /dotted tick/);
        await assert.rejects(() => flows.bridgeTokenLock('wif', { destCoin: 'BTC', destAddress: ADDR.BTC_REG_P2PKH, amount: '5' }), /requires a TICK/);
    });

    it('bridgeTokenBurn reads the origin chain out of the tick', async () => {
        let { flows, calls } = stubWorkflows('regtest');
        await flows.bridgeTokenBurn('wif', { tick: 'BTC.FUFU', originAddress: ADDR.BTC_REG_P2PKH, amount: '2' });
        assert.strictEqual(calls[0].params.VERSION, '4');
        // A BTC-shaped address is right for BTC.FUFU and wrong for DOGE.WOW: the
        // chain the address is checked against comes from the tick, not the caller.
        await assert.rejects(
            () => flows.bridgeTokenBurn('wif', { tick: 'DOGE.WOW', originAddress: ADDR.BTC_MAIN_P2PKH, amount: '2' }),
            /not a valid DOGE regtest address/);
        await assert.rejects(
            () => flows.bridgeTokenBurn('wif', { tick: 'FUFU', originAddress: ADDR.BTC_REG_P2PKH, amount: '2' }),
            /needs a bridged tick/);
    });

    it('setTokenBridgeability pins ISSUE v7, upper-cases the chain list and refuses an unknown coin', async () => {
        let { flows, calls } = stubWorkflows('regtest');
        await flows.setTokenBridgeability('wif', { tick: 'FUFU', bridgeChains: 'doge, ltc', minDepth: '3' });
        assert.strictEqual(calls[0].action, 'ISSUE');
        assert.strictEqual(calls[0].params.VERSION, '7');
        assert.strictEqual(calls[0].params.BRIDGE_CHAINS, 'DOGE,LTC');
        await assert.rejects(() => flows.setTokenBridgeability('wif', { tick: 'FUFU', bridgeChains: 'XMR' }), /unsupported coin/);
        // '' means UNCHANGED on chain, so it can never be the way to clear a list.
        await assert.rejects(() => flows.setTokenBridgeability('wif', { tick: 'FUFU', bridgeChains: '' }), /comma list of coins or the "-" sentinel/);
    });

    it('setTokenBridgeability passes the "-" sentinel through untouched', async () => {
        let { flows, calls } = stubWorkflows('regtest');
        await flows.setTokenBridgeability('wif', { tick: 'FUFU', bridgeChains: '-' });
        assert.strictEqual(calls[0].params.BRIDGE_CHAINS, '-');
    });

    it('refuses a caller-supplied VERSION that disagrees with the recipe', async () => {
        let { flows } = stubWorkflows('regtest');
        await assert.rejects(
            () => flows.bridgeLock('wif', { version: '3', destCoin: 'BTC', destAddress: ADDR.BTC_REG_P2PKH, amount: '5' }),
            /forces VERSION 0/);
    });

    it('refuses to guess a network when none is configured', async () => {
        let saved = process.env.NETWORK;
        delete process.env.NETWORK;
        try {
            let { flows } = stubWorkflows(null);
            await assert.rejects(
                () => flows.bridgeLock('wif', { destCoin: 'BTC', destAddress: ADDR.BTC_REG_P2PKH, amount: '5' }),
                /without a network/);
        } finally {
            if (saved !== undefined) process.env.NETWORK = saved;
        }
    });

});
