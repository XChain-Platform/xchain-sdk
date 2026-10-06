// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Tick case folding in the spending policy. Consensus looks a tick up by
// LOWER(tick), so TOK, tok and Tok debit one token; every tick-keyed limit must
// bind all three spellings or an agent re-cases the tick to escape its cap.

const {
    expect, fs, CoSigner, WindowStore, evaluatePolicy,
    makeAccount, buildSignablePsbt, agentNonce, tmpStateFile,
} = require('../cosigner_hardening.test/helpers/cosigner_hardening_helpers.js');
const { foldTick, UNRESOLVED_TICK_BUCKET } =
    require('../../../../src/cosigner/policy_evaluator/value_resolution.js');

const send = (tick, amount) => ({ action: 'SEND', version: 0, params: { TICK: tick, AMOUNT: amount, DESTINATION: 'x' } });

describe('policyEvaluator tick case folding', function () {

    it('folds ASCII letters only, matching the ASCII consensus tick charset', function () {
        expect(foldTick('tOk.a~b')).to.equal('TOK.A~B');
        expect(foldTick('^123')).to.equal('^123');
    });

    it('binds a named per-action cap to every case spelling of the tick', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '100' } } };
        for (const tick of ['TOK', 'tok', 'Tok', 'tOK']) {
            const v = evaluatePolicy(policy, send(tick, '1000000'));
            expect(v.ok, tick).to.equal(false);
            expect(v.violation.code, tick).to.equal('POLICY_AMOUNT_EXCEEDED');
        }
        expect(evaluatePolicy(policy, send('tok', '100')).ok).to.equal(true);
    });

    it('prefers the named cap over the wildcard for a re-cased tick', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '10', '*': '1000' } } };
        const v = evaluatePolicy(policy, send('tok', '500'));
        expect(v.ok).to.equal(false);
        expect(v.violation.details.cap).to.equal('10');
    });

    it('binds a lowercase policy key to an uppercase decoded tick', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { tok: '100' } } };
        expect(evaluatePolicy(policy, send('TOK', '1000')).violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('binds the named cap on a GIVE_TICK leg written in another case', function () {
        const policy = { allowedActions: new Set(['ORDER']), maxPerAction: { ORDER: { TOK: '100' } } };
        const v = evaluatePolicy(policy, { action: 'ORDER', params: { GIVE_TICK: 'tok', GIVE_AMOUNT: '1000' } });
        expect(v.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('binds a ^id reference declared under a lowercase tickIds name to the uppercase cap', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '100' } }, tickIds: { tok: 123 } };
        expect(evaluatePolicy(policy, send('^123', '1000')).violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });
});

describe('policyEvaluator tick case folding: windows, confirmations, collisions', function () {

    it('totals window spend across every case spelling it was recorded under', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, perTick: { TOK: '100' } } };
        const usage = { count: 2, perTick: { TOK: '60', tok: '30' } };
        const v = evaluatePolicy(policy, send('Tok', '20'), usage);
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_WINDOW_AMOUNT_EXCEEDED');
        expect(v.violation.details.windowTotal).to.equal('90');
        expect(evaluatePolicy(policy, send('Tok', '10'), usage).ok).to.equal(true);
        // The snapshot is read, never rewritten.
        expect(usage.perTick).to.deep.equal({ TOK: '60', tok: '30' });
    });

    it('keeps the reserved unresolved bucket out of a real tick total', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, perTick: { '*': '100' } } };
        const usage = { count: 1, perTick: { [UNRESOLVED_TICK_BUCKET]: '95' } };
        expect(evaluatePolicy(policy, send('tok', '50'), usage).ok).to.equal(true);
        const amountOnly = { action: 'COLLECT', params: { AMOUNT: '6' } };
        const noTick = { allowedActions: new Set(['COLLECT']), maxPerWindow: policy.maxPerWindow };
        expect(evaluatePolicy(noTick, amountOnly, usage).violation.code).to.equal('POLICY_WINDOW_AMOUNT_EXCEEDED');
    });

    it('flags a re-cased tick for confirmation under a named threshold', function () {
        const policy = { allowedActions: new Set(['SEND']), confirmAbove: { perTick: { TOK: '50' } } };
        expect(evaluatePolicy(policy, send('tok', '60')).evaluation.needsConfirmation).to.equal(true);
    });

    it('refuses a tick two policy keys name in different case, and only that tick', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '100', tok: '500' } } };
        const v = evaluatePolicy(policy, send('tOk', '1'));
        expect(v.ok).to.equal(false);
        expect(v.violation.code).to.equal('POLICY_TICK_CASE_COLLISION');
        expect(v.violation.details.keys).to.have.members(['TOK', 'tok']);
        expect(evaluatePolicy(policy, send('ABC', '1')).ok).to.equal(true);
    });

    it('still resolves inherited names such as constructor to no cap', function () {
        const policy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '1' } } };
        for (const tick of ['constructor', 'toString', '__proto__'])
            expect(evaluatePolicy(policy, send(tick, '5')).ok, tick).to.equal(true);
    });
});

describe('co-signer daemon tick case folding', function () {

    it('withholds a signature for a re-cased SEND over the named cap and window', function () {
        const acct = makeAccount();
        const stateFile = tmpStateFile('tickcase');
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const co = new CoSigner({
                secretKey: acct.coSk, publicKeys: acct.keys, windowStore: store,
                policy: {
                    allowedActions: new Set(['SEND']),
                    maxPerAction:   { SEND: { TOK: '100' } },
                    maxPerWindow:   { hours: 24, perTick: { TOK: '150' } },
                },
            });
            const sign = (tick, amount) => co.process({
                psbt:   buildSignablePsbt(acct, `SEND|0|${tick}|${amount}|1destX|m`).toHex(),
                inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
            });
            const over = sign('tok', '1000000');
            expect(over.approved).to.equal(false);
            expect(over.reason).to.equal('POLICY_AMOUNT_EXCEEDED');

            expect(sign('TOK', '80').approved, 'first 80 fits the 150 window').to.equal(true);
            const second = sign('tOk', '80');
            expect(second.approved, 'a re-cased second 80 reaches 160').to.equal(false);
            expect(second.reason).to.equal('POLICY_WINDOW_AMOUNT_EXCEEDED');
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});
