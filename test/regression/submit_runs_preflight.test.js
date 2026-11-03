// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// Regression: in the default enforce pre-flight mode, no submit path hands the
// encoder an action whose wire form carries a halt-class field.
//
// A BET v0 with DEADLINE '0x6aeb27f0' or REFUND_WINDOW '0xe10' range-checks as a
// number, so a compose validator that reads Number(value) lets it through with the
// prefixed literal on the wire. sdk.preflight() refuses it (invalid: <FIELD>
// (format), halt-class on an older indexer), but submitAction, sdk.bet,
// WalletSession.submit and BatchBuilder.build never ran pre-flight: they went
// straight to encoder.createTx. These tests open the same compose gap the bug rode
// on (composition with validation off) and require each path to refuse at the
// serialized boundary, before the encoder is contacted.

const assert = require('assert');
const sinon = require('sinon');
const { XChainSDK } = require('../..');
const WalletSession = require('../../src/utils/wallet_session.js');
const { SDKPreflightError } = require('../../src/utils/errors.js');

const NOW = Math.floor(Date.now() / 1000);
const FUTURE = NOW + 86400;
const UTXO = { txid: '00'.repeat(32), vout: 0, value: 100000000, scriptPubKey: '00', confirmations: 1 };

function betParams(extra) {
    return Object.assign({ version: 0, label: 'L3', outcomes: 'a,b', tick: 'TB', deadline: String(FUTURE) }, extra);
}

// An SDK whose encoder is unreachable, with createTx and broadcastTx stubbed so a
// call is counted instead of failing on the network. `gap` opens the compose gap.
function makeSdk(options = {}, gap = true) {
    const sdk = new XChainSDK(Object.assign({
        network: 'litecoin-regtest', encoderUrl: '127.0.0.1', encoderPort: 1,
        explorerUrl: '127.0.0.1', explorerPort: 1, timeout: 500, retry: { maxRetries: 0 },
    }, options));
    sdk.tickResolver.resolveActionParams = async (_action, params) => params;
    sdk.addressResolver.resolveActionParams = async (_action, params) => params;
    if (gap) {
        const actions = sdk.actions;
        sinon.stub(actions, 'createAction').callsFake((data) => {
            const composed = actions.composeActionString(data, { validate: false });
            return Object.assign({ encoding: null }, composed);
        });
    }
    const encoder = sdk.requireEncoder();
    const createTx = sinon.stub(encoder, 'createTx').rejects(new Error('createTx reached'));
    const broadcastTx = sinon.stub(encoder, 'broadcastTx').rejects(new Error('broadcastTx reached'));
    const kp = sdk.generateKeyPair();
    const addr = sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' });
    return { sdk, createTx, broadcastTx, kp, addr };
}

async function expectPreflightRefusal(promise, field) {
    let caught = null;
    try { await promise; } catch (e) { caught = e; }
    assert.ok(caught, 'expected a refusal');
    assert.ok(caught instanceof SDKPreflightError,
        'expected SDKPreflightError, got ' + caught.name + ':' + caught.code + ':' + caught.message);
    assert.strictEqual(caught.code, 'PREFLIGHT_FAIL');
    assert.strictEqual(caught.report.verdict, 'fail');
    const fields = caught.report.findings.map(f => f.data && f.data.field);
    assert.ok(fields.includes(field), 'finding names ' + field + ': ' + JSON.stringify(fields));
    assert.ok(caught.report.findings.every(f => f.data && f.data.haltClass === true));
    return caught;
}

describe('Regression: default enforce-mode submit paths run the halt-class pre-flight gate', function () {
    this.timeout(10000);

    afterEach(() => sinon.restore());

    it('the compose gap really puts the prefixed literal on the wire', async function () {
        const { sdk } = makeSdk();
        const composed = await sdk.createAction({ action: 'BET', params: betParams({ refundWindow: '0xe10' }) });
        assert.match(composed.actionString, /\|0xe10$/);
        assert.strictEqual(sdk.preflight.mode, 'enforce');
    });

    for (const [name, extra, field] of [
        ['REFUND_WINDOW 0xe10', { refundWindow: '0xe10' }, 'REFUND_WINDOW'],
        ['hex DEADLINE', { deadline: '0x' + FUTURE.toString(16) }, 'DEADLINE'],
        ['binary DEADLINE', { deadline: '0b' + FUTURE.toString(2) }, 'DEADLINE'],
    ]) {
        it('submitAction refuses a BET v0 with ' + name + ' and never calls createTx', async function () {
            const { sdk, createTx, broadcastTx, kp, addr } = makeSdk();
            await expectPreflightRefusal(sdk.submitAction({ action: 'BET', params: betParams(extra) },
                { pubkey: kp.publicKey, change: addr, utxos: [UTXO] }, { wif: kp.wif, waitForIndexer: false }), field);
            assert.strictEqual(createTx.callCount, 0);
            assert.strictEqual(broadcastTx.callCount, 0);
        });
    }

    it('sdk.bet refuses a hex DEADLINE and never calls createTx', async function () {
        const { sdk, createTx, kp, addr } = makeSdk();
        await expectPreflightRefusal(sdk.bet(betParams({ deadline: '0x' + FUTURE.toString(16) }),
            { pubkey: kp.publicKey, change: addr, utxos: [UTXO] }, { wif: kp.wif, waitForIndexer: false }), 'DEADLINE');
        assert.strictEqual(createTx.callCount, 0);
    });

    it('WalletSession.submit refuses REFUND_WINDOW 0xe10 and never calls createTx', async function () {
        const { sdk, createTx, kp } = makeSdk();
        sdk.requireEncoder().getUTXOs = async () => ({ utxos: [UTXO] });
        const session = new WalletSession(sdk, kp.wif, { waitForIndexer: false });
        await expectPreflightRefusal(session.submit({ action: 'BET', params: betParams({ refundWindow: '0xe10' }) }),
            'REFUND_WINDOW');
        assert.strictEqual(createTx.callCount, 0);
    });
});

