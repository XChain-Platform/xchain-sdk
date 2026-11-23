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

const AuthUtils = require('../../../src/utils/auth.js');
require('../../../src/utils/wallet/auth_callbacks.js');

const DTS = path.join(__dirname, '..', '..', '..', 'index.d.ts');
const dts = fs.readFileSync(DTS, 'utf8');

function interfaceBody(name) {
    const start = dts.search(new RegExp('export interface ' + name + '\\b[^{]*\\{'));
    assert.ok(start >= 0, 'index.d.ts declares no `export interface ' + name + '`');
    const end = dts.indexOf('\n}', start);
    assert.ok(end > start, 'unterminated interface ' + name);
    return dts.slice(start, end);
}

function classBody(name) {
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

function assertFields(name, expected) {
    assert.deepStrictEqual(topLevelProps(interfaceBody(name)), expected);
}

describe('wallet holding callback types', function () {
    it('declares the holding minimum, options, and result', function () {
        assert.match(dts, /export type HoldingMinimum = string \| number;/);
        assertFields('HoldingResult', {
            holds: { optional: false, type: 'boolean' },
            amount: { optional: false, type: "import('mathjs').BigNumber" },
        });

        const options = interfaceBody('HoldsAtLeastOptions');
        assert.strictEqual(options, [
            'export interface HoldsAtLeastOptions {',
            '    chainId: string;',
            '    explorer?: {',
            '        getBalances(address: string): Promise<unknown>;',
            '    };',
        ].join('\n'));
    });

    it('declares and installs AuthUtils.holdsAtLeast', function () {
        assert.match(classBody('AuthUtils'), /holdsAtLeast\(address: string, tick: string, min: HoldingMinimum, options: HoldsAtLeastOptions\): Promise<HoldingResult>;/);
        assert.strictEqual(typeof AuthUtils.prototype.holdsAtLeast, 'function');
    });
});

describe('wallet receive callback types', function () {
    it('declares callback nonce modes and the awaitable store contract', function () {
        assert.match(dts, /export type CallbackNonceMode = 'same-device' \| 'cross-device';/);
        const store = interfaceBody('CallbackStore');
        assert.match(store, /^ {4}issueNonce\(mode: CallbackNonceMode\): string \| Promise<string>;$/m);
        assert.match(store, /^ {4}takeNonce\(nonce: string\): \{ mode: CallbackNonceMode \} \| null \| Promise<\{ mode: CallbackNonceMode \} \| null>;$/m);
        assert.match(store, /^ {4}put\(id: string, rec: unknown\): void \| Promise<void>;$/m);
        assert.match(store, /^ {4}get\(id: string\): unknown \| Promise<unknown>;$/m);
        assert.deepStrictEqual(Array.from(store.matchAll(/^ {4}(\w+)\(/gm), (match) => match[1]),
            ['issueNonce', 'takeNonce', 'put', 'get']);
    });

    it('declares the callback body fields', function () {
        assertFields('CallbackBody', {
            v: { optional: false, type: '1' },
            id: { optional: false, type: 'string' },
            method: { optional: false, type: 'string' },
            ok: { optional: false, type: 'boolean' },
            result: { optional: true, type: 'object' },
            error: { optional: true, type: 'unknown' },
            state: { optional: true, type: 'string' },
            claim: { optional: true, type: 'string' },
        });
    });

    it('declares receive options and result fields', function () {
        assertFields('ReceiveCallbackOptions', {
            store: { optional: true, type: 'CallbackStore' },
            appId: { optional: true, type: 'string' },
            origin: { optional: true, type: 'string' },
            maxAgeMs: { optional: true, type: 'number' },
        });
        assertFields('ReceiveCallbackResult', {
            accepted: { optional: false, type: 'boolean' },
            id: { optional: false, type: 'string | null' },
            status: { optional: false, type: "'approved' | 'approved-unclaimed' | 'received' | 'rejected'" },
            claimed: { optional: true, type: 'boolean' },
            verified: { optional: true, type: 'LoginVerifyResult' },
            error: { optional: true, type: 'string' },
        });
    });

    it('declares and installs AuthUtils.receiveCallback', function () {
        assert.match(classBody('AuthUtils'), /receiveCallback\(body: CallbackBody, options\?: ReceiveCallbackOptions\): Promise<ReceiveCallbackResult>;/);
        assert.strictEqual(typeof AuthUtils.prototype.receiveCallback, 'function');
    });
});
