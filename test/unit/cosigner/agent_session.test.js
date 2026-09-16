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
 * Unit tests for src/cosigner/agent_session.js: the policy-bounded agent wallet.
 * WalletSession.submit is stubbed so no encoder/explorer is touched;
 * these tests exercise ONLY the policy layer and its persistence.
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const sinon  = require('sinon');
const { expect } = require('chai');

const WalletSession  = require('../../../src/utils/wallet_session.js');
const AgentSession   = require('../../../src/cosigner/agent_session.js');
const { SDKPolicyError } = require('../../../src/utils/errors.js');
const { UNRESOLVED_TICK_BUCKET } = require('../../../src/cosigner/policy_evaluator.js');

// Fake just enough of XChainSDK for the WalletSession constructor.
const fakeSdk = {
    wallet: {
        importWIF: () => ({ publicKeyHex: '02ab', publicKey: Buffer.from('02ab', 'hex'), compressed: true }),
        deriveAddress: () => 'agent1testaddress',
    },
};

let tmpDir, stateFile, submitStub;

// allowUnbounded / allowUnkeyedSubmits are explicit opt-outs, defaulted ON
// here so every test below keeps exercising the behavior it was written
// for; the new requirements get their own tests, which construct WITHOUT
// these flags.
const mk = (policy) => new AgentSession(fakeSdk, 'WIF', Object.assign({
    allowedActions: ['SEND', 'MINT'],
    allowUnbounded: true,
    allowUnkeyedSubmits: true,
    stateFile,
}, policy));

const expectDeny = async (fn, code) => {
    try { await fn(); } catch (err) {
        expect(err).to.be.instanceOf(SDKPolicyError);
        expect(err.code).to.equal(code);
        return err;
    }
    throw new Error(`expected SDKPolicyError ${code}`);
};

