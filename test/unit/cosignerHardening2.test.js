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
// Adversarial coverage for the co-signer hardening gaps G6, G7, G8, G9, G16,
// G18, G19 and the wire collapse. Every case below fails against the code as
// it stood before its gap was closed.

const { expect } = require('chai');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
require('../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1 } = require('@noble/curves/secp256k1');
const MuSig2      = require('../../src/musig2.js');
const CoSigner    = require('../../src/cosigner/coSigner.js');
const WindowStore = require('../../src/cosigner/windowStore.js');
const { evaluatePolicy, UNRESOLVED_TICK_BUCKET } = require('../../src/cosigner/policyEvaluator.js');
const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');

function makeAccount() {
    const musig   = new MuSig2();
    const agentSk = crypto.randomBytes(32);
    const coSk    = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true);
    const coPk    = secp256k1.getPublicKey(coSk, true);
    const keys    = [agentPk, coPk];
    const bare    = musig.aggregateKeys(keys);
    const p2tr    = bitcoin.payments.p2tr({ pubkey: Buffer.from(bare.xOnlyPubkey) });
    return { musig, agentSk, coSk, agentPk, coPk, keys, p2trScript: p2tr.output };
}

function carrier(actionString, txidHex) {
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const tagged = Buffer.concat([Buffer.from('XCHN'), inner]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txidHex.substr(0, 16), txidHex.substr(16, 16));
    return Buffer.concat([cipher.update(tagged), cipher.final()]);
}

// A PSBT spending `acct`, carrying `actionString`. opts.foreignFirstInput puts a
// FOREIGN utxo at index 0 and the account's at index 1 (the G16 craft).
function buildSignablePsbt(acct, actionString, opts = {}) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const psbt = new bitcoin.Psbt();

    if (opts.foreignFirstInput) {
        // The obfuscation key is the FIRST input's txid, so the carrier must be
        // built from the foreign input's txid for the payload to decode at all.
        psbt.addInput({
            hash: prevHash, index: 0,
            witnessUtxo: { script: opts.foreignScript, value: 50000 },
        });
        const ourHash = crypto.randomBytes(32);
        psbt.addInput({
            hash: ourHash, index: 0,
            witnessUtxo: { script: acct.p2trScript, value: 100000 },
        });
    } else {
        psbt.addInput({
            hash: prevHash, index: 0,
            witnessUtxo: { script: acct.p2trScript, value: 100000 },
        });
    }
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [carrier(actionString, txid)] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: opts.changeValue ?? 90000 });
    for (const extra of opts.extraOutputs || []) psbt.addOutput(extra);
    return psbt;
}

function nonce(acct) {
    return new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
}

function one(acct, index = 0) {
    return [{ index, agentPublicNonce: nonce(acct) }];
}

function tmpStateFile(tag) {
    return path.join(os.tmpdir(), `cosigner2-${tag}-${crypto.randomBytes(6).toString('hex')}.json`);
}

// Wire collapse: one request shape, one response shape.

describe('wire collapse: a single request/response shape', function () {

    it('refuses the legacy single-input request shape', function () {
        // Two shapes meant two validation paths, so every gate in this file had to
        // be applied twice or silently miss one of them. The one-element inputs
        // array says exactly the same thing; CoSignerClient.sign() does the wrapping.
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|TOK|5|1destX|m').toHex(),
            agentPublicNonce: nonce(acct),
            inputIndex: 0,
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('NO_INPUTS_REQUESTED');
    });

    it('a single-input approval returns a one-element signatures array, not a bare sig', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|TOK|5|1destX|m').toHex(),
            inputs: one(acct),
        });
        expect(res.approved).to.equal(true);
        expect(res.signatures).to.have.length(1);
        expect(res.signatures[0].index).to.equal(0);
        expect(res.signatures[0].sig).to.be.a('string');
        // The legacy top-level body is gone.
        expect(res.sig).to.equal(undefined);
        expect(res.publicNonce).to.equal(undefined);
        expect(res.msg).to.equal(undefined);
    });
});

// G16: the action's protocol source must be an input we sign.

