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

const {
    expect, crypto, bitcoin, secp256k1, schnorr, MuSig2, CoSigner,
    CoSignerClient, WindowStore, parseEnvelopeScript, deriveEnvelopeCommit,
    envelopeLeafHash, envelopeScriptPathSighash, classifyEnvelopeRole,
    envelopeRoundTweaks, buildRecoverySpend, localPairSigner,
    decodeEnvelopeAction, LEAF_VERSION, ACTION, makeAccount,
    buildEnvelopeScript, commitFor, buildCommitPsbt, buildRevealPsbt,
    buildCancelPsbt, makeCoSigner, runRound, make2of3, client3,
    envelopeFor3, commitPsbt3, revealPsbt3, cancelPsbt3,
    outputKeyFromControlBlock,
} = require('./helpers/support.js');

const fs = require('fs');
const os = require('os');
const path = require('path');

function freshStore() {
    const p = path.join(os.tmpdir(), `xc990-window-${crypto.randomBytes(6).toString('hex')}.json`);
    const store = new WindowStore(p, 24, null, { init: true });
    return { store, p };
}

describe('co-signer: Taproot envelope composition', function () {

    describe('budget: one action, two transactions, one charge', function () {
        it('charges the commit and neither the reveal nor the cancel', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const { store, p } = freshStore();
            try {
                const co = makeCoSigner(acct, {
                    windowStore: store,
                    policy: { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 5 } },
                });
                expect(store.snapshot().count).to.equal(0);

                await runRound(acct, co, buildCommitPsbt(acct, commit), script);
                expect(store.snapshot().count).to.equal(1);

                await runRound(acct, co, buildRevealPsbt(acct, commit), script);
                expect(store.snapshot().count).to.equal(1);

                await runRound(acct, co, buildCancelPsbt(acct, commit), script);
                expect(store.snapshot().count).to.equal(1);
            } finally {
                store.release();
                try { fs.unlinkSync(p); } catch (e) { /* best effort */ }
            }
        });
    });
});

describe('co-signer: Taproot envelope composition', function () {

    describe('budget: one action, two transactions, one charge', function () {
        // The charge lands at the commit, but the reveal was still EVALUATED
        // against the full window, so the evaluator projected a second expenditure
        // for an action already paid for. At maxActions:1 that denied the reveal of
        // a commit the same daemon had just authorized and broadcast, stranding it
        // until the window expired or the agent paid to cancel.
        it('lets a commit that filled the window still reveal', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const { store, p } = freshStore();
            try {
                const co = makeCoSigner(acct, {
                    windowStore: store,
                    policy: { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 1 } },
                });

                // The reveal must spend the COMMIT's own outpoint, as it does on
                // chain: that link is what the window store is asked about.
                const commitPsbt = buildCommitPsbt(acct, commit);
                const ctx = new bitcoin.Transaction();
                ctx.version  = commitPsbt.version;
                ctx.locktime = commitPsbt.locktime;
                for (const ti of commitPsbt.txInputs)  ctx.addInput(ti.hash, ti.index, ti.sequence);
                for (const to of commitPsbt.txOutputs) ctx.addOutput(to.script, to.value);
                const commitHash = Buffer.from(ctx.getId(), 'hex').reverse();

                await runRound(acct, co, commitPsbt, script);
                expect(store.snapshot().count).to.equal(1);

                // Resolves rather than throwing SDKPolicyError: the reveal is judged
                // on the usage its own commit was judged on.
                await runRound(acct, co, buildRevealPsbt(acct, commit, { hash: commitHash }), script);
                // Still one charge: the reveal is not granted an extra slot either.
                expect(store.snapshot().count).to.equal(1);
            } finally {
                store.release();
                try { fs.unlinkSync(p); } catch (e) { /* best effort */ }
            }
        });
    });
});

describe('co-signer: Taproot envelope composition', function () {

    describe('budget: one action, two transactions, one charge', function () {
        // The exemption is evidence-bound: it applies only where this store holds a
        // live entry for the commit outpoint the reveal spends. A window filled by
        // some OTHER action must still deny the reveal, or the reveal role would be
        // a way to sign one action past every window cap.
        it('still denies a reveal when the window was filled by another action', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const { store, p } = freshStore();
            try {
                const co = makeCoSigner(acct, {
                    windowStore: store,
                    policy: { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 1 } },
                });
                // An unrelated charge: same window, a txid no reveal here spends.
                store.record({ action: 'FILE', tick: undefined, amount: undefined, txid: 'ff'.repeat(32) });
                expect(store.snapshot().count).to.equal(1);

                let denied = null;
                try {
                    await runRound(acct, co, buildRevealPsbt(acct, commit), script);
                } catch (e) { denied = e; }
                expect(denied, 'the reveal must still be refused').to.not.equal(null);
                expect(String(denied.message)).to.match(/POLICY_WINDOW_COUNT_EXCEEDED/);
            } finally {
                store.release();
                try { fs.unlinkSync(p); } catch (e) { /* best effort */ }
            }
        });
    });
});
