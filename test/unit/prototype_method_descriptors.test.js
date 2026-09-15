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

// Pin the prototypes of the classes split into part modules: Object.assign made
// moved methods enumerable, so for...in and Object.keys started listing them.

// BASE_DESCRIPTORS is each prototype at sdk 95b10404, before the splits. Rows are
// [key, enumerable, writable, configurable, typeof value, function length].

const assert = require('assert');

const CLASSES = {
    WalletUtils: () => require('../../src/utils/wallet.js'),
    LifecycleManager: () => require('../../src/carrier/lifecycle_manager.js'),
    Validator: () => require('../../src/protocol/validator.js'),
    CoSigner: () => require('../../src/cosigner/co_signer.js'),
};

const BASE_DESCRIPTORS = {
    WalletUtils: [
        ['_maxFeeRate', false, true, true, 'function', 1],
        ['_resolveNet', false, true, true, 'function', 1],
        ['_xchainRevealFinalizer', false, true, true, 'function', 1],
        ['broadcastTx', false, true, true, 'function', 2],
        ['constructor', false, true, true, 'function', 1],
        ['decomposePsbt', false, true, true, 'function', 1],
        ['deriveAddress', false, true, true, 'function', 1],
        ['deriveMultisigAddress', false, true, true, 'function', 1],
        ['finalizeMultisigPsbt', false, true, true, 'function', 2],
        ['generateKeyPair', false, true, true, 'function', 0],
        ['getBitcoinNetwork', false, true, true, 'function', 1],
        ['getUTXOs', false, true, true, 'function', 2],
        ['importWIF', false, true, true, 'function', 1],
        ['signEcdsa', false, true, true, 'function', 2],
        ['signEnvelopeRevealPsbt', false, true, true, 'function', 3],
        ['signMultisigPsbt', false, true, true, 'function', 2],
        ['signPsbt', false, true, true, 'function', 3],
        ['signRevealPsbt', false, true, true, 'function', 3],
        ['txidOf', false, true, true, 'function', 1],
        ['validateAddress', false, true, true, 'function', 2],
    ],
    LifecycleManager: [
        ['_awaitContract', false, true, true, 'function', 5],
        ['_extractChangeOutputs', false, true, true, 'function', 2],
        ['_extractSpentInputs', false, true, true, 'function', 1],
        ['_reconcileNetwork', false, true, true, 'function', 0],
        ['constructor', false, true, true, 'function', 1],
        ['submitAction', false, true, true, 'function', 1],
    ],
    Validator: [
        ['_checkDelimiters', false, true, true, 'function', 2],
        ['_error', false, true, true, 'function', 2],
        ['_isEmpty', false, true, true, 'function', 1],
        ['_isValidListAddress', false, true, true, 'function', 1],
        ['_issueFormat', false, true, true, 'function', 1],
        ['_legsOf', false, true, true, 'function', 1],
        ['_scanDelimiters', false, true, true, 'function', 2],
        ['_validateAction', false, true, true, 'function', 2],
        ['_validateBatch', false, true, true, 'function', 1],
        ['_validateBatchCommand', false, true, true, 'function', 2],
        ['_validateBet', false, true, true, 'function', 1],
        ['_validateBetDetails', false, true, true, 'function', 3],
        ['_validateBridgeOptIn', false, true, true, 'function', 1],
        ['_validateBroadcast', false, true, true, 'function', 1],
        ['_validateControllerBind', false, true, true, 'function', 1],
        ['_validateDelegate', false, true, true, 'function', 1],
        ['_validateDeploy', false, true, true, 'function', 1],
        ['_validateDeployCarrier', false, true, true, 'function', 1],
        ['_validateDispenser', false, true, true, 'function', 1],
        ['_validateField', false, true, true, 'function', 4],
        ['_validateIssueTickRef', false, true, true, 'function', 2],
        ['_validateLegsShape', false, true, true, 'function', 2],
        ['_validateList', false, true, true, 'function', 1],
        ['_validateListAddressItems', false, true, true, 'function', 1],
        ['_validateOrder', false, true, true, 'function', 1],
        ['_validateSwap', false, true, true, 'function', 1],
        ['_validateTickName', false, true, true, 'function', 2],
        ['_validateVote', false, true, true, 'function', 1],
        ['_withLeg', false, true, true, 'function', 2],
        ['constructor', false, true, true, 'function', 2],
        ['validate', false, true, true, 'function', 2],
        ['validateOrThrow', false, true, true, 'function', 2],
    ],
    CoSigner: [
        ['_checkFee', false, true, true, 'function', 1],
        ['_checkOutputs', false, true, true, 'function', 3],
        ['_checkPrevouts', false, true, true, 'function', 3],
        ['_checkSource', false, true, true, 'function', 3],
        ['_deny', false, true, true, 'function', 2],
        ['_normalizeAllowedOutputs', false, true, true, 'function', 1],
        ['_recordBudget', false, true, true, 'function', 2],
        ['_toU64', false, true, true, 'function', 1],
        ['constructor', false, true, true, 'function', 0],
        ['process', false, true, true, 'function', 0],
    ],
};

