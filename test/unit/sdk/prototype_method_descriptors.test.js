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

// BASE_DESCRIPTORS is each prototype before its split, inlined as literals under
// prototype_method_descriptors.test/fixtures/; each table names the tree it came from.

const assert = require('assert');

const CLASSES = {
    WalletUtils: () => require('../../../src/utils/wallet.js'),
    LifecycleManager: () => require('../../../src/carrier/lifecycle_manager.js'),
    Validator: () => require('../../../src/protocol/validator.js'),
    CoSigner: () => require('../../../src/cosigner/co_signer.js'),
    EncoderClient: () => require('../../../src/clients/encoder.js'),
    HubConnector: () => require('../../../src/clients/hub.js'),
    WebSocketClient: () => require('../../../src/clients/websocket.js'),
    ExplorerClient: () => require('../../../src/clients/explorer.js'),
    ContractUtils: () => require('../../../src/contract/utils.js'),
    Utility: () => require('../../../src/utils/utility.js'),
    WalletSession: () => require('../../../src/utils/wallet_session.js'),
    X402Gateway: () => require('../../../src/utils/x402.js').X402Gateway,
    WindowStore: () => require('../../../src/cosigner/window_store.js'),
    MessagingUtils: () => require('../../../src/actions/messaging.js'),
    BettingHelpers: () => require('../../../src/actions/betting.js'),
    Workflows: () => require('../../../src/actions/workflows.js'),
};

const BASE_DESCRIPTORS = Object.assign({},
    require('./prototype_method_descriptors.test/fixtures/descriptors_95b10404.js'),
    require('./prototype_method_descriptors.test/fixtures/descriptors_clients.js'),
    require('./prototype_method_descriptors.test/fixtures/descriptors_utils_and_actions.js'));

// CoSigner's split moved five plain utility functions into its parts, and
// the part objects carry them, so they now sit on the prototype too. The other
// fifteen splits added no key.
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
    const installMethods = (...args) => require('../../../src/utils/install_methods.js').installMethods(...args);

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
