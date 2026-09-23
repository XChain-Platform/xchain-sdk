/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * X402Gateway.guard()/middleware() fail-closed path: a throwing verify()
 * must answer 500 (or 503 for X402_STATE_CORRUPT), return false, and never
 * invoke `next`. Lives under mcp/ (a separately published, siblings-free
 * package) so it needs only node:test, no mocha/sinon devDependency.
 *
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { X402Gateway, X402_VERSION } = require('../../src/utils/x402.js');

function response() {
    return {
        headers: {},
        statusCode: 200,
        body: null,
        setHeader(name, value) { this.headers[name] = value; },
        end(body) { this.body = body; },
    };
}

function paymentRequest() {
    const proof = Buffer.from(JSON.stringify({
        x402Version: X402_VERSION,
        scheme: 'xchain-send',
        coin: 'TDOGE',
    })).toString('base64url');
    return { headers: { 'x-payment': proof }, url: '/paid' };
}

function throwingGateway(code) {
    const gateway = new X402Gateway({
        coin: 'TDOGE',
        explorer: {},
        requireSignature: false,
        send: { tick: 'TOK', amount: '1', payTo: 'gate' },
        invoiceStore: {},
    });
    gateway.verify = async () => {
        const error = new Error('verification failed');
        if (code) error.code = code;
        throw error;
    };
    return gateway;
}

for (const scenario of [
    { code: undefined, status: 500, responseCode: 'X402_ERROR' },
    { code: 'X402_STATE_CORRUPT', status: 503, responseCode: 'X402_STATE_CORRUPT' },
]) {
    test(`x402 middleware fails closed with ${scenario.status} when verify throws`, async () => {
        const res = response();
        let nextCalls = 0;
        const paid = await throwingGateway(scenario.code).middleware()(
            paymentRequest(),
            res,
            () => { nextCalls += 1; },
        );

        assert.equal(paid, false);
        assert.equal(res.statusCode, scenario.status);
        assert.equal(res.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(res.body), {
            error: 'payment verification error',
            code: scenario.responseCode,
        });
        assert.equal(nextCalls, 0);
    });
}
