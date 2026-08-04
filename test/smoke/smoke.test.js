// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const axios = require('axios');
const http = require('http');

describe('Smoke: API server end-to-end', function () {

    let server;
    const PORT = 19876; // Unlikely to collide

    before(function (done) {
        // Boot the SDK API server programmatically
        const express    = require('express');
        const bodyParser = require('body-parser');
        const helmet     = require('helmet');
        const cors       = require('cors');
        const jsonRouter = require('express-json-rpc-router');
        const XChainSDK  = require('../../src/XChainSDK');

        const sdk = new XChainSDK({ network: 'bitcoin-regtest' });

        const app = express();
        app.use(helmet());
        app.use(bodyParser.json());
        app.use(cors());

        const controller = {
            async ping() { return { status: 'success' }; },
            async create_action(params) { return sdk.createAction(params); },
            async validate_action(params) { return sdk.validateAction(params.action, params.params); },
            async get_actions() { return sdk.getActions(); },
            async get_action_formats(params) { return sdk.getActionFormats(params.action); },
            async get_action_fields(params) { return sdk.getActionFields(params.action, params.version); }
        };

        app.use(jsonRouter({ methods: controller }));

        server = app.listen(PORT, done);
    });

    after(function (done) {
        server.close(done);
    });

    async function rpc(method, params) {
        let response = await axios.post('http://localhost:' + PORT, {
            jsonrpc: '2.0',
            method: method,
            params: params || {},
            id: 1
        });
        return response.data;
    }

    /*
     *  Basic connectivity
     */

    it('ping returns success', async function () {
        let res = await rpc('ping');
        expect(res.result).to.deep.equal({ status: 'success' });
        expect(res.error).to.be.undefined;
    });

    /*
     *  Action creation via RPC
     */

    it('create_action produces valid SEND', async function () {
        let res = await rpc('create_action', {
            action: 'send',
            params: {
                tick: 'TOKEN',
                amount: '100',
                destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
                memo: 'smoke test'
            }
        });
        expect(res.error).to.be.undefined;
        expect(res.result.action).to.equal('SEND');
        expect(res.result.version).to.equal(0);
        expect(res.result.actionString).to.include('SEND|0|TOKEN|100|');
        expect(res.result.actionString).to.include('smoke test');
        expect(res.result.psbt).to.be.null;
    });

    it('create_action with ISSUE picks correct version', async function () {
        let res = await rpc('create_action', {
            action: 'issue',
            params: { tick: 'SMOKETOKEN', description: 'testing' }
        });
        expect(res.result.version).to.equal(1);
        expect(res.result.actionString).to.equal('ISSUE|1|SMOKETOKEN|testing');
    });

    it('create_action returns error for invalid input', async function () {
        let res = await rpc('create_action', {
            action: 'send',
            params: { amount: '100' } // missing tick and destination
        });
        expect(res.error).to.exist;
    });

    /*
     *  Validation via RPC
     */

    it('validate_action returns valid for good input', async function () {
        let res = await rpc('validate_action', {
            action: 'send',
            params: {
                tick: 'TOKEN',
                amount: '100',
                destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
            }
        });
        expect(res.result.valid).to.be.true;
        expect(res.result.errors).to.be.an('array').with.length(0);
    });

    it('validate_action returns errors for bad input', async function () {
        let res = await rpc('validate_action', {
            action: 'issue',
            params: { tick: 'BAD|TOKEN' }
        });
        expect(res.result.valid).to.be.false;
        expect(res.result.errors.length).to.be.greaterThan(0);
    });

    /*
     *  Introspection via RPC
     */

    // The count here was a literal 28 and went stale the moment an action was
    // added (BET and friends took it to 31). A smoke test over the RPC surface
    // is checking that the whole registry survives the round trip, not what is
    // in it, so compare against the library's own list: that still catches a
    // truncated or lossy response, and it does not have to be edited every time
    // the protocol gains an action.
    it('get_actions returns the full action registry', async function () {
        const XChainSDK = require('../../src/XChainSDK');
        const expected = new XChainSDK({ network: 'bitcoin-regtest' }).getActions();

        let res = await rpc('get_actions');
        expect(res.result).to.be.an('array');
        expect(res.result).to.deep.equal(expected);
        expect(res.result).to.include('SEND');
        expect(res.result).to.include('ISSUE');
        expect(res.result).to.include('DEPLOY');
        expect(res.result).to.include('EXECUTE');
    });

    it('get_action_formats returns versions for ISSUE', async function () {
        let res = await rpc('get_action_formats', { action: 'ISSUE' });
        expect(res.result).to.have.property('0');
        expect(res.result).to.have.property('5');
    });

    it('get_action_fields returns fields for SEND v0', async function () {
        let res = await rpc('get_action_fields', { action: 'SEND', version: 0 });
        expect(res.result).to.include('VERSION');
        expect(res.result).to.include('TICK');
        expect(res.result).to.include('AMOUNT');
        expect(res.result).to.include('DESTINATION');
        expect(res.result).to.include('MEMO');
    });

    /*
     *  Multiple rapid requests
     */

    it('handles 10 concurrent requests without errors', async function () {
        let promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(rpc('create_action', {
                action: 'send',
                params: {
                    tick: 'TOKEN' + i,
                    // (i + 1), not i: the first request used to send AMOUNT "0",
                    // which the validator rejects as not a positive number. That
                    // made this concurrency test fail on a bad fixture rather
                    // than on anything about concurrency.
                    amount: String((i + 1) * 100),
                    destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
                }
            }));
        }
        let results = await Promise.all(promises);
        for (let res of results) {
            expect(res.error).to.be.undefined;
            expect(res.result.action).to.equal('SEND');
        }
    });

    /*
     *  Unknown method
     */

    it('returns JSON-RPC error for unknown method', async function () {
        let res = await rpc('nonexistent_method');
        expect(res.error).to.exist;
    });

});
