// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const { isPosNum, signForAddress } = require('../../../src/utils/x402/amounts.js');

const message = 'challenge';
const wif = 'private-key';
const network = { name: 'testnet' };

function testIsPosNum() {
    assert.strictEqual(isPosNum('5.5'), true);
    assert.strictEqual(isPosNum('-5'), false);
    assert.strictEqual(isPosNum('0'), false);
    assert.strictEqual(isPosNum('1e10'), false);
}

function testSegwitNativeMatch() {
    const calls = [];
    const auth = {
        signMessage: (actualMessage, actualWif, options) => {
            calls.push({ actualMessage, actualWif, options });
            if (options.segwitNative)
                return { address: 'A2', signature: 'sig2' };
            return { address: 'OTHER', signature: 'sig1' };
        },
    };

    assert.strictEqual(signForAddress(auth, message, wif, 'A2', network), 'sig2');
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0], {
        actualMessage: message,
        actualWif: wif,
        options: { network },
    });
    assert.deepStrictEqual(calls[1].options, { network, segwitNative: true });
}

function testErrorsThenSegwitRedeemScriptMatch() {
    let callCount = 0;
    const auth = {
        signMessage: (actualMessage, actualWif, options) => {
            callCount++;
            assert.strictEqual(actualMessage, message);
            assert.strictEqual(actualWif, wif);
            if (callCount < 3) throw new Error('unsupported mode');
            assert.deepStrictEqual(options, { network, segwitRedeemScript: true });
            return { address: 'A2', signature: 'sig3' };
        },
    };

    assert.strictEqual(signForAddress(auth, message, wif, 'A2', network), 'sig3');
    assert.strictEqual(callCount, 3);
}

function testPlainFallback() {
    const calls = [];
    const auth = {
        signMessage: (actualMessage, actualWif, options) => {
            calls.push({ actualMessage, actualWif, options });
            return { address: 'OTHER', signature: `sig${calls.length}` };
        },
    };

    assert.strictEqual(signForAddress(auth, message, wif, 'A2', network), 'sig4');
    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(calls[3], {
        actualMessage: message,
        actualWif: wif,
        options: { network },
    });
}

describe('x402 amount utilities', function () {
    describe('isPosNum', function () {
        it('accepts positive decimal strings and rejects non-positive or exponential values', testIsPosNum);
    });

    describe('signForAddress', function () {
        it('returns the signature from the segwitNative mode when its address matches', testSegwitNativeMatch);
        it('continues after errors and returns the segwitRedeemScript signature', testErrorsThenSegwitRedeemScriptMatch);
        it('uses the fourth call as the plain fallback when no mode address matches', testPlainFallback);
    });
});
