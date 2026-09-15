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
// Adversarial coverage for the co-signer hardening gaps G1, G2, G3 and G5.
// The pre-existing 142 tests exercise the happy path and the DESIGNED
// denials, which is exactly why an adversarial read found these behind a
// green suite. Every case below fails against the code as it stood before
// the gap was closed.

const {
    expect,
    fs,
    CoSigner,
    WindowStore,
    evaluatePolicy,
    decodeActionFromPsbt,
    makeAccount,
    buildSignablePsbt,
    agentNonce,
    tmpStateFile,
} = require('./cosigner_hardening.test/helpers/cosigner_hardening_helpers.js');


// G1: an attacker-chosen TICK must not poison the daemon.

describe('G1: decoded params are untrusted input', function () {

    it('a tick colliding with an Object.prototype member does not wedge the daemon forever', function () {
        // 'constructor' is a PERFECTLY LEGAL tick under the protocol charset
        // (pure alphanumerics), so charset validation cannot be what saves us
        // here - the null-prototype window map is. Before the fix: the first
        // request was approved and persisted, and every request after it died in
        // snapshot() feeding Object.prototype.constructor into decimal addition.
        // On a plain 2-of-2 that is a permanent, remotely-triggered freeze.
        const acct      = makeAccount();
        const stateFile = tmpStateFile('poison');
        const store     = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const co = new CoSigner({
                secretKey:   acct.coSk,
                publicKeys:  acct.keys,
                windowStore: store,
                // No per-tick cap for SEND, so the poisoned key is never consulted
                // during evaluation and the action is approved on its way in.
                policy: { allowedActions: new Set(['SEND']),
                          maxPerWindow: { hours: 24, maxActions: 10 } },
            });

            const first = co.process({
                psbt: buildSignablePsbt(acct, 'SEND|0|constructor|5|1destX|m').toHex(),
                inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
            });
            expect(first.approved).to.equal(true);

            // The poisoned entry is now persisted. A second, entirely ordinary
            // request must still be decidable.
            const second = co.process({
                psbt: buildSignablePsbt(acct, 'SEND|0|MYTOKEN|5|1destX|m').toHex(),
                inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
            });
            expect(second.approved).to.equal(true);

            // And the poisoned tick accumulated as an ordinary string key.
            expect(store.snapshot().perTick.constructor).to.equal('5');
            expect(store.quarantined()).to.have.length(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

describe('G1: decoded params are untrusted input', function () {

    it('refuses a tick the protocol could never mint (DECODE_PARAM_INVALID)', function () {
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });

        // Backslash is outside the canonical TICK charset, so no real token can
        // carry this name and it has no business reaching a policy lookup.
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|BAD\\TICK|5|1destX|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('DECODE_PARAM_INVALID');
    });

    it('accepts the compact ^<id> tick reference, which is legal wire form', function () {
        const psbt = buildSignablePsbt(makeAccount(), 'SEND|0|^4321|5|1destX|m');
        const decoded = decodeActionFromPsbt(psbt);
        expect(decoded.ok).to.equal(true);
        expect(decoded.params.TICK).to.equal('^4321');
    });

    it('a cap lookup never resolves to an inherited prototype member', function () {
        // policy.maxPerAction.SEND is a plain object; a tick of 'constructor'
        // must read as "no per-tick cap configured" and fall through to '*',
        // not as Object.prototype.constructor (truthy, and fatal in gtDecimal).
        const verdict = evaluatePolicy(
            { allowedActions: ['SEND'], maxPerAction: { SEND: { '*': '10' } } },
            { action: 'SEND', version: 0, params: { TICK: 'constructor', AMOUNT: '50' } },
        );
        expect(verdict.ok).to.equal(false);
        expect(verdict.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
        expect(verdict.violation.details.cap).to.equal('10');
    });
});

describe('G1: decoded params are untrusted input', function () {

    it('an unaccumulable legacy entry now fails the LOAD closed, not just quarantine', function () {
        // Superseded contract: this used to assert the store kept serving and merely
        // quarantined the row. Quarantining keeps it in `count` but drops its amount
        // from perTick, which LOOSENS the per-tick cap policyEvaluator enforces - the
        // one direction this file must never fail in. Refuse the file instead.
        const stateFile = tmpStateFile('legacy');
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: 'not-a-number' },
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        let store, err;
        try {
            store = new WindowStore(stateFile, 24, null, { onFault: () => {} });
        } catch (e) { err = e; }
        try {
            expect(err, 'the poisoned row must be refused').to.exist;
            expect(err.code).to.equal('WINDOW_STATE_CORRUPT');
            expect(err.message).to.match(/entry 0 has an unaddable amount/);
        } finally {
            if (store) store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(stateFile + '.lock'); } catch (e) { /* ignore */ }
        }
    });

    it('a row with a non-finite timestamp is refused (it would be pruned away silently)', function () {
        // _pruned filters on `e.t >= cutoff`; undefined >= n is false, so the row
        // vanishes from both count and perTick, handing back spent budget.
        const stateFile = tmpStateFile('nofinite-t');
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: '7' },
            { action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        let store, err;
        try {
            store = new WindowStore(stateFile, 24, null, { onFault: () => {} });
        } catch (e) { err = e; }
        try {
            expect(err).to.exist;
            expect(err.code).to.equal('WINDOW_STATE_CORRUPT');
            expect(err.message).to.match(/entry 1 has a non-finite timestamp/);
        } finally {
            if (store) store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(stateFile + '.lock'); } catch (e) { /* ignore */ }
        }
    });
});

describe('G1: decoded params are untrusted input', function () {

    it('a count-only row (no amount) is legitimate and still loads', function () {
        const stateFile = tmpStateFile('countonly');
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: Date.now(), action: 'SEND' },
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        const store = new WindowStore(stateFile, 24, null, { onFault: () => {} });
        try {
            const snap = store.snapshot();
            expect(snap.count).to.equal(2);
            expect(snap.perTick.TOK).to.equal('7');
            expect(store.quarantined()).to.have.length(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('a future-dated finite timestamp is still CLAMPED, never rejected', function () {
        // The clock guard deliberately keeps such a row (dropping it would loosen the
        // budget); the new row guard must not turn that clamp into a refusal.
        const stateFile = tmpStateFile('future-t');
        const future = Date.now() + 86400000;
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: future, action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, null, { onFault: (m) => faults.push(m) });
        try {
            const snap = store.snapshot();
            expect(snap.count).to.equal(1);
            expect(snap.perTick.TOK).to.equal('7');
            expect(faults.join(' ')).to.match(/clamped/);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});