describe('G16: source gate', function () {

    it('denies a tx whose input 0 is foreign, even though our own input is signed', function () {
        // The chain attributes the action to the FIRST input's address. With input
        // 0 foreign, the daemon would decode, policy-check and permanently charge
        // ITS window for an action credited to someone else - and the window, which
        // doubles as the approval audit log, would record a spend this account
        // never made.
        const acct    = makeAccount();
        const foreign = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });
        const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|5|1destX|m',
            { foreignFirstInput: true, foreignScript: foreign.p2trScript });

        const res = co.process({ psbt: psbt.toHex(), inputs: one(acct, 1) });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('SOURCE_NOT_OUR_ACCOUNT');
    });

    it('denies when input 0 is ours but is not among the inputs being signed', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });
        // Two inputs, both ours; request signing of input 1 only.
        const prevHash = crypto.randomBytes(32);
        const txid = Buffer.from(prevHash).reverse().toString('hex');
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 60000 } });
        psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: acct.p2trScript, value: 60000 } });
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [carrier('SEND|0|TOK|5|1destX|m', txid)] }).output, value: 0 });
        psbt.addOutput({ script: acct.p2trScript, value: 110000 });

        const res = co.process({ psbt: psbt.toHex(), inputs: one(acct, 1) });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('SOURCE_NOT_OUR_ACCOUNT');
    });

    it('a source denial consumes no window budget', function () {
        const acct    = makeAccount();
        const foreign = makeAccount();
        const stateFile = tmpStateFile('source');
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys, windowStore: store,
                policy: { allowedActions: new Set(['SEND']), maxPerWindow: { hours: 24, maxActions: 5 } } });
            const psbt = buildSignablePsbt(acct, 'SEND|0|TOK|5|1destX|m',
                { foreignFirstInput: true, foreignScript: foreign.p2trScript });
            co.process({ psbt: psbt.toHex(), inputs: one(acct, 1) });
            expect(store.snapshot().count).to.equal(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('still approves the ordinary case where input 0 is the signed account input', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|TOK|5|1destX|m').toHex(),
            inputs: one(acct),
        });
        expect(res.approved).to.equal(true);
    });
});

// G18: BATCH is refused structurally.

describe('G18: BATCH refusal', function () {

    it('refuses a three-segment BATCH that the old segment-count heuristic let through', function () {
        // The heuristic refused BATCH only when segments.length > 3, resting on
        // "every real sub-action contains a '|'". A three-segment BATCH therefore
        // reached the evaluator with no amount, tick or destination, and was
        // completely uncapped whenever BATCH was in allowedActions.
        const acct = makeAccount();
        const psbt = buildSignablePsbt(acct, 'BATCH|0|SEND');
        const decoded = decodeActionFromPsbt(psbt);
        expect(decoded.ok).to.equal(false);
        expect(decoded.reason).to.equal('BATCH_UNSUPPORTED');
    });

    it('refuses BATCH even when it is explicitly allowed and carries an amount cap', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['BATCH']), maxPerAction: { SEND: { '*': '1' } } } });
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'BATCH|0|SEND').toHex(),
            inputs: one(acct),
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('DECODE_BATCH_UNSUPPORTED');
    });

    it('refuses a multi-segment BATCH too (no regression on the old path)', function () {
        const acct = makeAccount();
        const decoded = decodeActionFromPsbt(buildSignablePsbt(acct, 'BATCH|0|SEND|0|TOK|5|1destX|m'));
        expect(decoded.ok).to.equal(false);
        expect(decoded.reason).to.equal('BATCH_UNSUPPORTED');
    });
});

// G7: allowedOutputs shape and mandatory maxValue.

