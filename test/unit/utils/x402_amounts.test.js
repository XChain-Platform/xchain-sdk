// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const { isPosNum, signForAddress } = require('../../../src/utils/x402/amounts.js');

const message = 'challenge';
const wif = 'private-key';
const network = { name: 'testnet' };

function testInitialModeMatch() {
    const calls = [];
    const auth = {
        signMessage: (actualMessage, actualWif, options) => {
            calls.push({ actualMessage, actualWif, options });
            return { address: 'A2', signature: 'sig1' };
        },
    };

    assert.strictEqual(signForAddress(auth, message, wif, 'A2', network), 'sig1');
    assert.deepStrictEqual(calls, [{
        actualMessage: message,
        actualWif: wif,
        options: { network },
    }]);
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

describe('isPosNum with a positive decimal string', function () {
    it('returns true', function () {
        assert.strictEqual(isPosNum('5.5'), true);
    });
});

describe('isPosNum with a negative string', function () {
    it('returns false', function () {
        assert.strictEqual(isPosNum('-5'), false);
    });
});

describe('isPosNum with zero', function () {
    it('returns false', function () {
        assert.strictEqual(isPosNum('0'), false);
    });
});

describe('isPosNum with exponential notation', function () {
    it('returns false', function () {
        assert.strictEqual(isPosNum('1e10'), false);
    });
});

describe('signForAddress with an initial mode match', function () {
    it('returns the matching signature from the first call', testInitialModeMatch);
});

describe('signForAddress with a segwitNative match', function () {
    it('returns the signature from the segwitNative mode', testSegwitNativeMatch);
});

describe('signForAddress with signing errors before a match', function () {
    it('returns the segwitRedeemScript signature from the third call', testErrorsThenSegwitRedeemScriptMatch);
});

describe('signForAddress without a matching mode address', function () {
    it('returns the signature from the fourth plain call', testPlainFallback);
});
