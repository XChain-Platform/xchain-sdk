const { expect } = require('chai');
const config = require('../src/config.js');
const Utility = require('../src/utility.js');
const Actions = require('../src/actions.js');
const FormatSelector = require('../src/formatSelector.js');
const formats = require('../src/formats.js');

function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Parse an action string back into { action, version, fields }
function parseActionString(actionString, action, version) {
    let parts = actionString.split('|');
    let parsedAction = parts[0];
    let formatFields = FormatSelector.getFormatFields(action, version);

    let fields = {};
    // parts[0] = ACTION name, parts[1..] map to formatFields
    for (let i = 0; i < formatFields.length; i++) {
        let value = (i + 1 < parts.length) ? parts[i + 1] : '';
        fields[formatFields[i]] = value;
    }
    return { action: parsedAction, version: parseInt(fields.VERSION), fields };
}

describe('Round-trip — serialize then parse back', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    // Test cases: { action, params, expectedVersion, fieldsToCheck }
    const testCases = [
        {
            name: 'ADDRESS v0',
            action: 'address',
            params: { feePreference: 2, requireMemo: 1, memo: 'test' },
            expectedVersion: 0,
            check: { FEE_PREFERENCE: '2', REQUIRE_MEMO: '1', MEMO: 'test' }
        },
        {
            name: 'AIRDROP v0',
            action: 'airdrop',
            params: { tick: 'TOKEN', amount: '500', listActionIndex: 42, memo: 'drop' },
            expectedVersion: 0,
            check: { TICK: 'TOKEN', AMOUNT: '500', LIST_ACTION_INDEX: '42', MEMO: 'drop' }
        },
        {
            name: 'BROADCAST v0',
            action: 'broadcast',
            params: { message: 'hello world', value: '99.5' },
            expectedVersion: 0,
            check: { MESSAGE: 'hello world', VALUE: '99.5' }
        },
        {
            name: 'BROADCAST v1 (with fee + memo)',
            action: 'broadcast',
            params: { message: 'oracle', value: '100', fee: 5, memo: 'feed' },
            expectedVersion: 1,
            check: { MESSAGE: 'oracle', VALUE: '100', FEE: '5', MEMO: 'feed' }
        },
        {
            name: 'CALLBACK v0',
            action: 'callback',
            params: { tick: 'MYTOKEN', memo: 'returning' },
            expectedVersion: 0,
            check: { TICK: 'MYTOKEN', MEMO: 'returning' }
        },
        {
            name: 'DESTROY v0',
            action: 'destroy',
            params: { tick: 'BURN', amount: '1000', memo: 'gone' },
            expectedVersion: 0,
            check: { TICK: 'BURN', AMOUNT: '1000', MEMO: 'gone' }
        },
        {
            name: 'DISPENSER v0',
            action: 'dispenser',
            params: { giveTick: 'A', giveAmount: '100', giveEscrow: '100', getTick: 'B', getAmount: '50', memo: 'vend' },
            expectedVersion: 0,
            check: { GIVE_TICK: 'A', GIVE_AMOUNT: '100', GIVE_ESCROW: '100', GET_TICK: 'B', GET_AMOUNT: '50', MEMO: 'vend' }
        },
        {
            name: 'DISPENSER v1 (cancel)',
            action: 'dispenser',
            params: { dispenserActionIndex: 12345, memo: 'cancel' },
            expectedVersion: 1,
            check: { DISPENSER_ACTION_INDEX: '12345', MEMO: 'cancel' }
        },
        {
            name: 'DIVIDEND v0',
            action: 'dividend',
            params: { tick: 'TOKEN', dividendTick: 'PAY', amount: '1', memo: 'payout' },
            expectedVersion: 0,
            check: { TICK: 'TOKEN', DIVIDEND_TICK: 'PAY', AMOUNT: '1', MEMO: 'payout' }
        },
        {
            name: 'FILE v0',
            action: 'file',
            params: { name: 'doc', type: 1, title: 'My File', memo: 'upload' },
            expectedVersion: 0,
            check: { NAME: 'doc', TYPE: '1', TITLE: 'My File', MEMO: 'upload' }
        },
        {
            name: 'ISSUE v0 (full create)',
            action: 'issue',
            params: { tick: 'NEWTOKEN', maxSupply: '21000000', maxMint: '1000', decimals: 8, description: 'test' },
            expectedVersion: 0,
            check: { TICK: 'NEWTOKEN', MAX_SUPPLY: '21000000', MAX_MINT: '1000', DECIMALS: '8', DESCRIPTION: 'test' }
        },
        {
            name: 'ISSUE v1 (description update)',
            action: 'issue',
            params: { tick: 'NEWTOKEN', description: 'updated desc' },
            expectedVersion: 1,
            check: { TICK: 'NEWTOKEN', DESCRIPTION: 'updated desc' }
        },
        {
            name: 'ISSUE v3 (lock update)',
            action: 'issue',
            params: { tick: 'TOK', lockMaxSupply: 1, lockMaxMint: 0, lockDescription: 1, lockSleep: 0, lockCallback: 0, lockMint: 1, lockMintSupply: 0 },
            expectedVersion: 3,
            check: { TICK: 'TOK', LOCK_MAX_SUPPLY: '1', LOCK_MAX_MINT: '0', LOCK_DESCRIPTION: '1', LOCK_MINT: '1' }
        },
        {
            name: 'ISSUE v4 (callback update)',
            action: 'issue',
            params: { tick: 'TOK', callbackBlock: 100000, callbackTick: 'PAY', callbackAmount: '0.5' },
            expectedVersion: 4,
            check: { TICK: 'TOK', CALLBACK_BLOCK: '100000', CALLBACK_TICK: 'PAY', CALLBACK_AMOUNT: '0.5' }
        },
        {
            name: 'ISSUE v5 (list update)',
            action: 'issue',
            params: { tick: 'TOK', allowList: 111, blockList: 222 },
            expectedVersion: 5,
            check: { TICK: 'TOK', ALLOW_LIST: '111', BLOCK_LIST: '222' }
        },
        {
            name: 'LINK v0',
            action: 'link',
            params: { coin1: 'BTC', coin1ActionIndex: 100, coin2: 'LTC', coin2ActionIndex: 200, memo: 'linked' },
            expectedVersion: 0,
            check: { COIN1: 'BTC', COIN1_ACTION_INDEX: '100', COIN2: 'LTC', COIN2_ACTION_INDEX: '200', MEMO: 'linked' }
        },
        {
            name: 'LIST v0',
            action: 'list',
            params: { type: 1, item: 'TOKEN1,TOKEN2' },
            expectedVersion: 0,
            check: { TYPE: '1', ITEM: 'TOKEN1,TOKEN2' }
        },
        {
            name: 'LIST v1 (edit)',
            action: 'list',
            params: { edit: 1, listActionIndex: 555, item: 'TOKEN3' },
            expectedVersion: 1,
            check: { EDIT: '1', LIST_ACTION_INDEX: '555', ITEM: 'TOKEN3' }
        },
        {
            name: 'MESSAGE v3 (plaintext)',
            action: 'message',
            params: { destination: ADDR, plaintextMessage: 'hello there' },
            expectedVersion: 3,
            check: { DESTINATION: ADDR, PLAINTEXT_MESSAGE: 'hello there' }
        },
        {
            name: 'MINT v0',
            action: 'mint',
            params: { tick: 'TOKEN', amount: '500', destination: ADDR, memo: 'minted' },
            expectedVersion: 0,
            check: { TICK: 'TOKEN', AMOUNT: '500', DESTINATION: ADDR, MEMO: 'minted' }
        },
        {
            name: 'ORDER v0 (full create)',
            action: 'order',
            params: { giveTick: 'A', giveAmount: '100', getTick: 'B', getAmount: '200', memo: 'trade' },
            expectedVersion: 0,
            check: { GIVE_TICK: 'A', GIVE_AMOUNT: '100', GET_TICK: 'B', GET_AMOUNT: '200', MEMO: 'trade' }
        },
        {
            name: 'ORDER v1 (cancel)',
            action: 'order',
            params: { orderActionIndex: 9999 },
            expectedVersion: 1,
            check: { ORDER_ACTION_INDEX: '9999' }
        },
        {
            name: 'COINPAY v0',
            action: 'coinpay',
            params: { orderMatchActionIndex: 12345 },
            expectedVersion: 0,
            check: { ORDER_MATCH_ACTION_INDEX: '12345' }
        },
        {
            name: 'SEND v0',
            action: 'send',
            params: { tick: 'TOKEN', amount: '100', destination: ADDR, memo: 'payment' },
            expectedVersion: 0,
            check: { TICK: 'TOKEN', AMOUNT: '100', DESTINATION: ADDR, MEMO: 'payment' }
        },
        {
            name: 'SLEEP v0 (address)',
            action: 'sleep',
            params: { resumeBlock: 500000 },
            expectedVersion: 0,
            check: { RESUME_BLOCK: '500000' }
        },
        {
            name: 'SLEEP v1 (tick)',
            action: 'sleep',
            params: { resumeBlock: 600000, tick: 'FROZEN' },
            expectedVersion: 1,
            check: { RESUME_BLOCK: '600000', TICK: 'FROZEN' }
        },
        {
            name: 'SWAP v0 (full create)',
            action: 'swap',
            params: { giveTick: 'X', giveAmount: '50', getTick: 'Y', getAmount: '75' },
            expectedVersion: 0,
            check: { GIVE_TICK: 'X', GIVE_AMOUNT: '50', GET_TICK: 'Y', GET_AMOUNT: '75' }
        },
        {
            name: 'SWAP v1 (cancel)',
            action: 'swap',
            params: { swapActionIndex: 7777 },
            expectedVersion: 1,
            check: { SWAP_ACTION_INDEX: '7777' }
        },
        {
            name: 'SWEEP v0',
            action: 'sweep',
            params: { destination: ADDR, balances: 1, ownerships: 1, escrows: 0, memo: 'moving' },
            expectedVersion: 0,
            check: { DESTINATION: ADDR, BALANCES: '1', OWNERSHIPS: '1', ESCROWS: '0', MEMO: 'moving' }
        },
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
        }
    ];

    for (let tc of testCases) {
        it(tc.name + ' round-trips correctly', function () {
            let result = actions.createAction({ action: tc.action, params: tc.params });

            // Verify expected version was selected
            expect(result.version).to.equal(tc.expectedVersion);

            // Parse back
            let parsed = parseActionString(result.actionString, result.action, result.version);

            // Verify action name
            expect(parsed.action).to.equal(result.action);

            // Verify version
            expect(parsed.version).to.equal(tc.expectedVersion);

            // Verify each field round-trips
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