describe('Regression: BATCH paths and the pre-flight bypass at the halt-class gate', function () {
    this.timeout(10000);

    afterEach(() => sinon.restore());

    it('a raw BATCH carrying a prefixed BET DEADLINE is refused, with the command named', async function () {
        const { sdk, createTx, kp, addr } = makeSdk();
        const command = 'ORDER|0|LTC|TB|1||LTC|XCHAIN|1|||16;BET|0|L3|a,b|TB||0x6aeb27f0';
        const err = await expectPreflightRefusal(sdk.submitAction({ action: 'BATCH', params: { command } },
            { pubkey: kp.publicKey, change: addr, utxos: [UTXO] }, { wif: kp.wif, waitForIndexer: false }), 'DEADLINE');
        assert.strictEqual(err.report.findings[0].commandIndex, 1);
        assert.strictEqual(createTx.callCount, 0);
    });

    it('BatchBuilder.build refuses a BET sub-command carrying DEADLINE 0x6aeb27f0', async function () {
        const { sdk, createTx } = makeSdk();
        const builder = sdk.batch()
            .order({ version: 0, giveCoin: 'LTC', giveTick: 'TB', giveAmount: '1', getCoin: 'LTC', getTick: 'XCHAIN',
                getAmount: '1', expiration: '16' })
            .add('BET', betParams({ deadline: '0x6aeb27f0' }));
        await expectPreflightRefusal(builder.build(), 'DEADLINE');
        assert.strictEqual(createTx.callCount, 0);
    });

    it('BatchBuilder.build still refuses with the compose validator in place', async function () {
        const { sdk } = makeSdk({}, false);
        await assert.rejects(sdk.batch().add('BET', betParams({ deadline: '0x6aeb27f0' })).build());
    });

    it('a decimal BET still reaches createTx', async function () {
        const { sdk, createTx, kp, addr } = makeSdk();
        await assert.rejects(sdk.submitAction({ action: 'BET', params: betParams({ refundWindow: '3600' }) },
            { pubkey: kp.publicKey, change: addr, utxos: [UTXO] }, { wif: kp.wif, waitForIndexer: false }),
            /createTx reached/);
        assert.strictEqual(createTx.callCount, 1);
    });
});

describe('Regression: the halt-class gate honours the pre-flight option', function () {
    this.timeout(10000);

    afterEach(() => sinon.restore());

    it('a per-call { preflight: false } or a non-enforcing mode bypasses the gate', async function () {
        for (const preflight of [false, 'off', 'warn', 'report']) {
            const { sdk, createTx, kp, addr } = makeSdk();
            await assert.rejects(sdk.submitAction({ action: 'BET', params: betParams({ refundWindow: '0xe10' }) },
                { pubkey: kp.publicKey, change: addr, utxos: [UTXO] }, { wif: kp.wif, waitForIndexer: false, preflight }),
                /createTx reached/);
            assert.strictEqual(createTx.callCount, 1, 'preflight ' + preflight);
            sinon.restore();
        }
    });

    it('an SDK constructed with { preflight: false } bypasses the gate on submit and build', async function () {
        const { sdk, createTx, kp, addr } = makeSdk({ preflight: false });
        await assert.rejects(sdk.submitAction({ action: 'BET', params: betParams({ refundWindow: '0xe10' }) },
            { pubkey: kp.publicKey, change: addr, utxos: [UTXO] }, { wif: kp.wif, waitForIndexer: false }),
            /createTx reached/);
        assert.strictEqual(createTx.callCount, 1);
        const built = await sdk.batch().add('BET', betParams({ deadline: '0x6aeb27f0' })).build();
        assert.match(built.actionString, /0x6aeb27f0/);
    });
});
