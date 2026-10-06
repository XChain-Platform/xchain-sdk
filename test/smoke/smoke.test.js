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

const { expect } = require('chai');
const request = require('supertest');

const API_KEY = 'smoke-test-key';
process.env.NETWORK = 'bitcoin-regtest';
process.env.SDK_API_KEY = API_KEY;
process.env.SDK_API_RATE_LIMIT = '0';

const XChainSDK = require('../../src/XChainSDK');
const { createApp } = require('../../src/api/index.js');

const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
const app = createApp(sdk);

async function rpc(method, params = {}, authenticated = true) {
    const req = request(app)
        .post('/')
        .send({ jsonrpc: '2.0', method, params, id: 1 });

    if (authenticated)
        req.set('Authorization', 'Bearer ' + API_KEY);

    return req;
}

describe('Smoke: real API app through the authenticated HTTP layer', function () {
    // Basic connectivity

    it('serves ping without authentication', async function () {
        const response = await rpc('ping', {}, false);

        expect(response.status).to.equal(200);
        expect(response.body.result).to.deep.equal({ status: 'success' });
        expect(response.body.error).to.be.undefined;
    });

    it('enforces the API key for non-ping methods', async function () {
        const response = await rpc('get_actions', {}, false);

        expect(response.status).to.equal(401);
        expect(response.body.error.code).to.equal(-32001);
    });

    // Action creation via RPC

    it('create_action produces valid SEND', async function () {
        const response = await rpc('create_action', {
            action: 'send',
            params: {
                tick: 'TOKEN',
                amount: '100',
                destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
                memo: 'smoke test'
            }
        });
        const result = response.body.result;

        expect(response.body.error).to.be.undefined;
        expect(result.action).to.equal('SEND');
        expect(result.version).to.equal(0);
        expect(result.actionString).to.include('SEND|0|TOKEN|100|');
        expect(result.actionString).to.include('smoke test');
        expect(result.psbt).to.be.null;
    });

    it('create_action with ISSUE picks correct version', async function () {
        const response = await rpc('create_action', {
            action: 'issue',
            params: { tick: 'SMOKETOKEN', description: 'testing' }
        });

        expect(response.body.result.version).to.equal(1);
        expect(response.body.result.actionString).to.equal('ISSUE|1|SMOKETOKEN|testing');
    });

    it('create_action returns error for invalid input', async function () {
        const response = await rpc('create_action', {
            action: 'send',
            params: { amount: '100' } // missing tick and destination
        });

        expect(response.body.error).to.exist;
    });

});

describe('Smoke: real API app action validation', function () {
    // Validation via RPC

    it('validate_action returns valid for good input', async function () {
        const response = await rpc('validate_action', {
            action: 'send',
            params: {
                tick: 'TOKEN',
                amount: '100',
                destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
            }
        });

        expect(response.body.result.valid).to.be.true;
        expect(response.body.result.errors).to.be.an('array').with.length(0);
    });

    it('validate_action returns errors for bad input', async function () {
        const response = await rpc('validate_action', {
            action: 'issue',
            params: { tick: 'BAD|TOKEN' }
        });

        expect(response.body.result.valid).to.be.false;
        expect(response.body.result.errors.length).to.be.greaterThan(0);
    });

});

describe('Smoke: real API app registry introspection', function () {
    // Introspection via RPC

    it('get_actions returns the full action registry', async function () {
        const response = await rpc('get_actions');

        expect(response.body.result).to.deep.equal(sdk.getActions());
        expect(response.body.result).to.include('SEND');
        expect(response.body.result).to.include('ISSUE');
        expect(response.body.result).to.include('DEPLOY');
        expect(response.body.result).to.include('EXECUTE');
    });

    it('get_action_formats returns versions for ISSUE', async function () {
        const response = await rpc('get_action_formats', { action: 'ISSUE' });

        expect(response.body.result).to.have.property('0');
        expect(response.body.result).to.have.property('5');
    });

    it('get_action_fields returns fields for SEND v0', async function () {
        const response = await rpc('get_action_fields', { action: 'SEND', version: 0 });

        expect(response.body.result).to.include.members([
            'VERSION', 'TICK', 'AMOUNT', 'DESTINATION', 'MEMO'
        ]);
    });
});

describe('Smoke: real API app request handling', function () {
    // Multiple rapid requests

    it('handles 10 concurrent requests without errors', async function () {
        const responses = await Promise.all(Array.from({ length: 10 }, (_, index) =>
            rpc('create_action', {
                action: 'send',
                params: {
                    tick: 'TOKEN' + index,
                    // Send a positive amount per request; the validator rejects "0".
                    amount: String((index + 1) * 100),
                    destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
                }
            })
        ));

        for (const response of responses) {
            expect(response.body.error).to.be.undefined;
            expect(response.body.result.action).to.equal('SEND');
        }
    });

    // Unknown method

    it('returns JSON-RPC error for unknown method', async function () {
        const response = await rpc('nonexistent_method');

        expect(response.body.error).to.exist;
    });
});
