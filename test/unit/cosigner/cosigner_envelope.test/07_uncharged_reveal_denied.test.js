// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    expect, crypto, bitcoin, WindowStore, makeAccount, commitFor,
    buildCommitPsbt, buildRevealPsbt, buildCancelPsbt, makeCoSigner, runRound,
} = require('./helpers/support.js');

const os = require('os');
const path = require('path');

function freshStore() {
    const file = path.join(os.tmpdir(), `xchain-window-${crypto.randomBytes(8).toString('hex')}.json`);
    return new WindowStore(file, 24, null, { init: true });
}

function transactionHash(psbt) {
    const tx = new bitcoin.Transaction();
    tx.version = psbt.version;
    tx.locktime = psbt.locktime;
    for (const input of psbt.txInputs) tx.addInput(input.hash, input.index, input.sequence);
    for (const output of psbt.txOutputs) tx.addOutput(output.script, output.value);
    return Buffer.from(tx.getId(), 'hex').reverse();
}

describe('co-signer: uncharged envelope reveal budget', function () {
    it('refuses an uncharged reveal even when the window has spare capacity', async function () {
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const store = freshStore();
        try {
            const co = makeCoSigner(acct, {
                windowStore: store,
                policy: { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 1 } },
            });
            for (let i = 0; i < 3; i++) {
                let denied = null;
                try {
                    await runRound(acct, co, buildRevealPsbt(acct, commit), script);
                } catch (e) { denied = e; }
                expect(denied).to.not.equal(null);
                expect(String(denied.message)).to.match(/ENVELOPE_COMMIT_NOT_AUTHORIZED/);
            }
            expect(store.snapshot().count).to.equal(0);
        } finally {
            store.release();
        }
    });

    it('allows retries for a reveal whose commit still has one live charge', async function () {
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const store = freshStore();
        try {
            const co = makeCoSigner(acct, {
                windowStore: store,
                policy: { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 1 } },
            });
            const commitPsbt = buildCommitPsbt(acct, commit);
            const reveal = buildRevealPsbt(acct, commit, { hash: transactionHash(commitPsbt) });

            await runRound(acct, co, commitPsbt, script);
            await runRound(acct, co, reveal, script);
            await runRound(acct, co, reveal, script);
            expect(store.snapshot().count).to.equal(1);
        } finally {
            store.release();
        }
    });

    it('keeps an uncharged cancel available as a recovery path', async function () {
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const store = freshStore();
        try {
            const co = makeCoSigner(acct, {
                windowStore: store,
                policy: { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 1 } },
            });

            await runRound(acct, co, buildCancelPsbt(acct, commit), script);
            expect(store.snapshot().count).to.equal(0);
        } finally {
            store.release();
        }
    });
});