// CoSigner's split moved five plain utility functions into its parts, and
// the part objects carry them, so they now sit on the prototype too.
const SPLIT_ADDED = {
    CoSigner: [
        ['exactU64', false, true, true, 'function', 1],
        ['isStandardPaymentScript', false, true, true, 'function', 1],
        ['revealCommitTxid', false, true, true, 'function', 1],
        ['taprootKeyPathSighash', false, true, true, 'function', 3],
        ['toBytes', false, true, true, 'function', 2],
    ],
};

function descriptorRows(proto) {
    const d = Object.getOwnPropertyDescriptors(proto);
    return Reflect.ownKeys(d).map(String).sort().map((k) => {
        const x = d[k];
        const v = x.value;
        return [k, x.enumerable, 'writable' in x ? x.writable : null, x.configurable,
            'value' in x ? typeof v : 'accessor', typeof v === 'function' ? v.length : null];
    });
}

function expectedRows(name) {
    const rows = BASE_DESCRIPTORS[name].concat(SPLIT_ADDED[name] || []);
    return rows.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe('prototype method descriptors of split classes', function () {

    for (const name of Object.keys(CLASSES)) {
        describe(name, function () {
            it('matches the pre-split descriptors plus only the keys the split names', function () {
                assert.deepStrictEqual(descriptorRows(CLASSES[name]().prototype), expectedRows(name));
            });

            it('keeps every prototype method non-enumerable', function () {
                const proto = CLASSES[name]().prototype;
                const enumerable = Object.keys(proto);
                assert.deepStrictEqual(enumerable, []);
                const methods = Object.getOwnPropertyNames(proto).filter((k) => typeof proto[k] === 'function');
                assert.ok(methods.length > 1, name + ' prototype has methods to check');
            });
        });
    }

    // Loaded inside its own describe so the descriptor cases above still run
    // against a tree that predates the installer.
    const installMethods = (...args) => require('../../src/utils/install_methods.js').installMethods(...args);

    describe('installMethods', function () {
        it('defines methods with the flags a class body gives them', function () {
            const target = {};
            function m(a, b) { return a + b; }
            installMethods(target, { m });
            assert.deepStrictEqual(Object.getOwnPropertyDescriptor(target, 'm'),
                { value: m, writable: true, enumerable: false, configurable: true });
        });

        it('installs sources in order, a later source winning a shared key', function () {
            const first = () => 1, second = () => 2, other = () => 3;
            const target = installMethods({}, { a: first, b: other }, { a: second });
            assert.strictEqual(target.a, second);
            assert.strictEqual(target.b, other);
        });

        it('copies symbol keys and skips a source key that is not enumerable', function () {
            const sym = Symbol('s');
            const source = { [sym]: () => 's' };
            Object.defineProperty(source, 'hidden', { value: () => 'h', enumerable: false });
            const target = installMethods({}, source);
            assert.strictEqual(typeof target[sym], 'function');
            assert.strictEqual(Object.prototype.hasOwnProperty.call(target, 'hidden'), false);
        });
    });
});
