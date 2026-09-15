// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const config = require('../../../src/config.js');
const Utility = require('../../../src/utils/utility.js');
const Actions = require('../../../src/actions/index.js');
const FormatSelector = require('../../../src/protocol/format_selector.js');
const formats = require('../../../src/protocol/formats.js');

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

function parseActionString(actionString, action, version) {
    let parts = actionString.split('|');
    let parsedAction = parts[0];
    let formatFields = FormatSelector.getFormatFields(action, version);

    let fields = {};
    for (let i = 0; i < formatFields.length; i++) {
        let value = (i + 1 < parts.length) ? parts[i + 1] : '';
        fields[formatFields[i]] = value;
    }
    return { action: parsedAction, version: parseInt(fields.VERSION), fields };
}

const roundTripCases = [
    {
        name: 'DEPOSIT v0',
        action: 'deposit',
        params: { contractActionIndex: 12345, tick: 'TOKEN', quantity: '1000' },
        expectedVersion: 0,
        check: { CONTRACT_ACTION_INDEX: '12345', TICK: 'TOKEN', QUANTITY: '1000' }
    },
    {
        name: 'WITHDRAW v0',
        action: 'withdraw',
        params: { contractActionIndex: 42, tick: '^99', quantity: '500' },
        expectedVersion: 0,
        check: { CONTRACT_ACTION_INDEX: '42', TICK: '^99', QUANTITY: '500' }
    },
    {
        name: 'STAKE v1 (new stake, capability model)',
        action: 'stake',
        params: { version: 1, amount: '1000', signingPubkey: 'a'.repeat(64) },
        expectedVersion: 1,
        check: { AMOUNT: '1000', SIGNING_PUBKEY: 'a'.repeat(64) }
    },
    {
        name: 'STAKE v2 (top-up of existing pubkey)',
        action: 'stake',
        params: { version: 2, amount: '500', signingPubkey: 'a'.repeat(64) },
        expectedVersion: 2,
        check: { AMOUNT: '500', SIGNING_PUBKEY: 'a'.repeat(64) }
    },
    {
        name: 'STAKE v3 (contract-targeted)',
        action: 'stake',
        params: { version: 3, amount: '250', signingPubkey: 'a'.repeat(64), targetContractIndex: 42, tick: 'MYTOKEN' },
        expectedVersion: 3,
        check: { AMOUNT: '250', SIGNING_PUBKEY: 'a'.repeat(64), TARGET_CONTRACT_INDEX: '42', TICK: 'MYTOKEN' }
    },
    {
        name: 'UNSTAKE v0',
        action: 'unstake',
        params: { signingPubkey: 'a'.repeat(64) },
        expectedVersion: 0,
        check: { SIGNING_PUBKEY: 'a'.repeat(64) }
    },
    {
        name: 'UNSTAKE v1 (contract-targeted)',
        action: 'unstake',
        params: { version: 1, signingPubkey: 'a'.repeat(64), targetContractIndex: 42, tick: 'MYTOKEN' },
        expectedVersion: 1,
        check: { SIGNING_PUBKEY: 'a'.repeat(64), TARGET_CONTRACT_INDEX: '42', TICK: 'MYTOKEN' }
    },
    {
        name: 'DELEGATE v0',
        action: 'delegate',
        params: { newSigningPubkey: 'b'.repeat(64) },
        expectedVersion: 0,
        check: { NEW_SIGNING_PUBKEY: 'b'.repeat(64) }
    },
    {
        name: 'DELEGATE v1 (contract-targeted)',
        action: 'delegate',
        params: { version: 1, newSigningPubkey: 'b'.repeat(64), targetContractIndex: 42, tick: 'MYTOKEN' },
        expectedVersion: 1,
        check: { NEW_SIGNING_PUBKEY: 'b'.repeat(64), TARGET_CONTRACT_INDEX: '42', TICK: 'MYTOKEN' }
    },
    {
        name: 'DELEGATE v2 (capability revoke)',
        action: 'delegate',
        params: { version: 2, signingPubkey: 'c'.repeat(64) },
        expectedVersion: 2,
        check: { SIGNING_PUBKEY: 'c'.repeat(64) }
    },
    {
        name: 'DELEGATE v3 (contract revoke)',
        action: 'delegate',
        params: { version: 3, signingPubkey: 'd'.repeat(64), targetContractIndex: 42, tick: 'MYTOKEN' },
        expectedVersion: 3,
        check: { SIGNING_PUBKEY: 'd'.repeat(64), TARGET_CONTRACT_INDEX: '42', TICK: 'MYTOKEN' }
    },
    {
        name: 'COLLECT v0',
        action: 'collect',
        params: {},
        expectedVersion: 0,
        check: {}
    },
    {
        // VOTE v1 = cast a ballot against an existing poll (POLL_REF).
        // v0 (create poll) / v2 (close) / v3 (delegate) are separate
        // versions distinguished by VERSION; one round-trip covers the harness.
        name: 'VOTE v1 (cast ballot)',
        action: 'vote',
        params: { version: 1, pollRef: '12345', ballot: '0', memo: 'yea' },
        expectedVersion: 1,
        check: { POLL_REF: '12345', BALLOT: '0', MEMO: 'yea' }
    },
    {
        // BET v0 = create a market. The widest format, and the one whose
        // slot order a field insertion would shift; the three lifecycle
        // formats are covered below.
        name: 'BET v0 (create market)',
        action: 'bet',
        params: {
            version: 0, label: 'Superbowl LX winner', outcomes: 'Chiefs,49ers',
            tick: 'PEPECASH', fee: '1.00', deadline: '1770000000',
            refundWindow: '604800', minAmount: '10', allowList: '4321',
            blockList: '8765', memo: 'big game'
        },
        expectedVersion: 0,
        check: {
            LABEL: 'Superbowl LX winner', OUTCOMES: 'Chiefs,49ers', TICK: 'PEPECASH',
            DEADLINE: '1770000000', REFUND_WINDOW: '604800',
            ALLOW_LIST: '4321', BLOCK_LIST: '8765', MEMO: 'big game'
        }
    },
    {
        // BET v2 = place a bet. OUTCOME is a zero-based index, and outcome 0
        // is the falsy value a lazy guard would drop.
        name: 'BET v2 (place bet)',
        action: 'bet',
        params: { version: 2, feedActionIndex: '1234', outcome: '0', amount: '25.5', memo: 'chiefs' },
        expectedVersion: 2,
        check: { FEED_ACTION_INDEX: '1234', OUTCOME: '0', AMOUNT: '25.5', MEMO: 'chiefs' }
    },
    {
        // BET v3 = resolve. Same leading fields as v2 minus AMOUNT, which is
        // exactly why the compose helpers pin the version.
        name: 'BET v3 (resolve market)',
        action: 'bet',
        params: { version: 3, feedActionIndex: '1234', outcome: '1', memo: 'final' },
        expectedVersion: 3,
        check: { FEED_ACTION_INDEX: '1234', OUTCOME: '1', MEMO: 'final' }
    },
    {
        // BET v1 = cancel, refunding every open bet.
        name: 'BET v1 (cancel market)',
        action: 'bet',
        params: { version: 1, feedActionIndex: '1234', memo: 'postponed' },
        expectedVersion: 1,
        check: { FEED_ACTION_INDEX: '1234', MEMO: 'postponed' }
    },
    {
        // XBRIDGE v0 = lock the gas token on BTC for a credit on DEST_COIN.
        // DEST_COIN and DEST_ADDRESS lead, so a field shift here would send a
        // lock to the wrong chain entirely (xchain-bridge.md).
        name: 'XBRIDGE v0 (lock for a credit on another chain)',
        action: 'xbridge',
        params: { destCoin: 'DOGE', destAddress: 'DFundmtrigPmpmcqzuz57TQx65uEmPx8pW', amount: '100', memo: 'lock' },
        expectedVersion: 0,
        check: { DEST_COIN: 'DOGE', DEST_ADDRESS: 'DFundmtrigPmpmcqzuz57TQx65uEmPx8pW', AMOUNT: '100', MEMO: 'lock' }
    },
    {
        // XBRIDGE v1 = burn the bridged gas token off BTC to release the BTC
        // escrow. Only BTC_ADDRESS precedes AMOUNT, a different arity from v0.
        name: 'XBRIDGE v1 (burn for a release on BTC)',
        action: 'xbridge',
        params: { version: 1, btcAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', amount: '50', memo: 'burn' },
        expectedVersion: 1,
        check: { BTC_ADDRESS: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', AMOUNT: '50', MEMO: 'burn' }
    },
    {
        // XBRIDGE v3 = lock a general token on its origin chain. Same tail as
        // v0 with TICK prepended, which is the exact one-slot shift this
        // harness exists to catch (xchain-token-bridge.md).
        name: 'XBRIDGE v3 (lock a general token)',
        action: 'xbridge',
        params: { tick: 'JDOG', destCoin: 'DOGE', destAddress: 'DFundmtrigPmpmcqzuz57TQx65uEmPx8pW', amount: '7', memo: 'tlock' },
        expectedVersion: 3,
        check: { TICK: 'JDOG', DEST_COIN: 'DOGE', DEST_ADDRESS: 'DFundmtrigPmpmcqzuz57TQx65uEmPx8pW', AMOUNT: '7', MEMO: 'tlock' }
    },
    {
        // XBRIDGE v4 = burn a bridged <ORIGIN>.<NAME> row back to its origin.
        name: 'XBRIDGE v4 (burn a bridged token home)',
        action: 'xbridge',
        params: { version: 4, tick: 'BTC.JDOG', originAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', amount: '7', memo: 'tburn' },
        expectedVersion: 4,
        check: { TICK: 'BTC.JDOG', ORIGIN_ADDRESS: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', AMOUNT: '7', MEMO: 'tburn' }
    }
    // DEPLOY v4 (chunk carrier) is exercised by the indexer carrier unit test and the
    // chunked-deploy e2e test; DEPLOY is excluded from this round-trip harness (its
    // rest-fields need custom parsing; see the exclusion list below).
];

const testCases = [
    'address',
    'airdrop',
    'broadcast',
    'callback',
    'destroy',
    'dispenser',
    'dividend',
    'file',
    'issue',
    'link',
    'list',
    'message',
    'mint',
    'order',
    'coinpay',
    'price',
    'send',
    'sleep',
    'swap',
    'sweep',
    'deposit',
    'withdraw',
    'stake',
    'unstake',
    'delegate',
    'collect',
    'vote',
    'bet',
    'xbridge'
].map(action => ({ action }));

describe('Round-trip: serialize then parse back', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    for (let tc of roundTripCases) {
        it(tc.name + ' round-trips correctly', function () {
            let result = actions.createAction({ action: tc.action, params: tc.params });

            expect(result.version).to.equal(tc.expectedVersion);

            let parsed = parseActionString(result.actionString, result.action, result.version);

            expect(parsed.action).to.equal(result.action);

            expect(parsed.version).to.equal(tc.expectedVersion);

            for (let [field, expectedValue] of Object.entries(tc.check)) {
                expect(parsed.fields[field]).to.equal(expectedValue,
                    'Field ' + field + ' mismatch: expected "' + expectedValue + '" got "' + parsed.fields[field] + '"');
            }
        });
    }

    it('every action type has at least one round-trip test', function () {
        let testedActions = new Set(testCases.map(tc => tc.action.toUpperCase()));
        let allActions = Object.keys(formats);
        // BATCH is excluded (its COMMAND field contains nested action strings)
        // DEPLOY and EXECUTE are excluded (rest-fields require custom parsing)
        let excluded = ['BATCH', 'DEPLOY', 'EXECUTE'];
        let expected = allActions.filter(a => !excluded.includes(a));
        for (let action of expected) {
            expect(testedActions.has(action), 'missing round-trip for ' + action).to.be.true;
        }
    });

});
