//  doctrine test-coverage program: llm-eval (scored) for the agentSession
// guardrail. AgentSession hands a key to an automated agent with a bounded
// blast radius; the enforcement verdict is the pure evaluatePolicy() brain that
// AgentSession wraps at its submit() chokepoint. This scores that brain across
// a scenario corpus and asserts the pass-rate clears a floor, framed as a
// scored eval rather than a single hard assertion.

const assert = require('assert');
// The component under eval (loaded to bind the eval to the agentSession surface).
require('../../src/agentSession.js');
const { evaluatePolicy } = require('../../src/cosigner/policyEvaluator.js');

// A minimal policy: two actions allowed, one destination allow-listed.
const policy = {
    allowedActions: ['SEND', 'EXECUTE'],
    allowedDestinations: ['bc1qgood'],
};

// Each scenario: an action + the verdict we expect the guardrail to reach.
const corpus = [
    { name: 'allowed action to allowed destination',
      data: { action: 'SEND', params: { tick: 'MYTOKEN', amount: '5', destination: 'bc1qgood' } },
      expectOk: true },
    { name: 'action not in allowedActions is denied',
      data: { action: 'ISSUE', params: { tick: 'MYTOKEN', amount: '5' } },
      expectOk: false, code: 'POLICY_ACTION_DENIED' },
    { name: 'destination not allow-listed is denied',
      data: { action: 'SEND', params: { tick: 'MYTOKEN', amount: '5', destination: 'bc1qEVIL' } },
      expectOk: false, code: 'POLICY_DESTINATION_DENIED' },
    { name: 'negative amount fails closed',
      data: { action: 'SEND', params: { tick: 'MYTOKEN', amount: '-1', destination: 'bc1qgood' } },
      expectOk: false, code: 'POLICY_AMOUNT_INVALID' },
];

// Fail-closed default: an empty allowedActions policy allows nothing.
const emptyPolicy = { allowedActions: [] };

describe('agentSession policy guardrail (llm-eval, scored)', function () {
    it('scores the guardrail verdicts and clears the pass-rate floor', function () {
        let passed = 0;
        const total = corpus.length + 1;

        for (const s of corpus) {
            const v = evaluatePolicy(policy, s.data, {});
            const ok = v.ok === s.expectOk && (s.expectOk || (v.violation && v.violation.code === s.code));
            if (ok) passed += 1;
        }

        // Fail-closed default scenario.
        const def = evaluatePolicy(emptyPolicy, { action: 'SEND', params: { amount: '1' } }, {});
        if (def.ok === false) passed += 1;

        const score = passed / total;
        // Scored eval: report and gate on a floor (this corpus is deterministic,
        // so the guardrail brain is expected to score 1.0).
        assert.ok(score >= 0.9, `guardrail eval score ${score.toFixed(2)} below floor 0.90`);
    });
});
