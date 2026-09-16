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
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');

// An xchain-encoder whose operator set API_KEY 401s every method except
// GET /openrpc.json; with no way to present x-api-key the SDK could not
// reach such a deployment at all.
describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';
    let client;
    let savedEnv;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
        savedEnv = process.env.ENCODER_API_KEY;
        delete process.env.ENCODER_API_KEY;
    });

    afterEach(function () {
        nock.cleanAll();
        if (savedEnv === undefined) delete process.env.ENCODER_API_KEY;
        else process.env.ENCODER_API_KEY = savedEnv;
    });

    describe('encoder API key', function () {
        it('sends x-api-key when a key is configured', async function () {
            let keyed = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000, encoderApiKey: 'fake-key' });
            nock(BASE)
                .matchHeader('x-api-key', 'fake-key')
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'aabbcc', encoding: 'OP_RETURN' }, id: 1 });

            let result = await keyed.createTx({ data: 'SEND|0|TOKEN|100|addr1', pubkey: 'mypubkey' });
            expect(result.psbt).to.equal('aabbcc');
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';
    let client;
    let savedEnv;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
        savedEnv = process.env.ENCODER_API_KEY;
        delete process.env.ENCODER_API_KEY;
    });

    afterEach(function () {
        nock.cleanAll();
        if (savedEnv === undefined) delete process.env.ENCODER_API_KEY;
        else process.env.ENCODER_API_KEY = savedEnv;
    });

    describe('encoder API key', function () {
        it('sends no x-api-key header at all when none is configured', async function () {
            nock(BASE)
                .matchHeader('x-api-key', (v) => v === undefined)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'aabbcc', encoding: 'OP_RETURN' }, id: 1 });

            let result = await client.createTx({ data: 'SEND|0|TOKEN|100|addr1', pubkey: 'mypubkey' });
            expect(result.psbt).to.equal('aabbcc');
        });
    });
});

describe('EncoderClient', function () {
    let client;
    let savedEnv;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
        savedEnv = process.env.ENCODER_API_KEY;
        delete process.env.ENCODER_API_KEY;
    });

    afterEach(function () {
        nock.cleanAll();
        if (savedEnv === undefined) delete process.env.ENCODER_API_KEY;
        else process.env.ENCODER_API_KEY = savedEnv;
    });

    describe('encoder API key', function () {
        it('keeps the header across a hub-discovery rebuild', async function () {
            let keyed = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000, encoderApiKey: 'fake-key' });
            keyed.setBase('other.host', 3001);
            nock('http://other.host:3001')
                .matchHeader('x-api-key', 'fake-key')
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'ddeeff', encoding: 'OP_RETURN' }, id: 1 });

            let result = await keyed.createTx({ data: 'SEND|0|TOKEN|100|addr1', pubkey: 'mypubkey' });
            expect(result.psbt).to.equal('ddeeff');
        });
    });
});

describe('EncoderClient', function () {
    let client;
    let savedEnv;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
        savedEnv = process.env.ENCODER_API_KEY;
        delete process.env.ENCODER_API_KEY;
    });

    afterEach(function () {
        nock.cleanAll();
        if (savedEnv === undefined) delete process.env.ENCODER_API_KEY;
        else process.env.ENCODER_API_KEY = savedEnv;
    });

    describe('encoder API key', function () {
        it('is threaded from the XChainSDK constructor, whose encoder options are cherry-picked', function () {
            this.timeout(10000);
            const XChainSDK = require('../../../src/XChainSDK.js');
            let sdk = new XChainSDK({
                network: 'bitcoin-regtest', noHub: true,
                encoderUrl: 'encoder.test', encoderPort: 3000, encoderApiKey: 'fake-key'
            });
            expect(sdk.encoder.apiKey).to.equal('fake-key');
            expect(sdk.encoder.client.defaults.headers['x-api-key']).to.equal('fake-key');
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';
    let client;
    let savedEnv;

    beforeEach(function () {
        client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
        savedEnv = process.env.ENCODER_API_KEY;
        delete process.env.ENCODER_API_KEY;
    });

    afterEach(function () {
        nock.cleanAll();
        if (savedEnv === undefined) delete process.env.ENCODER_API_KEY;
        else process.env.ENCODER_API_KEY = savedEnv;
    });

    describe('encoder API key', function () {
        it('falls back to ENCODER_API_KEY in a Node environment', async function () {
            process.env.ENCODER_API_KEY = 'fake-env-key';
            let keyed = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 });
            nock(BASE)
                .matchHeader('x-api-key', 'fake-env-key')
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'aabbcc', encoding: 'OP_RETURN' }, id: 1 });

            let result = await keyed.createTx({ data: 'SEND|0|TOKEN|100|addr1', pubkey: 'mypubkey' });
            expect(result.psbt).to.equal('aabbcc');
        });
    });
});
