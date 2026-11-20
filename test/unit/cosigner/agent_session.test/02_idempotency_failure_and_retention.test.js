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
const WalletSession = require('../../../../src/utils/wallet_session.js');
const AgentSession = require('../../../../src/cosigner/agent_session.js');

const fakeSdk = {
    wallet: {
        importWIF: () => ({ publicKeyHex: '02ab', publicKey: Buffer.from('02ab', 'hex'), compressed: true }),
        deriveAddress: () => 'agent1testaddress',
    },
};

const expectCode = async (fn, code) => {
    try { await fn(); } catch (error) {
        expect(error.code).to.equal(code);
        return error;
    }
    throw new Error(`expected ${code}`);
};

let stateFile;
let submitStub;
function registerHooks() {
    beforeEach(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-idempotency-'));
        stateFile = path.join(dir, 'usage.json');
        submitStub = sinon.stub(WalletSession.prototype, 'submitInner');
    });
    afterEach(() => sinon.restore());
}

const mk = (overrides = {}) => new AgentSession(fakeSdk, 'WIF', Object.assign({
    allowedActions: ['SEND'],
    maxPerAction: { SEND: { TOK: '100', '*': '0' } },
    stateFile,
}, overrides));

const send = (session, key) => session.send(
    { tick: 'TOK', amount: '5' }, undefined, { idempotencyKey: key });

describe('AgentSession idempotency failure boundaries', () => {
    registerHooks();

    it('releases a proven pre-broadcast key across a restart but keeps its budget row', async () => {
        const before = Object.assign(new Error('create failed'), { preBroadcast: true });
        submitStub.onFirstCall().rejects(before);
        submitStub.onSecondCall().resolves({ txid: 'tx-retry', status: 'valid' });
        const first = mk();
        await expectCode(() => send(first, 'retry-key'), undefined);

        const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(persisted.entries).to.have.lengthOf(1);
        expect(persisted.entries[0]).not.to.have.property('key');

        const restarted = mk();
        const result = await send(restarted, 'retry-key');
        expect(result.txid).to.equal('tx-retry');
        expect(restarted.computeWindowUsage().count).to.equal(2);
        expect(submitStub.calledTwice).to.equal(true);
    });

    it('keeps an untagged ambiguous failure locked and reports its unknown outcome', async () => {
        submitStub.onFirstCall().rejects(new Error('broadcast acknowledgement lost'));
        const session = mk();
        await expectCode(() => send(session, 'ambiguous-key'), undefined);
        const refusal = await expectCode(
            () => send(session, 'ambiguous-key'), 'POLICY_DUPLICATE_SUBMIT');
        expect(refusal.details).to.include({ txid: null, outcomeUnknown: true });
        expect(refusal.message).to.match(/outcome is unknown/i);
        expect(submitStub.calledOnce).to.equal(true);
    });
});

describe('AgentSession idempotency retention boundaries', () => {
    registerHooks();

    it('expires keys and persisted rows without a spend window', async () => {
        submitStub.resolves({ txid: 'tx', status: 'valid' });
        const session = mk({ idempotencyHours: 2 });
        const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
        try {
            await send(session, 'no-window-key');
            clock.tick(60 * 60 * 1000);
            await expectCode(() => send(session, 'no-window-key'), 'POLICY_DUPLICATE_SUBMIT');
            clock.tick(2 * 60 * 60 * 1000);
            await send(session, 'no-window-key');
            expect(submitStub.calledTwice).to.equal(true);
            const rows = JSON.parse(fs.readFileSync(stateFile, 'utf8')).entries;
            expect(rows).to.have.lengthOf(1);
            expect(rows[0].t).to.equal(Date.now());
        } finally { clock.restore(); }
    });

    it('expires a key before a longer spend window while retaining its budget row', async () => {
        submitStub.resolves({ txid: 'tx', status: 'valid' });
        const session = mk({
            maxPerWindow: { hours: 24, perTick: { TOK: '100' } },
            idempotencyHours: 1,
        });
        const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
        try {
            await send(session, 'short-key');
            clock.tick(2 * 60 * 60 * 1000);
            const result = await send(session, 'short-key');
            expect(result.policy.windowUsage.count).to.equal(2);
            expect(submitStub.calledTwice).to.equal(true);
        } finally { clock.restore(); }
    });
});
