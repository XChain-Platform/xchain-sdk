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
 * Unit tests for src/agentSession.js: the policy-bounded agent wallet.
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

const WalletSession  = require('../../src/walletSession.js');
const AgentSession   = require('../../src/agentSession.js');
const { SDKPolicyError } = require('../../src/errors.js');

// Fake just enough of XChainSDK for the WalletSession constructor.
const fakeSdk = {
    wallet: {
        importWIF: () => ({ publicKeyHex: '02ab', publicKey: Buffer.from('02ab', 'hex'), compressed: true }),
        deriveAddress: () => 'agent1testaddress',
    },
};

describe('AgentSession (policy-bounded wallet)', () => {

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

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-'));
        stateFile = path.join(tmpDir, 'usage.json');
        // Stub the unlocked encode/sign/broadcast body both submit() paths funnel
        // through (AgentSession.submit runs its policy check + record around
        // super._submitInner under the shared serialization tail).
        submitStub = sinon.stub(WalletSession.prototype, '_submitInner')
            .resolves({ txid: 'tx123', status: 'valid' });
    });

    afterEach(() => {
        submitStub.restore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

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

    // windows + persistence

    it('accumulates window usage and denies once the per-tick window cap would be crossed', async () => {
        const s = mk({ maxPerWindow: { hours: 24, perTick: { TOK: '10' } } });
        await s.send({ tick: 'TOK', amount: '4' });
        await s.send({ tick: 'TOK', amount: '6' });                    // total 10 = cap
        const err = await expectDeny(() => s.send({ tick: 'TOK', amount: '0.1' }),
            'POLICY_WINDOW_AMOUNT_EXCEEDED');
        expect(err.details.windowTotal).to.equal('10');
    });

    it('enforces the window action-count cap', async () => {
        const s = mk({ maxPerWindow: { hours: 1, maxActions: 2 } });
        await s.send({ tick: 'TOK', amount: '1' });
        await s.mint({ tick: 'TOK', amount: '1' });
        await expectDeny(() => s.send({ tick: 'TOK', amount: '1' }), 'POLICY_WINDOW_COUNT_EXCEEDED');
    });

    it('serializes concurrent submits so the window count cap cannot be bypassed', async () => {
        // maxActions=2; fire three at once. The check (reads the window) and the
        // record (writes it) must be atomic with the broadcast, or all three
        // evaluate against the empty window and exceed the cap.
        const s = mk({ maxPerWindow: { hours: 1, maxActions: 2 } });
        const outcomes = await Promise.allSettled([
            s.send({ tick: 'TOK', amount: '1' }),
            s.send({ tick: 'TOK', amount: '1' }),
            s.send({ tick: 'TOK', amount: '1' }),
        ]);
        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        const rejected  = outcomes.filter((o) => o.status === 'rejected');
        expect(fulfilled.length).to.equal(2);   // exactly the cap
        expect(rejected.length).to.equal(1);
        expect(rejected[0].reason).to.be.instanceOf(SDKPolicyError);
        expect(rejected[0].reason.code).to.equal('POLICY_WINDOW_COUNT_EXCEEDED');
        expect(submitStub.callCount).to.equal(2);   // only two actually broadcast
    });

    it('window usage survives a restart (new instance, same state file)', async () => {
        await mk({ maxPerWindow: { hours: 24, perTick: { TOK: '10' } } })
            .send({ tick: 'TOK', amount: '9' });
        const reborn = mk({ maxPerWindow: { hours: 24, perTick: { TOK: '10' } } });
        await expectDeny(() => reborn.send({ tick: 'TOK', amount: '2' }),
            'POLICY_WINDOW_AMOUNT_EXCEEDED');
    });

    it('expired entries fall out of the window', async () => {
        const s = mk({ maxPerWindow: { hours: 1, perTick: { TOK: '10' } } });
        const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
        try {
            await s.send({ tick: 'TOK', amount: '10' });
            clock.tick(61 * 60 * 1000);
            const res = await s.send({ tick: 'TOK', amount: '10' });   // old entry expired
            expect(res.policy.windowUsage.perTick.TOK).to.equal('10');
            expect(res.policy.windowUsage.count).to.equal(1);
        } finally { clock.restore(); }
    });

    it('fails CLOSED on a corrupt state file', async () => {
        fs.writeFileSync(stateFile, 'not json{');
        const s = mk({ maxPerWindow: { hours: 24, perTick: { TOK: '10' } } });
        await expectDeny(() => s.send({ tick: 'TOK', amount: '1' }), 'POLICY_STATE_CORRUPT');
        expect(submitStub.called).to.equal(false);
    });

    // confirmation + observer hooks

    it('asks for confirmation above the threshold and honors the answer', async () => {
        const handler = sinon.stub();
        handler.onFirstCall().resolves(true).onSecondCall().resolves(false);
        const s = mk({ confirmAbove: { perTick: { '*': '5' }, handler } });

        await s.send({ tick: 'TOK', amount: '6' });                    // confirmed
        expect(handler.firstCall.args[0]).to.include({ action: 'SEND', tick: 'TOK', amount: '6' });
        await expectDeny(() => s.send({ tick: 'TOK', amount: '7' }), 'POLICY_CONFIRMATION_DENIED');
        await s.send({ tick: 'TOK', amount: '5' });                    // under threshold: no ask
        expect(handler.callCount).to.equal(2);
    });

    it('notifies onPolicyViolation for every denial, and a throwing observer cannot unblock enforcement', async () => {
        const seen = [];
        const s = mk({
            onPolicyViolation: (v) => { seen.push(v.code); throw new Error('observer boom'); },
        });
        await expectDeny(() => s.sweep({}), 'POLICY_ACTION_DENIED');
        expect(seen).to.deep.equal(['POLICY_ACTION_DENIED']);
    });

    // idempotency key (at-most-once on retry)

    it('refuses a repeat submit with the same idempotencyKey, carrying the prior txid', async () => {
        const s = mk();
        const r = await s.send({ tick: 'TOK', amount: '5' }, undefined, { idempotencyKey: 'k1' });
        expect(r.txid).to.equal('tx123');
        const err = await expectDeny(
            () => s.send({ tick: 'TOK', amount: '5' }, undefined, { idempotencyKey: 'k1' }),
            'POLICY_DUPLICATE_SUBMIT');
        expect(err.details.txid).to.equal('tx123');
        expect(submitStub.calledOnce).to.equal(true);   // second submit never broadcast
    });

    it('without an idempotencyKey, repeat submits both broadcast (unchanged behavior)', async () => {
        const s = mk();
        await s.send({ tick: 'TOK', amount: '1' });
        await s.send({ tick: 'TOK', amount: '1' });
        expect(submitStub.calledTwice).to.equal(true);
    });

    it('patches the txid from a post-broadcast throw so a later duplicate refusal can return it', async () => {
        const s = mk();
        // First submit throws AFTER broadcast, carrying the txid in err.details.
        submitStub.onFirstCall().rejects(Object.assign(new Error('CONFIRMATION_TIMEOUT'),
            { details: { txid: 'landed-tx' } }));
        let thrown;
        try { await s.send({ tick: 'TOK', amount: '2' }, undefined, { idempotencyKey: 'k2' }); }
        catch (e) { thrown = e; }
        expect(thrown).to.be.instanceOf(Error);           // original error re-thrown
        // A retry with the same key is refused and returns the txid that landed.
        const err = await expectDeny(
            () => s.send({ tick: 'TOK', amount: '2' }, undefined, { idempotencyKey: 'k2' }),
            'POLICY_DUPLICATE_SUBMIT');
        expect(err.details.txid).to.equal('landed-tx');
    });

    // exports

    it('is exported from the SDK entry point with its error class', () => {
        const sdkIndex = require('../../index.js');
        expect(sdkIndex.AgentSession).to.equal(AgentSession);
        expect(sdkIndex.SDKPolicyError).to.equal(SDKPolicyError);
    });
});
