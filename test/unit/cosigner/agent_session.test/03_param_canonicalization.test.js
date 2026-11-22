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
const sinon = require('sinon');
const { expect } = require('chai');
const AgentSession = require('../../../../src/cosigner/agent_session.js');
const WalletSession = require('../../../../src/utils/wallet_session.js');

const fakeSdk = {
    wallet: {
        importWIF: () => ({ publicKeyHex: '02ab', publicKey: Buffer.from('02ab', 'hex'), compressed: true }),
        deriveAddress: () => 'agent-address',
    },
};

function policy(stateFile) {
    return {
        allowedActions: ['SEND'],
        allowedDestinations: ['allowed-address'],
        maxPerAction: { SEND: { TOK: '100' } },
        allowUnkeyedSubmits: true,
        stateFile,
    };
}

async function expectCode(promise, code) {
    try {
        await promise;
    } catch (err) {
        expect(err.code).to.equal(code);
        return;
    }
    throw new Error(`expected ${code}`);
}

describe('AgentSession parameter canonicalization', () => {
    let submitInner;
    let stateFile;

    beforeEach(() => {
        stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-param-policy-')), 'usage.json');
        submitInner = sinon.stub(WalletSession.prototype, 'submitInner').resolves({ txid: 'tx-canonical' });
    });

    afterEach(() => sinon.restore());

    it('evaluates and sends the same canonical params', async () => {
        const session = new AgentSession(fakeSdk, 'WIF', policy(stateFile));
        const result = await session.submit({
            action: 'SEND',
            params: { Tick: 'TOK', Amount: '50', Destination: 'allowed-address' },
        });

        expect(result.policy).to.include({ tick: 'TOK', amount: '50' });
        expect(submitInner.firstCall.args[0].params).to.deep.equal({
            TICK: 'TOK', AMOUNT: '50', DESTINATION: 'allowed-address',
        });
    });

    it('refuses normalized-key collisions before broadcast or window use', async () => {
        const session = new AgentSession(fakeSdk, 'WIF', policy(stateFile));
        await expectCode(session.submit({
            action: 'SEND',
            params: { tick: 'TOK', amount: '1', AMOUNT: '1000', destination: 'allowed-address' },
        }), 'POLICY_PARAM_KEY_COLLISION');

        expect(submitInner.called).to.equal(false);
        expect(session.computeWindowUsage().count).to.equal(0);
    });

    it('refuses unmeasured LEGS when amount or destination policy is configured', async () => {
        const session = new AgentSession(fakeSdk, 'WIF', policy(stateFile));
        await expectCode(session.submit({
            action: 'SEND',
            params: { tick: 'TOK', legs: [{ amount: '1000', destination: 'other-address' }] },
        }), 'POLICY_LEGS_UNSUPPORTED');

        expect(submitInner.called).to.equal(false);
        expect(session.computeWindowUsage().count).to.equal(0);
    });
});
