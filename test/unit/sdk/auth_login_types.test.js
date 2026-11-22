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
const path = require('path');

const XChainSDK = require('../../../src/XChainSDK.js');
const AuthUtils = require('../../../src/utils/auth.js');

const DTS = path.join(__dirname, '..', '..', '..', 'index.d.ts');
const dts = fs.readFileSync(DTS, 'utf8');

function interfaceBody(dts, name) {
    const start = dts.search(new RegExp('export interface ' + name + '\\b[^{]*\\{'));
    assert.ok(start >= 0, 'index.d.ts declares no `export interface ' + name + '`');
    const end = dts.indexOf('\n}', start);
    assert.ok(end > start, 'unterminated interface ' + name);
    return dts.slice(start, end);
}

function classBody(dts, name) {
    const start = dts.indexOf('export declare class ' + name + ' {');
    assert.ok(start >= 0, 'index.d.ts declares no `export declare class ' + name + '`');
    const end = dts.indexOf('\n}', start);
    assert.ok(end > start, 'unterminated class ' + name);
    return dts.slice(start, end);
}

function topLevelProps(body) {
    const out = {};
    const re = /^ {4}(\w+)(\??):\s*(.+?);$/gm;
    let match;
    while ((match = re.exec(body)) !== null) {
        out[match[1]] = { optional: match[2] === '?', type: match[3] };
    }
    return out;
}

function assertFields(dts, name, expected) {
    assert.deepStrictEqual(topLevelProps(interfaceBody(dts, name)), expected);
}

describe('wallet login challenge types', function () {
    it('declares the supported message signature formats and signing option', function () {
        assert.match(dts, /export type MessageSignatureFormat = 'legacy' \| 'bip322-simple';/);
        assert.strictEqual(topLevelProps(interfaceBody(dts, 'SignMessageOptions')).format.type,
            'MessageSignatureFormat');
    });

    it('declares LoginChallengeParts with the parsed fields', function () {
        assertFields(dts, 'LoginChallengeParts', {
            appId: { optional: false, type: 'string' },
            origin: { optional: false, type: 'string' },
            address: { optional: false, type: 'string' },
            nonce: { optional: false, type: 'string' },
            version: { optional: false, type: 'number' },
            timestamp: { optional: false, type: 'number' },
            expiresAt: { optional: false, type: 'number' },
        });
    });
});

describe('wallet login proof types', function () {
    it('declares LoginAddressProof with required and optional fields', function () {
        assertFields(dts, 'LoginAddressProof', {
            address: { optional: false, type: 'string' },
            chainId: { optional: false, type: 'string' },
            challenge: { optional: false, type: 'string' },
            signature: { optional: false, type: 'string' },
            signatureFormat: { optional: false, type: 'MessageSignatureFormat' },
            addressType: { optional: true, type: 'string' },
            challengeParts: { optional: true, type: 'LoginChallengeParts' },
        });
    });

    it('declares LoginResult with the top-level proof and address list', function () {
        assertFields(dts, 'LoginResult', {
            ok: { optional: false, type: 'true' },
            address: { optional: false, type: 'string' },
            chainId: { optional: false, type: 'string' },
            challenge: { optional: false, type: 'string' },
            signature: { optional: false, type: 'string' },
            signatureFormat: { optional: false, type: 'MessageSignatureFormat' },
            challengeParts: { optional: false, type: 'LoginChallengeParts' },
            addresses: { optional: false, type: 'LoginAddressProof[]' },
        });
    });
});

describe('wallet login verification result types', function () {
    it('declares LoginExpected without a caller-provided clock', function () {
        assertFields(dts, 'LoginExpected', {
            appId: { optional: false, type: 'string' },
            origin: { optional: false, type: 'string' },
            nonce: { optional: false, type: 'string' },
            maxAgeMs: { optional: true, type: 'number' },
        });
    });

    it('declares LoginVerifyResult with nullable primary identity fields', function () {
        assertFields(dts, 'LoginVerifyResult', {
            valid: { optional: false, type: 'boolean' },
            address: { optional: false, type: 'string | null' },
            chainId: { optional: false, type: 'string | null' },
            addresses: { optional: false, type: 'Array<{ address: string; chainId: string }>' },
            error: { optional: false, type: 'string | null' },
        });
    });
});

describe('wallet login authentication API', function () {
    it('declares the AuthUtils message format options and verifyLogin', function () {
        const body = classBody(dts, 'AuthUtils');
        const opts = 'opts\\?: \\{ format\\?: MessageSignatureFormat \\}';
        assert.match(body, new RegExp('verifyOwnership\\([^\\n]+' + opts + '\\): VerifyResult;'));
        assert.match(body, new RegExp('verifyMessage\\([^\\n]+' + opts + '\\): VerifyResult;'));
        assert.match(body, /verifyLogin\(result: LoginResult, expected: LoginExpected\): LoginVerifyResult;/);
        assert.strictEqual(typeof AuthUtils.prototype.verifyLogin, 'function');
    });

    it('keeps the XChainSDK convenience verifier signatures at four arguments', function () {
        const body = classBody(dts, 'XChainSDK');
        assert.match(body, /verifyOwnership\(address: string, message: string, signature: string, network\?: XChainNetwork\): VerifyResult;/);
        assert.match(body, /verifyMessage\(address: string, message: string, signature: string, network\?: XChainNetwork\): VerifyResult;/);
    });

    it('declares and constructs XChainSDK.auth as AuthUtils', function () {
        const body = classBody(dts, 'XChainSDK');
        assert.match(body, /^ {4}readonly auth: AuthUtils;$/m);
        const sdk = new XChainSDK({
            network: 'bitcoin-regtest',
            explorerUrl: 'http://localhost:8080',
            retry: false,
        });
        assert.ok(sdk.auth instanceof AuthUtils);
    });
});
