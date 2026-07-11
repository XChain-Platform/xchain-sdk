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
const { evaluatePolicy, GAS_TICK } = require('../../src/cosigner/policyEvaluator.js');

// The pure verdict function shared by AgentSession (client guardrail) and the
// co-signer daemon (hard enforcement). No I/O, no throws: deny is a return
// value. These tests pin that contract independently of either caller.

describe('policyEvaluator.evaluatePolicy', function () {

    const send = (params) => ({ action: 'SEND', params });

    it('allows an in-policy action', function () {
        const policy = { allowedActions: new Set(['SEND']) };
        const v = evaluatePolicy(policy, send({ tick: 'TOK', amount: '5', destination: 'bc1qx' }));
        expect(v.ok).to.equal(true);
        expect(v.violation).to.equal(null);
        expect(v.evaluation).to.deep.include({ action: 'SEND', tick: 'TOK', amount: '5' });
        expect(v.evaluation.destinations).to.deep.equal(['bc1qx']);
    });

    it('denies an action not in allowedActions (returns, never throws)', function () {
        const policy = { allowedActions: new Set(['SEND']) };
        const v = evaluatePolicy(policy, { action: 'ISSUE', params: {} });
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_ACTION_DENIED');
        expect(v.violation.details).to.deep.equal({ action: 'ISSUE' });
    });

    it('uppercases the action name before matching', function () {
        const policy = { allowedActions: new Set(['SEND']) };
        expect(evaluatePolicy(policy, { action: 'send', params: {} }).ok).to.equal(true);
    });

    it('accepts a plain Array for allowedActions/allowedDestinations (daemon-friendly)', function () {
        const policy = { allowedActions: ['SEND'], allowedDestinations: ['bc1qok'] };
        expect(evaluatePolicy(policy, send({ destination: 'bc1qok' })).ok).to.equal(true);
        const v = evaluatePolicy(policy, send({ destination: 'bc1qBAD' }));
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_DESTINATION_DENIED');
    });

    it('checks every destination in a semicolon list', function () {
        const policy = { allowedActions: new Set(['SEND']), allowedDestinations: new Set(['a', 'b']) };
        expect(evaluatePolicy(policy, send({ destination: 'a;b' })).ok).to.equal(true);
        const v = evaluatePolicy(policy, send({ destination: 'a;c' }));
        expect(v.violation.code).to.equal('POLICY_DESTINATION_DENIED');
        expect(v.violation.details.destination).to.equal('c');
    });

    it('rejects a negative amount before any cap can be bypassed', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '10' } } };
        const v = evaluatePolicy(policy, send({ tick: 'TOK', amount: '-1000000' }));
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_AMOUNT_INVALID');
    });

    it('rejects a negative amount that would poison the window total', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, perTick: { TOK: '100' } } };
        const v = evaluatePolicy(policy, send({ tick: 'TOK', amount: '-1000000' }), { count: 1, perTick: { TOK: '0' } });
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_AMOUNT_INVALID');
    });

    it('rejects malformed amount strings (sign, exponent, hex, whitespace, trailing dot)', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { '*': '1000' } } };
        for (const bad of ['1e5', '0x10', ' 5', '--5', '+5', '5.', 'NaN']) {
            const v = evaluatePolicy(policy, send({ tick: 'TOK', amount: bad }));
            expect(v.ok, `amount ${JSON.stringify(bad)} should be rejected`).to.equal(false);
            expect(v.violation.code).to.equal('POLICY_AMOUNT_INVALID');
        }
    });

    it('still allows a canonical non-negative decimal amount', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '10' } } };
        expect(evaluatePolicy(policy, send({ tick: 'TOK', amount: '9.5' })).ok).to.equal(true);
    });

    it('enforces the per-action cap with exact decimal comparison (no epsilon)', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '10' } } };
        expect(evaluatePolicy(policy, send({ tick: 'TOK', amount: '10' })).ok).to.equal(true);     // == cap is allowed
        const v = evaluatePolicy(policy, send({ tick: 'TOK', amount: '10.00000001' }));
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('falls back to the wildcard per-action cap', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { '*': '3' } } };
        expect(evaluatePolicy(policy, send({ tick: 'ANY', amount: '4' })).violation.code)
            .to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('enforces the window action-count cap from the passed-in usage snapshot', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, maxActions: 2 } };
        expect(evaluatePolicy(policy, send({ amount: '1' }), { count: 1, perTick: {} }).ok).to.equal(true);
        const v = evaluatePolicy(policy, send({ amount: '1' }), { count: 2, perTick: {} });
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_WINDOW_COUNT_EXCEEDED');
    });

    it('enforces the window per-tick cap against the running total', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, perTick: { TOK: '100' } } };
        // 95 already spent + 5 = 100, allowed; + 6 = 101, denied.
        expect(evaluatePolicy(policy, send({ tick: 'TOK', amount: '5' }), { count: 1, perTick: { TOK: '95' } }).ok).to.equal(true);
        const v = evaluatePolicy(policy, send({ tick: 'TOK', amount: '6' }), { count: 1, perTick: { TOK: '95' } });
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_WINDOW_AMOUNT_EXCEEDED');
        expect(v.violation.details.windowTotal).to.equal('95');
    });

    it('treats a missing window snapshot as an empty window', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, maxActions: 1 } };
        expect(evaluatePolicy(policy, send({ amount: '1' })).ok).to.equal(true);   // count 0 + 1 <= 1
    });

    it('flags needsConfirmation above the threshold without denying', function () {
        const policy = { allowedActions: new Set(['SEND']), confirmAbove: { perTick: { '*': '50' } } };
        expect(evaluatePolicy(policy, send({ tick: 'TOK', amount: '40' })).evaluation.needsConfirmation).to.equal(false);
        const v = evaluatePolicy(policy, send({ tick: 'TOK', amount: '60' }));
        expect(v.ok).to.equal(true);
        expect(v.evaluation.needsConfirmation).to.equal(true);
    });

    it('fail-closed default: empty allowedActions denies everything', function () {
        expect(evaluatePolicy({ allowedActions: new Set() }, send({ amount: '1' })).ok).to.equal(false);
    });

    // Caps must bind to each action's real value field, not only literal AMOUNT.
    describe('per-action value-field binding', function () {

        it('caps a SWAP on its GIVE_AMOUNT/GIVE_TICK (was uncapped)', function () {
            const policy = { allowedActions: new Set(['SWAP']), maxPerAction: { SWAP: { FOO: '100' } } };
            const over = evaluatePolicy(policy, { action: 'SWAP', params: { giveTick: 'FOO', giveAmount: '1000000', getTick: 'BAR', getAmount: '1' } });
            expect(over.ok).to.equal(false);
            expect(over.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
            const under = evaluatePolicy(policy, { action: 'SWAP', params: { giveTick: 'FOO', giveAmount: '50', getTick: 'BAR', getAmount: '1' } });
            expect(under.ok).to.equal(true);
        });

        it('caps a DEPOSIT on its QUANTITY (UPPER_SNAKE decoded form)', function () {
            const policy = { allowedActions: new Set(['DEPOSIT']), maxPerAction: { DEPOSIT: { '*': '100' } } };
            const over = evaluatePolicy(policy, { action: 'DEPOSIT', params: { TICK: 'FOO', QUANTITY: '1000000' } });
            expect(over.ok).to.equal(false);
            expect(over.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
            expect(evaluatePolicy(policy, { action: 'DEPOSIT', params: { TICK: 'FOO', QUANTITY: '50' } }).ok).to.equal(true);
        });

        it('caps ORDER/DISPENSER on the GIVE leg too', function () {
            const policy = { allowedActions: new Set(['ORDER', 'DISPENSER']), maxPerAction: { '*': {} , ORDER: { '*': '10' }, DISPENSER: { '*': '10' } } };
            expect(evaluatePolicy(policy, { action: 'ORDER', params: { GIVE_TICK: 'FOO', GIVE_AMOUNT: '11' } }).ok).to.equal(false);
            expect(evaluatePolicy(policy, { action: 'DISPENSER', params: { GIVE_TICK: 'FOO', GIVE_AMOUNT: '11' } }).ok).to.equal(false);
        });

        // Capability STAKE (v1/v2) debits the gas token but carries no TICK field;
        // its tick defaults to GAS_TICK so gas-scoped caps bind (previously only
        // the '*' wildcard applied).
        it('binds a gas-scoped cap to capability STAKE (no TICK field)', function () {
            const policy = { allowedActions: new Set(['STAKE']), maxPerAction: { STAKE: { [GAS_TICK]: '100' } } };
            const over = evaluatePolicy(policy, { action: 'STAKE', params: { amount: '150', signingPubkey: 'ab'.repeat(32) } });
            expect(over.ok).to.equal(false);
            expect(over.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
            expect(evaluatePolicy(policy, { action: 'STAKE', params: { amount: '50', signingPubkey: 'ab'.repeat(32) } }).ok).to.equal(true);
        });

        it('accumulates capability STAKE under the gas tick in the window cap', function () {
            const policy = { allowedActions: new Set(['STAKE']), maxPerWindow: { hours: 24, perTick: { [GAS_TICK]: '100' } } };
            const usage = { count: 1, perTick: { [GAS_TICK]: '95' } };
            const v = evaluatePolicy(policy, { action: 'STAKE', params: { amount: '6' } }, usage);
            expect(v.ok).to.equal(false);
            expect(v.violation.code).to.equal('POLICY_WINDOW_AMOUNT_EXCEEDED');
            expect(evaluatePolicy(policy, { action: 'STAKE', params: { amount: '5' } }, usage).ok).to.equal(true);
        });

        it('contract-targeted STAKE v3 keeps its own TICK (gas default does not override)', function () {
            const policy = { allowedActions: new Set(['STAKE']), maxPerAction: { STAKE: { [GAS_TICK]: '1' } } };
            // TICK=FOO: the XCHAIN cap must not bind, and with no FOO/'*' cap the stake passes.
            const v = evaluatePolicy(policy, { action: 'STAKE', params: { amount: '50', TICK: 'FOO', TARGET_CONTRACT_INDEX: '7' } });
            expect(v.ok).to.equal(true);
            expect(v.evaluation.tick).to.equal('FOO');
        });
    });

    // The SDK compacts an indexed token's tick to its ^<id> wire form by default,
    // and the daemon evaluates params decoded from the PSBT, so the same token can
    // arrive as 'NAME' or '^123'. Identity-sensitive rules must resolve the
    // reference or fail closed; otherwise a named cap falls through to the
    // wildcard and per-tick window totals fragment across the two wire forms.
    describe('^id wire-form tick references', function () {

        it('fails closed on an unresolvable ^id under a named per-action cap', function () {
            const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { MYTOKEN: '10' } } };
            const v = evaluatePolicy(policy, send({ tick: '^123', amount: '1000000' }));
            expect(v.ok).to.equal(false);
            expect(v.violation.code).to.equal('POLICY_UNRESOLVED_TICK');
        });

        it('fails closed on an unresolvable ^id under a per-tick window cap (even wildcard)', function () {
            const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, perTick: { '*': '100' } } };
            const v = evaluatePolicy(policy, send({ tick: '^123', amount: '1' }), { count: 0, perTick: {} });
            expect(v.ok).to.equal(false);
            expect(v.violation.code).to.equal('POLICY_UNRESOLVED_TICK');
        });

        it('resolves a declared ^id via policy.tickIds and binds the named cap', function () {
            const policy = {
                allowedActions: new Set(['SEND']),
                maxPerAction:   { SEND: { MYTOKEN: '10' } },
                tickIds:        { MYTOKEN: 123 },
            };
            const over = evaluatePolicy(policy, send({ tick: '^123', amount: '11' }));
            expect(over.ok).to.equal(false);
            expect(over.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
            const under = evaluatePolicy(policy, send({ tick: '^123', amount: '10' }));
            expect(under.ok).to.equal(true);
            // Resolved name flows into the evaluation, so window totals accumulate
            // under one key regardless of wire form.
            expect(under.evaluation.tick).to.equal('MYTOKEN');
        });

        it('lets a ^id through when no rule depends on tick identity', function () {
            // Wildcard-only per-action cap binds by amount alone; count-only window
            // caps count actions. Neither needs the tick name.
            const policy = {
                allowedActions: new Set(['SEND']),
                maxPerAction:   { SEND: { '*': '10' } },
                maxPerWindow:   { hours: 24, maxActions: 5 },
            };
            expect(evaluatePolicy(policy, send({ tick: '^123', amount: '5' }), { count: 0, perTick: {} }).ok).to.equal(true);
            expect(evaluatePolicy(policy, send({ tick: '^123', amount: '11' }), { count: 0, perTick: {} }).violation.code)
                .to.equal('POLICY_AMOUNT_EXCEEDED');
        });
    });

    // Actions whose outflow can't be measured from params must fail closed when
    // an amount limit is set, instead of slipping past it silently.
    describe('unbounded value actions (SWEEP / AIRDROP / DIVIDEND)', function () {

        it('denies SWEEP when an amount cap is configured (whole-balance drain)', function () {
            const policy = { allowedActions: new Set(['SWEEP']), maxPerAction: { SEND: { '*': '100' } } };
            const v = evaluatePolicy(policy, { action: 'SWEEP', params: { destination: 'addr', balances: '1' } });
            expect(v.ok).to.equal(false);
            expect(v.violation.code).to.equal('POLICY_UNBOUNDED_ACTION');
        });

        it('denies AIRDROP/DIVIDEND under a per-tick window cap (per-unit amount under-counts)', function () {
            const policy = { allowedActions: new Set(['AIRDROP', 'DIVIDEND']), maxPerWindow: { hours: 24, perTick: { '*': '100' } } };
            expect(evaluatePolicy(policy, { action: 'AIRDROP', params: { tick: 'FOO', amount: '100' } }).violation.code).to.equal('POLICY_UNBOUNDED_ACTION');
            expect(evaluatePolicy(policy, { action: 'DIVIDEND', params: { tick: 'FOO', amount: '100' } }).violation.code).to.equal('POLICY_UNBOUNDED_ACTION');
        });

        it('allows an unbounded action when NO amount limit is set (operator opted out)', function () {
            const policy = { allowedActions: new Set(['SWEEP']) };
            expect(evaluatePolicy(policy, { action: 'SWEEP', params: { destination: 'addr' } }).ok).to.equal(true);
        });

        it('a count-only maxActions is not an amount limit and still allows the action', function () {
            const policy = { allowedActions: new Set(['AIRDROP']), maxPerWindow: { hours: 24, maxActions: 5 } };
            expect(evaluatePolicy(policy, { action: 'AIRDROP', params: { tick: 'FOO', amount: '1' } }).ok).to.equal(true);
        });
    });
});