describe('G7: allowedOutputs must be standard payment scripts with a cap', function () {

    const base = (acct, allowedOutputs) => ({
        secretKey: acct.coSk, publicKeys: acct.keys,
        policy: { allowedActions: new Set(['SEND']) }, allowedOutputs,
    });

    it('rejects a bare-multisig allow-list entry (an alternate ACTION CARRIER)', function () {
        // This is the load-bearing one. The authoritative decoder reads bare 1-of-3
        // multisig as a data carrier; the co-signer never examines that shape. Today
        // such an output is refused only because it is not the OP_RETURN, not change
        // and not allow-listed - so allow-listing one would let a SECOND, ungated
        // action ride the same transaction that the chain would execute.
        const acct = makeAccount();
        const key = () => Buffer.concat([Buffer.from([0x02]), crypto.randomBytes(32)]);
        const multisig = bitcoin.script.compile([
            bitcoin.opcodes.OP_1, key(), key(), key(), bitcoin.opcodes.OP_3, bitcoin.opcodes.OP_CHECKMULTISIG,
        ]);
        expect(() => new CoSigner(base(acct, [{ script: multisig, maxValue: 1000 }])))
            .to.throw(/not a standard single-recipient payment script/);
    });

    it('rejects an OP_RETURN allow-list entry', function () {
        const acct = makeAccount();
        const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('data')]);
        expect(() => new CoSigner(base(acct, [{ script, maxValue: 1000 }])))
            .to.throw(/not a standard single-recipient payment script/);
    });

    it('rejects an entry with no maxValue (it would authorize unlimited value)', function () {
        const acct = makeAccount();
        expect(() => new CoSigner(base(acct, [{ script: acct.p2trScript }])))
            .to.throw(/needs a maxValue/);
    });

    it('accepts each of the five standard payment templates', function () {
        const acct = makeAccount();
        const h20 = crypto.randomBytes(20), h32 = crypto.randomBytes(32);
        const op = bitcoin.opcodes;
        const templates = {
            p2pkh:  bitcoin.script.compile([op.OP_DUP, op.OP_HASH160, h20, op.OP_EQUALVERIFY, op.OP_CHECKSIG]),
            p2sh:   bitcoin.script.compile([op.OP_HASH160, h20, op.OP_EQUAL]),
            p2wpkh: bitcoin.script.compile([op.OP_0, h20]),
            p2wsh:  bitcoin.script.compile([op.OP_0, h32]),
            p2tr:   bitcoin.script.compile([op.OP_1, h32]),
        };
        for (const [name, script] of Object.entries(templates))
            expect(() => new CoSigner(base(acct, [{ script, maxValue: 1000 }])), name).to.not.throw();
    });
});

// G8: a wildcard window cap must accumulate for unresolved ticks.

describe('G8: unresolved-tick window accumulation', function () {

    it('a repeated no-TICK action exhausts a wildcard window cap instead of resetting it', function () {
        // COLLECT v0 carries an AMOUNT but no TICK. Before the fix the store skipped
        // undefined-tick entries entirely, so the used total read '0' every time and
        // the projected total was always 0 + amount: a wildcard window cap bound each
        // TRANSACTION independently, forever. It was a per-transaction cap wearing a
        // window's name, and total outflow was bounded only by maxActions.
        const acct = makeAccount();
        const stateFile = tmpStateFile('g8');
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const co = new CoSigner({
                secretKey: acct.coSk, publicKeys: acct.keys, windowStore: store,
                policy: {
                    allowedActions: new Set(['COLLECT']),
                    maxPerWindow: { hours: 24, perTick: { '*': '10' } },
                },
            });
            const send = () => co.process({
                psbt: buildSignablePsbt(acct, 'COLLECT|0|6').toHex(),
                inputs: one(acct),
            });
            expect(send().approved, 'first 6 fits under the cap of 10').to.equal(true);
            const second = send();
            expect(second.approved, 'a second 6 would reach 12, over the 10 cap').to.equal(false);
            expect(second.reason).to.equal('POLICY_WINDOW_AMOUNT_EXCEEDED');

            // And it accumulated under the reserved bucket, which no real tick can be.
            expect(store.snapshot().perTick[UNRESOLVED_TICK_BUCKET]).to.equal('6');
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('the reserved bucket lies outside the protocol tick charset', function () {
        // '|' is the action-string field separator, so a tick containing one would
        // corrupt the wire format itself: no real token can ever collide.
        expect(UNRESOLVED_TICK_BUCKET).to.contain('|');
    });

    it('a resolved tick still accumulates under its own name', function () {
        const usage = { count: 1, perTick: { TOK: '6' } };
        const verdict = evaluatePolicy(
            { allowedActions: ['SEND'], maxPerWindow: { hours: 24, perTick: { '*': '10' } } },
            { action: 'SEND', version: 0, params: { TICK: 'TOK', AMOUNT: '6' } },
            usage,
        );
        expect(verdict.ok).to.equal(false);
        expect(verdict.violation.code).to.equal('POLICY_WINDOW_AMOUNT_EXCEEDED');
    });
});

// G9: allowedDestinations must not be a silent no-op.

describe('G9: allowedDestinations enforceability', function () {

    it('denies an action whose format carries no DESTINATION field', function () {
        // Only 6 of the 63 decodable formats carry DESTINATION. For every other one
        // the destination list was EMPTY and the membership loop was vacuously
        // satisfied, so every trade, dispenser, staking and escrow action sailed
        // through a setting the operator reads as "can only pay these addresses".
        const acct = makeAccount();
        const co = new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['DESTROY']), allowedDestinations: ['1allowedAddr'] },
        });
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'DESTROY|0|TOK|5|m').toHex(),
            inputs: one(acct),
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_DESTINATION_UNENFORCEABLE');
    });

    it('still enforces the list for a format that does carry DESTINATION', function () {
        const acct = makeAccount();
        const co = new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']), allowedDestinations: ['1allowedAddr'] },
        });
        expect(co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|TOK|5|1allowedAddr|m').toHex(),
            inputs: one(acct),
        }).approved).to.equal(true);

        const denied = co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|TOK|5|1otherAddr|m').toHex(),
            inputs: one(acct),
        });
        expect(denied.approved).to.equal(false);
        expect(denied.reason).to.equal('POLICY_DESTINATION_DENIED');
    });

    it('leaves a policy with no destination list alone', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['DESTROY']) } });
        expect(co.process({
            psbt: buildSignablePsbt(acct, 'DESTROY|0|TOK|5|m').toHex(),
            inputs: one(acct),
        }).approved).to.equal(true);
    });
});

