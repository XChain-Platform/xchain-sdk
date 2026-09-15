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
const sinon   = require('sinon');
const XChainSDK = require('../../../src/XChainSDK.js');

// Helpers

// Env vars the SDK reads: clear them so tests are deterministic
const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];

// Build a minimal SDK pointed at a local regtest stack so no public
// defaults + no auto-hub are injected
function makeSDK(extra = {}) {
    return new XChainSDK(Object.assign({
        network:     'bitcoin-regtest',
        explorerUrl: 'http://localhost:8080',
        encoderUrl:  'http://localhost:3000',
        retry: false
    }, extra));
}

// Patch all encoder methods
function mockEncoder(sdk, returnVal = {}) {
    const encoder = sdk.encoder;
    const proto = Object.getPrototypeOf(encoder);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(m => !m.startsWith('_') && m !== 'constructor');
    for (const m of methods) {
        if (typeof encoder[m] === 'function') {
            sinon.stub(encoder, m).resolves(returnVal);
        }
    }
    return encoder;
}

function registerEnvHooks() {
    let saved;
    beforeEach(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
}

describe('XChainSDK', function () {
    registerEnvHooks();

    // ACTION methods

    describe('createAction', function () {

        it('returns actionString for SEND without encoder', async function () {
            const sdk = makeSDK();
            const result = await sdk.createAction({ action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } });
            expect(result.actionString).to.be.a('string');
            expect(result.actionString).to.include('SEND');
        });

        it('calls encoder.createTx when encoder options with pubkey provided', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            const result = await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' },
                encoder: { pubkey: 'mypubkey' }
            });
            expect(result.psbt).to.equal('aabbcc');
            expect(result.encoding).to.equal('OP_RETURN');
            expect(sdk.encoder.createTx.calledOnce).to.be.true;
        });

        // The shared list keeps feeQuote, compress, options and sourceAddress aligned
        // with createTx so a high-level caller retains its protocol-fee output, FILE
        // compression policy, Taproot signer capability and source-address UTXO
        // selection.
        it('forwards EVERY optional encoder field to encoder.createTx', async function () {
            const EncoderClient = require('../../../src/clients/encoder.js');
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            const encoderOpts = { pubkey: 'mypubkey' };
            // A distinguishable value per optional field, whatever the list holds today.
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS) encoderOpts[key] = 'set:' + key;
            await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' },
                encoder: encoderOpts
            });
            const sent = sdk.encoder.createTx.firstCall.args[0];
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS)
                expect(sent[key], key + ' must reach createTx').to.equal('set:' + key);
            expect(sent.pubkey).to.equal('mypubkey');
            expect(sent.data).to.be.a('string');
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('createAction', function () {

        it('omits optional encoder fields the caller did not set (absent is not false)', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' },
                encoder: { pubkey: 'mypubkey' }
            });
            const sent = sdk.encoder.createTx.firstCall.args[0];
            // createTx reads absent and explicit-false as different wire meanings
            // (compress is tri-state), so an unset field must not appear at all.
            expect(Object.prototype.hasOwnProperty.call(sent, 'compress')).to.equal(false);
            expect(Object.prototype.hasOwnProperty.call(sent, 'feeQuote')).to.equal(false);
        });

        // Drift guard: the shared list is the ONLY place the optional set is named,
        // so it has to stay equal to what createTx's own mapper actually reads.
        it('the shared option list covers every optional field createTx maps', function () {
            const fs = require('fs');
            const path = require('path');
            const EncoderClient = require('../../../src/clients/encoder.js');
            const src = fs.readFileSync(path.join(__dirname, '../../../src/clients/encoder.js'), 'utf8');
            const start = src.indexOf('async createTx(params)');
            // Stop at the next method, or spendP2sh's own params leak into the scan.
            const end = src.indexOf('\n    async ', start + 1);
            const body = src.slice(start, end);
            const read = new Set();
            for (const m of body.matchAll(/params\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]);
            read.delete('data'); read.delete('pubkey');   // required, set explicitly by each caller
            const listed = new Set(EncoderClient.CREATE_TX_OPTION_FIELDS);
            const missing = [...read].filter(k => !listed.has(k));
            expect(missing, 'createTx reads these but the shared list drops them: ' + missing.join(', ')).to.deep.equal([]);
        });
    });
});
