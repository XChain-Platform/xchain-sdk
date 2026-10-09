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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const AgentSession = require('../../../src/cosigner/agent_session.js');
const WalletSession = require('../../../src/utils/wallet_session.js');

const FULL_ADDRESS = 'bc1qallowedfulladdress';

function makeSdk(captured, stop) {
    return {
        wallet: {
            importWIF: () => ({
                publicKeyHex: '02ab',
                publicKey: Buffer.from('02ab', 'hex'),
                compressed: true,
            }),
            deriveAddress: () => 'agent1testaddress',
        },
        tickResolver: {
            resolveActionParams: async (action, params) => params,
        },
        addressResolver: {
            resolveActionParams: async (action, params) => {
                captured.addressResolverCalls++;
                return Object.assign({}, params, { destination: '^57' });
            },
        },
        actions: {
            createAction: (data) => {
                captured.created.push(data);
                throw stop;
            },
        },
        requireEncoder: () => ({
            getUTXOs: async () => ({ utxos: [] }),
        }),
    };
}

async function expectStopped(promise, stop) {
    try {
        await promise;
    } catch (error) {
        expect(error).to.equal(stop);
        return;
    }
    throw new Error('expected action creation to stop the submission');
}

describe('allowedDestinations full-address encoding', function () {
    let tmpDir;

    beforeEach(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-destinations-'));
    });

    afterEach(function () {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    for (const action of ['MINT', 'MESSAGE', 'SWEEP']) {
        it(`keeps an allowed ${action} destination as a full address`, async function () {
            const captured = { addressResolverCalls: 0, created: [] };
            const stop = new Error('stop after action creation');
            const session = new AgentSession(makeSdk(captured, stop), 'WIF', {
                allowedActions: [action],
                allowedDestinations: [FULL_ADDRESS],
                allowUnbounded: true,
                allowUnkeyedSubmits: true,
                stateFile: path.join(tmpDir, `${action}.json`),
            });

            await expectStopped(session.submit({
                action,
                params: { tick: 'TOK', amount: '1', destination: FULL_ADDRESS },
            }), stop);

            expect(captured.addressResolverCalls).to.equal(0);
            expect(captured.created).to.have.length(1);
            expect(captured.created[0].params.destination).to.equal(FULL_ADDRESS);
        });
    }

    it('keeps address resolution enabled for other allowed actions', async function () {
        const captured = { addressResolverCalls: 0, created: [] };
        const stop = new Error('stop after action creation');
        const session = new AgentSession(makeSdk(captured, stop), 'WIF', {
            allowedActions: ['SEND'],
            allowedDestinations: [FULL_ADDRESS],
            allowUnbounded: true,
            allowUnkeyedSubmits: true,
            stateFile: path.join(tmpDir, 'SEND.json'),
        });

        await expectStopped(session.submit({
            action: 'SEND',
            params: { tick: 'TOK', amount: '1', destination: FULL_ADDRESS },
        }), stop);

        expect(captured.addressResolverCalls).to.equal(1);
        expect(captured.created).to.have.length(1);
        expect(captured.created[0].params.destination).to.equal('^57');
    });

    it('keeps default address compaction for an ordinary wallet session', async function () {
        const captured = { addressResolverCalls: 0, created: [] };
        const stop = new Error('stop after action creation');
        const session = new WalletSession(makeSdk(captured, stop), 'WIF');

        await expectStopped(session.submit({
            action: 'MINT',
            params: { tick: 'TOK', amount: '1', destination: FULL_ADDRESS },
        }), stop);

        expect(captured.addressResolverCalls).to.equal(1);
        expect(captured.created).to.have.length(1);
        expect(captured.created[0].params.destination).to.equal('^57');
    });
});