// G6: the window file's absence is not an empty window.

describe('G6: window-store durability', function () {

    it('refuses to start against a deleted state file', function () {
        // Deleting one file WAS exactly the reset this spec elsewhere calls
        // impossible: no corruption, no warning, full budget restored.
        const stateFile = tmpStateFile('g6-missing');
        const first = new WindowStore(stateFile, 24, null, { init: true });
        first.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        first.release();
        fs.unlinkSync(stateFile);

        let err = null;
        try { new WindowStore(stateFile, 24); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('WINDOW_STATE_MISSING');
    });

    it('a refused start releases its lock, so the operator can retry after restoring', function () {
        const stateFile = tmpStateFile('g6-lock');
        try { new WindowStore(stateFile, 24); } catch (e) { /* expected */ }
        // The lock must not be left behind by the failed construction.
        expect(fs.existsSync(stateFile + '.lock')).to.equal(false);
        const store = new WindowStore(stateFile, 24, null, { init: true });
        store.release();
        try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
    });

    it('creates the file 0600 on an explicit init', function () {
        const stateFile = tmpStateFile('g6-mode');
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const mode = fs.statSync(stateFile).mode & 0o777;
            expect(mode).to.equal(0o600);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('an init on an existing window does not wipe it', function () {
        const stateFile = tmpStateFile('g6-existing');
        const first = new WindowStore(stateFile, 24, null, { init: true });
        first.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        first.release();
        const second = new WindowStore(stateFile, 24, null, { init: true });
        try {
            expect(second.snapshot().perTick.TOK).to.equal('5');
        } finally {
            second.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

// G19: the rolling window trusts the wall clock.

describe('G19: clock guards', function () {

    it('clamps a future-dated entry instead of letting it outlive the window', function () {
        const stateFile = tmpStateFile('g19-future');
        const now = 1_800_000_000_000;
        fs.writeFileSync(stateFile, JSON.stringify({
            entries: [{ t: now + 90 * 24 * 3600 * 1000, action: 'SEND', tick: 'TOK', amount: '5' }],
            lastSeen: now,
        }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, () => now, { onFault: (m) => faults.push(m) });
        try {
            // Clamped to now, so it still counts against the window (tightening,
            // never loosening) and will age out on schedule.
            expect(store.snapshot().perTick.TOK).to.equal('5');
            expect(faults.join(' ')).to.match(/future/);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('warns when the clock moved backward across a restart', function () {
        const stateFile = tmpStateFile('g19-back');
        const now = 1_800_000_000_000;
        fs.writeFileSync(stateFile, JSON.stringify({
            entries: [], lastSeen: now + 3600 * 1000,
        }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, () => now, { onFault: (m) => faults.push(m) });
        try {
            expect(faults.join(' ')).to.match(/moved BACKWARD/);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('records lastSeen so the next start can detect the step', function () {
        const stateFile = tmpStateFile('g19-lastseen');
        const now = 1_800_000_000_000;
        const store = new WindowStore(stateFile, 24, () => now, { init: true });
        store.record({ action: 'SEND', tick: 'TOK', amount: '1' });
        store.release();
        const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(persisted.lastSeen).to.equal(now);
        try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
    });

    it('tolerates ordinary jitter without crying wolf', function () {
        const stateFile = tmpStateFile('g19-jitter');
        const now = 1_800_000_000_000;
        fs.writeFileSync(stateFile, JSON.stringify({
            entries: [{ t: now + 5_000, action: 'SEND', tick: 'TOK', amount: '5' }],
            lastSeen: now + 5_000,
        }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, () => now, { onFault: (m) => faults.push(m) });
        try {
            expect(faults).to.have.length(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});
