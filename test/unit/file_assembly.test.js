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
const nock = require('nock');
const sinon = require('sinon');
const ExplorerClient = require('../../src/clients/explorer.js');
const XChainSDK = require('../../src/XChainSDK.js');

const BASE = 'http://explorer.test:8080';

function makeClient() {
    return new ExplorerClient({
        network: 'bitcoin-mainnet',
        explorerUrl: 'explorer.test',
        explorerPort: 8080,
        retry: false
    });
}

function multipart(status, partsReceived) {
    return {
        file_hash: 'a'.repeat(64),
        total_parts: 3,
        parts_received: partsReceived,
        total_bytes: 1440,
        status
    };
}

describe('file assembly reads', function () {
    afterEach(function () {
        sinon.restore();
        nock.cleanAll();
    });

    for (const [status, partsReceived] of [['pending', 2], ['complete', 3], ['mismatch', 3]]) {
        it('returns the ' + status + ' multipart body', async function () {
            const expected = multipart(status, partsReceived);
            nock(BASE).get('/BTC/api/action/42').reply(200, { data: [{ multipart: expected }] });

            expect(await makeClient().getFileAssembly(42)).to.deep.equal(expected);
        });
    }

    it('returns null when the action has no multipart body', async function () {
        nock(BASE).get('/BTC/api/action/43').reply(200, { data: [{ action_index: 43 }] });

        expect(await makeClient().getFileAssembly(43)).to.equal(null);
    });

    it('unwraps an action detail nested under action', async function () {
        const expected = multipart('complete', 3);
        nock(BASE).get('/BTC/api/action/44').reply(200, {
            data: { action: { action_index: 44, multipart: expected } }
        });

        expect(await makeClient().getFileAssembly(44)).to.deep.equal(expected);
    });

    it('reads a sibling coin at the configured network tier', async function () {
        const expected = multipart('pending', 1);
        nock(BASE).get('/DOGE/api/action/45').reply(200, { data: [{ multipart: expected }] });

        expect(await makeClient().getFileAssembly(45, 'DOGE')).to.deep.equal(expected);
    });

    it('delegates from the SDK with the action index and coin', async function () {
        const sdk = new XChainSDK({
            network: 'bitcoin-mainnet',
            explorerUrl: 'explorer.test',
            explorerPort: 8080,
            retry: false
        });
        const expected = multipart('pending', 1);
        const read = sinon.stub(sdk.explorer, 'getFileAssembly').resolves(expected);

        expect(await sdk.getFileAssembly(46, 'LTC')).to.equal(expected);
        expect(read.calledOnceWithExactly(46, 'LTC')).to.equal(true);
    });
});
