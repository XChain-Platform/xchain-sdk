// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// spendP2sh builds the phase-2 reveal through the same create_tx method as createTx,
// so it forwards the same option fields: a field it misses (the hub feeQuote was
// one) disappears from the reveal with no error. Only the fields a reveal does not
// take (funding inputs and the per-call options) stay off the reveal request.

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../../src/clients/encoder.js');

const BASE = 'http://encoder.test:3000';
const REVEAL_ONLY_ABSENT = ['utxos', 'sourceAddress', 'options'];

// A distinct, wire-safe value for every option field.
function valueFor(key) {
    if (key === 'encoding') return 'P2WSH';
    if (key === 'feeQuote') return { address: 'mfees5pa2HwNBonk5vG23aDWkN9fuDJib4', amount: 10678 };
    if (key === 'customOutputs') return [{ address: 'mfees5pa2HwNBonk5vG23aDWkN9fuDJib4', value: 5000 }];
    if (key === 'utxos') return [{ txid: 'ab'.repeat(32), vout: 0, value: 1000, scriptPubKey: '00' }];
    if (key === 'options') return { exactInputs: true };
    return 'value-of-' + key;
}

describe('EncoderClient', function () {
    afterEach(function () { nock.cleanAll(); });

    describe('spendP2sh forwards the createTx option fields', function () {
        it('puts the hub feeQuote on the reveal request', async function () {
            const feeQuote = valueFor('feeQuote');
            let seen = null;
            nock(BASE).post('/', (body) => { seen = body.params; return true; })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2SH' }, id: 1 });
            await new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 })
                .spendP2sh({ pubkey: 'pub', p2shHash: 'h', p2shHex: 'x', data: 'ACTION', feeQuote });
            expect(seen.feeQuote).to.deep.equal(feeQuote);
        });

        it('forwards every createTx option field except the ones a reveal does not take', async function () {
            const params = { pubkey: 'pub', p2shHash: 'h', p2shHex: 'x', data: 'ACTION' };
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS) params[key] = valueFor(key);
            let seen = null;
            nock(BASE).post('/', (body) => { seen = body.params; return true; })
                .reply(200, { jsonrpc: '2.0', result: { psbt: 'hex', encoding: 'P2WSH' }, id: 1 });
            await new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3000 }).spendP2sh(params);
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS) {
                if (REVEAL_ONLY_ABSENT.includes(key)) expect(seen, key).to.not.have.property(key);
                else expect(seen[key], key).to.deep.equal(params[key]);
            }
        });
    });
});