function registerHooks() {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-'));
        stateFile = path.join(tmpDir, 'usage.json');
        // Stub the unlocked encode/sign/broadcast body both submit() paths funnel
        // through (AgentSession.submit runs its policy check + record around
        // super.submitInner under the shared serialization tail).
        submitStub = sinon.stub(WalletSession.prototype, 'submitInner')
            .resolves({ txid: 'tx123', status: 'valid' });
    });

    afterEach(() => {
        submitStub.restore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
}

describe('AgentSession (policy-bounded wallet)', () => {
    registerHooks();

    // construction

    it('refuses construction without allowedActions (fail-closed)', () => {
        expect(() => new AgentSession(fakeSdk, 'WIF', {})).to.throw(SDKPolicyError)
            .with.property('code', 'POLICY_INVALID');
        expect(() => new AgentSession(fakeSdk, 'WIF', { allowedActions: [] })).to.throw(SDKPolicyError);
    });

    // An allowlist bounds WHICH actions run, never how much they move.
    it('refuses construction with an allowlist but no spend ceiling', () => {
        expect(() => new AgentSession(fakeSdk, 'WIF', { allowedActions: ['SEND'], stateFile }))
            .to.throw(SDKPolicyError).with.property('code', 'POLICY_INVALID');
        // Any one of the three ceilings satisfies it.
        expect(() => new AgentSession(fakeSdk, 'WIF', { allowedActions: ['SEND'], stateFile, maxPerAction: { SEND: { TOK: '5' } } })).to.not.throw();
        expect(() => new AgentSession(fakeSdk, 'WIF', { allowedActions: ['SEND'], stateFile, maxPerWindow: { hours: 1, perTick: { TOK: '5' } } })).to.not.throw();
        expect(() => new AgentSession(fakeSdk, 'WIF', { allowedActions: ['SEND'], stateFile, confirmAbove: { handler: async () => true } })).to.not.throw();
        // ...and running unbounded stays possible, but only as a typed opt-in.
        expect(() => new AgentSession(fakeSdk, 'WIF', { allowedActions: ['SEND'], stateFile, allowUnbounded: true })).to.not.throw();
    });

    // A cap table that exists but resolves no cap is not a ceiling: capFor returns
    // undefined for every lookup, so policyEvaluator's amount comparisons are all
    // skipped and the allowlisted action moves any amount at all.
    it('refuses construction on a cap table with no usable entry', () => {
        const build = (extra) => () => new AgentSession(fakeSdk, 'WIF',
            Object.assign({ allowedActions: ['SEND'], stateFile }, extra));
        expect(build({ maxPerAction: {} })).to.throw(SDKPolicyError).with.property('code', 'POLICY_INVALID');
        expect(build({ maxPerAction: { SEND: {} } })).to.throw(SDKPolicyError);
        expect(build({ maxPerAction: { SEND: { TOK: '' } } })).to.throw(SDKPolicyError);
        expect(build({ maxPerWindow: { hours: 1, perTick: {} } })).to.throw(SDKPolicyError);
        // Inherited entries are invisible to capFor, so they are no ceiling either.
        expect(build({ maxPerAction: { SEND: Object.create({ TOK: '5' }) } })).to.throw(SDKPolicyError);
        // Populated tables still construct, and the unbounded opt-in is unchanged.
        expect(build({ maxPerAction: { SEND: { TOK: '5' } } })).to.not.throw();
        expect(build({ maxPerWindow: { hours: 1, perTick: { '*': '5' } } })).to.not.throw();
        expect(build({ maxPerAction: {}, allowUnbounded: true })).to.not.throw();
    });
});

describe('AgentSession (policy-bounded wallet)', () => {
    registerHooks();
    // kill switch + idempotency

    it('refuses a submit with no idempotencyKey, and accepts one with a key', async () => {
        const s = new AgentSession(fakeSdk, 'WIF', { allowedActions: ['SEND'], stateFile, allowUnbounded: true });
        await expectDeny(() => s.send({ tick: 'TOK', amount: '1', destination: 'dest' }), 'POLICY_IDEMPOTENCY_REQUIRED');
        expect(submitStub.called).to.equal(false, 'refused before any broadcast');
        await s.send({ tick: 'TOK', amount: '1', destination: 'dest' }, {}, { idempotencyKey: 'k1' });
        expect(submitStub.calledOnce).to.equal(true);
    });

    it('pause() halts before evaluation or broadcast, and resume() restores', async () => {
        const s = mk();
        s.pause();
        await expectDeny(() => s.send({ tick: 'TOK', amount: '1', destination: 'dest' }), 'POLICY_HALTED');
        expect(submitStub.called).to.equal(false, 'a halted session must not broadcast');
        s.resume();
        await s.send({ tick: 'TOK', amount: '1', destination: 'dest' });
        expect(submitStub.calledOnce).to.equal(true);
    });

    it('a kill-switch file dropped beside a RUNNING session halts it', async () => {
        const halt = path.join(tmpDir, 'halt-flag');
        const s = mk({ killSwitchFile: halt });
        await s.send({ tick: 'TOK', amount: '1', destination: 'dest' });   // healthy first
        expect(submitStub.calledOnce).to.equal(true);
        fs.writeFileSync(halt, '');                                        // operator drops the flag
        await expectDeny(() => s.send({ tick: 'TOK', amount: '1', destination: 'dest' }), 'POLICY_HALTED');
        expect(submitStub.calledOnce).to.equal(true, 'no second broadcast after the halt');
        fs.rmSync(halt);
        await s.send({ tick: 'TOK', amount: '1', destination: 'dest' });   // and lifting it resumes
        expect(submitStub.calledTwice).to.equal(true);
    });

    it('validates window hours and confirm handler at construction', () => {
        expect(() => mk({ maxPerWindow: { hours: 0 } })).to.throw(SDKPolicyError);
        expect(() => mk({ confirmAbove: { perTick: { '*': '1' } } })).to.throw(SDKPolicyError);
    });
});

describe('AgentSession (policy-bounded wallet)', () => {
    registerHooks();
    // action + destination gates

    it('allows an allowlisted action through and attaches the policy report', async () => {
        const s = mk();
        const res = await s.send({ tick: 'TOK', amount: '5', destination: 'dest1' });
        expect(submitStub.calledOnce).to.equal(true);
        expect(res.txid).to.equal('tx123');
        expect(res.policy.action).to.equal('SEND');
        expect(res.policy.windowUsage.count).to.equal(1);
        expect(res.policy.windowUsage.perTick.TOK).to.equal('5');
    });

    it('denies actions outside the allowlist without touching submit', async () => {
        const s = mk();
        const err = await expectDeny(() => s.sweep({}), 'POLICY_ACTION_DENIED');
        expect(err.details.action).to.equal('SWEEP');
        expect(submitStub.called).to.equal(false);
    });

    it('enforces the destination allowlist, including multi-destination strings', async () => {
        const s = mk({ allowedDestinations: ['good1', 'good2'] });
        await s.send({ tick: 'TOK', amount: '1', destination: 'good1' });
        await expectDeny(() => s.send({ tick: 'TOK', amount: '1', destination: 'evil' }),
            'POLICY_DESTINATION_DENIED');
        await expectDeny(() => s.send({ tick: 'TOK', amount: '1', destination: 'good1;evil' }),
            'POLICY_DESTINATION_DENIED');
    });

    // amount caps

    it('enforces per-action caps with tick-specific and wildcard entries', async () => {
        const s = mk({ maxPerAction: { SEND: { TOK: '100', '*': '10' } } });
        await s.send({ tick: 'TOK', amount: '100' });                  // at cap: allowed
        await expectDeny(() => s.send({ tick: 'TOK', amount: '100.00000001' }), 'POLICY_AMOUNT_EXCEEDED');
        await expectDeny(() => s.send({ tick: 'OTHER', amount: '11' }), 'POLICY_AMOUNT_EXCEEDED');
        await s.send({ tick: 'OTHER', amount: '10' });                 // wildcard cap boundary
    });

    it('compares amounts as big numbers, not floats', async () => {
        const s = mk({ maxPerAction: { SEND: { TOK: '0.30000000000000000000001' } } });
        // 0.1 + 0.2 > 0.3 in float math; as bignumbers 0.3 stays under this cap
        await s.send({ tick: 'TOK', amount: '0.3' });
        await expectDeny(() => s.send({ tick: 'TOK', amount: '0.30000000000000000000002' }),
            'POLICY_AMOUNT_EXCEEDED');
    });
});
