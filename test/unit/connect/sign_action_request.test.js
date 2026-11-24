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

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CONNECT_PATH = path.join(ROOT, 'src', 'connect', 'sign_action.js');

function withConnect(codec, run) {
    const originalLoad = Module._load;
    delete require.cache[require.resolve(CONNECT_PATH)];
    Module._load = function (request, parent, isMain) {
        if (request === '@dankest-llc/xchain-connect') return codec;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return run(require(CONNECT_PATH));
    } finally {
        Module._load = originalLoad;
    }
}

function returnsRequestAndLink() {
    const params = {
        chainId: 'bitcoin-testnet',
        from: 'tb1qsource',
        action: 'SEND',
        params: { tick: 'XCP', amount: '2', destination: 'tb1qdestination' },
    };
    const options = {
        return: 'https://site.example/wallet',
        state: 'state-1',
        now: 1700000000000,
        developerMode: false,
    };
    const request = {
        v: 1,
        id: 'AAAAAAAAAAAAAAAAAAAAAA',
        method: 'signAction',
        params,
        return: options.return,
        state: options.state,
        exp: 1700000300000,
    };
    const calls = [];
    const result = withConnect({
        buildRequest(method, actualParams, actualOptions) {
            calls.push(['buildRequest', method, actualParams, actualOptions]);
            return request;
        },
        requestLink(actualRequest, actualOptions) {
            calls.push(['requestLink', actualRequest, actualOptions]);
            return 'xchain:request?v=1&req=encoded';
        },
    }, (connect) => connect.signAction(params, options));

    assert.deepStrictEqual(result, { request, link: 'xchain:request?v=1&req=encoded' });
    assert.deepStrictEqual(calls, [
        ['buildRequest', 'signAction', params, options],
        ['requestLink', request, { now: options.now, developerMode: false }],
    ]);
}

function loadsLazily() {
    const originalLoad = Module._load;
    let codecLoads = 0;
    delete require.cache[require.resolve(CONNECT_PATH)];
    Module._load = function (request, parent, isMain) {
        if (request === '@dankest-llc/xchain-connect') codecLoads += 1;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const connect = require(CONNECT_PATH);
        assert.strictEqual(typeof connect.signAction, 'function');
        assert.strictEqual(codecLoads, 0);
    } finally {
        Module._load = originalLoad;
    }
}

function propagatesFailure() {
    let linkCalls = 0;
    const failure = Object.assign(new TypeError('action is invalid'), { code: 'INVALID_PARAMS' });
    assert.throws(() => withConnect({
        buildRequest() {
            throw failure;
        },
        requestLink() {
            linkCalls += 1;
        },
    }, (connect) => connect.signAction({}, {})), (error) => {
        assert.strictEqual(error, failure);
        return true;
    });

    assert.strictEqual(linkCalls, 0);
}

function connectSignActionTests() {
    it('returns the connect request and its link', returnsRequestAndLink);
    it('loads the dependency only when the helper is called', loadsLazily);
    it('propagates request validation failures without encoding a link', propagatesFailure);
}

function packageSurfaceTests() {
    it('wires sdk.connect immediately after sdk.auth', function wiresSdkConnect() {
        const sdkPath = path.join(ROOT, 'src', 'XChainSDK.js');
        delete require.cache[require.resolve(sdkPath)];
        delete require.cache[require.resolve(CONNECT_PATH)];
        const XChainSDK = require(sdkPath);
        const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        const keys = Object.keys(sdk);

        assert.strictEqual(sdk.connect.signAction, require(CONNECT_PATH).signAction);
        assert.strictEqual(keys[keys.indexOf('auth') + 1], 'connect');
    });

    it('ships the connect dependency without adding root entries', function shipsSurfaces() {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        assert.strictEqual(pkg.dependencies['@dankest-llc/xchain-connect'], '^1.0.0');
        assert.ok(!pkg.files.includes('auth.js'));
        assert.ok(!pkg.files.includes('auth.d.ts'));
        assert.ok(!fs.existsSync(path.join(ROOT, 'auth.js')));
        assert.ok(!fs.existsSync(path.join(ROOT, 'auth.d.ts')));
    });

    it('declares sdk.connect.signAction', function declaresTypes() {
        const dts = fs.readFileSync(path.join(ROOT, 'index.d.ts'), 'utf8');

        assert.match(dts, /readonly connect: ConnectApi;/);
        assert.match(dts, /signAction<TParams = Record<string, unknown>>\(/);
    });

    it('documents 32 actions and sdk.connect.signAction', function documentsSurfaces() {
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

        assert.match(readme, /\*\*32 ACTION types\*\*/);
        assert.match(readme, /All 32 ACTION types/);
        assert.match(readme, /sdk\.connect\.signAction\(\)/);
        assert.match(changelog, /sdk\.connect\.signAction/);
    });
}

describe('connect.signAction()', connectSignActionTests);
describe('wallet request package surfaces', packageSurfaceTests);
