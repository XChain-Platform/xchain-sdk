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
const { evaluatePolicy } = require('../../src/cosigner/policyEvaluator.js');

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
});
