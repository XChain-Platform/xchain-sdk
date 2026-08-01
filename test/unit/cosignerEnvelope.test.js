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
//  §3.9: MuSig2 co-signer composition with the Taproot envelope. Three
// deltas, all exercised here against real Schnorr verification rather than
// against the daemon's own say-so:
//   (a) tap-tweaked key path for the cancel of a tree-committed output,
//   (b) BIP342 script-path sighash over the envelope leaf for the reveal,
//   (c) the action decoded from the leaf script instead of an OP_RETURN.

const { expect } = require('chai');
const crypto  = require('crypto');
require('../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2   = require('../../src/musig2.js');
const CoSigner = require('../../src/cosigner/coSigner.js');
const CoSignerClient = require('../../src/cosigner/client.js');
const WindowStore = require('../../src/cosigner/windowStore.js');
const {
    parseEnvelopeScript, deriveEnvelopeCommit, envelopeLeafHash,
    envelopeScriptPathSighash, classifyEnvelopeRole,
} = require('../../src/cosigner/envelope.js');
const { decodeEnvelopeAction } = require('../../src/cosigner/psbtActionDecode.js');

bitcoin.initEccLib(ecc);

const LEAF_VERSION = 0xc0;
const ACTION = 'FILE|0|report.bin|application/octet-stream|||||||';

function makeAccount() {
    const musig = new MuSig2();
    const agentSk = crypto.randomBytes(32);
    const coSk    = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true);
    const coPk    = secp256k1.getPublicKey(coSk, true);
    const keys = [agentPk, coPk];
    const bare = musig.aggregateKeys(keys);
    const aggKey = Buffer.from(bare.xOnlyPubkey);
    return {
        musig, agentSk, coSk, agentPk, coPk, keys, aggKey,
        p2trScript: bitcoin.payments.p2tr({ pubkey: aggKey }).output,
    };
}

// The §3.2 grammar, built here rather than imported from the encoder so this
// suite stands alone; the live regtest run proves the real encoder's script
// parses through the same code.
function buildEnvelopeScript(internalXOnly, actionString, rawData, opts = {}) {
    const payload = bitcoin.script.compile(
        rawData === null ? [Buffer.from(actionString, 'utf8')]
                         : [Buffer.from(actionString, 'utf8'), rawData]);
    const pushes = [];
    for (let i = 0; i < payload.length; i += 520) pushes.push(payload.subarray(i, i + 520));
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_FALSE,
        bitcoin.opcodes.OP_IF,
        Buffer.from(opts.magic || 'XCHN', 'utf8'),
        Buffer.from([opts.formatByte === undefined ? 0x00 : opts.formatByte]),
        ...pushes,
        bitcoin.opcodes.OP_ENDIF,
        opts.checksigKey || internalXOnly,
        bitcoin.opcodes.OP_CHECKSIG,
    ]);
}

function commitFor(acct, opts = {}) {
    const script = buildEnvelopeScript(acct.aggKey, ACTION, crypto.randomBytes(1200), opts);
    return { script, commit: deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script }) };
}

// Commit tx: spends ordinary account UTXOs, creates the commit output.
function buildCommitPsbt(acct, commit, opts = {}) {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({
        hash: crypto.randomBytes(32), index: 0,
        witnessUtxo: { script: acct.p2trScript, value: 100000 },
    });
    psbt.addOutput({ script: commit.output, value: opts.commitValue === undefined ? 20000 : opts.commitValue });
    if (opts.secondCommitOutput) psbt.addOutput({ script: commit.output, value: 20000 });
    psbt.addOutput({ script: acct.p2trScript, value: 70000 });
    return psbt;
}

// Reveal tx: input 0 spends the commit output through the envelope leaf.
function buildRevealPsbt(acct, commit, opts = {}) {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({
        hash: opts.hash || crypto.randomBytes(32), index: 0,
        witnessUtxo: { script: commit.output, value: 20000 },
        tapInternalKey: acct.aggKey,
        tapLeafScript: [{ leafVersion: LEAF_VERSION, script: commit.script, controlBlock: commit.controlBlock }],
    });
    psbt.addOutput({ script: opts.outputScript || acct.p2trScript, value: 15000 });
    return psbt;
}

// Cancel tx: input 0 spends the same output through the KEY path (no leaf).
function buildCancelPsbt(acct, commit) {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({
        hash: crypto.randomBytes(32), index: 0,
        witnessUtxo: { script: commit.output, value: 20000 },
        tapInternalKey: acct.aggKey,
        tapMerkleRoot: commit.merkleRoot,
    });
    psbt.addOutput({ script: acct.p2trScript, value: 15000 });
    return psbt;
}

function makeCoSigner(acct, extra = {}) {
    return new CoSigner(Object.assign({
        secretKey: acct.coSk, publicKeys: acct.keys, tweaks: [],
        policy: { allowedActions: new Set(['FILE']) },
        maxFeeSats: 50000,
    }, extra));
}

// One full round, agent + daemon, returning the aggregated 64-byte signature.
function runRound(acct, co, psbt, envelopeScript, inputIndex = 0) {
    const client = new CoSignerClient({
        transport: CoSignerClient.inProcessTransport(co),
        publicKeys: acct.keys, tweaks: [],
    });
    return client.sign({
        psbt: psbt.toHex(), secretKey: acct.agentSk, inputIndex,
        envelopeScript: envelopeScript ? envelopeScript.toString('hex') : undefined,
    });
}

describe(' co-signer: Taproot envelope composition', function () {

    describe('grammar mirror (strict subset of the authoritative decoder)', function () {
        it('parses a well-formed envelope and recovers the exact payload', function () {
            const acct = makeAccount();
            const raw = crypto.randomBytes(900);
            const script = buildEnvelopeScript(acct.aggKey, ACTION, raw);
            const parsed = parseEnvelopeScript(script);
            expect(parsed).to.not.equal(null);
            expect(parsed.checksigKey.equals(acct.aggKey)).to.equal(true);
            const expected = bitcoin.script.compile([Buffer.from(ACTION, 'utf8'), raw]);
            expect(parsed.payload.equals(expected)).to.equal(true);
        });

        it('refuses a wrong magic, an unknown format byte, and a non-32-byte key', function () {
            const acct = makeAccount();
            expect(parseEnvelopeScript(buildEnvelopeScript(acct.aggKey, ACTION, null, { magic: 'XCHX' }))).to.equal(null);
            expect(parseEnvelopeScript(buildEnvelopeScript(acct.aggKey, ACTION, null, { formatByte: 0x01 }))).to.equal(null);
            expect(parseEnvelopeScript(buildEnvelopeScript(acct.aggKey, ACTION, null,
                { checksigKey: crypto.randomBytes(31) }))).to.equal(null);
        });

        it('refuses trailing junk after OP_CHECKSIG', function () {
            const acct = makeAccount();
            const good = buildEnvelopeScript(acct.aggKey, ACTION, null);
            const junked = Buffer.concat([good, Buffer.from([bitcoin.opcodes.OP_NOP])]);
            expect(parseEnvelopeScript(junked)).to.equal(null);
        });

        it('never throws on fuzzed bytes', function () {
            for (let i = 0; i < 300; i++) {
                const len = 1 + (i % 90);
                expect(parseEnvelopeScript(crypto.randomBytes(len))).to.equal(null);
            }
            expect(parseEnvelopeScript(null)).to.equal(null);
            expect(parseEnvelopeScript('not a buffer')).to.equal(null);
        });

        it('the standalone leaf hash equals bitcoinjs\'s own merkle root for the single-leaf tree', function () {
            const acct = makeAccount();
            // Both a small script and one past the 65,535-byte compact-size
            // boundary, where a 3-byte prefix would silently corrupt the hash.
            for (const rawLen of [100, 70000]) {
                const script = buildEnvelopeScript(acct.aggKey, ACTION, crypto.randomBytes(rawLen));
                const commit = deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script });
                expect(envelopeLeafHash(script).equals(commit.leafHash)).to.equal(true);
            }
        });

        it('refuses a leaf whose OP_CHECKSIG key is not this account aggregate', function () {
            const acct = makeAccount();
            const foreign = makeAccount();
            const script = buildEnvelopeScript(foreign.aggKey, ACTION, null);
            expect(() => deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script }))
                .to.throw(/different key/);
        });
    });

    describe('delta (c): the action is read from the leaf', function () {
        it('decodes the action a commit output commits to, with no transaction in hand', function () {
            const acct = makeAccount();
            const { script } = commitFor(acct);
            const decoded = decodeEnvelopeAction(script);
            expect(decoded.ok).to.equal(true);
            expect(decoded.action).to.equal('FILE');
            expect(decoded.version).to.equal(0);
            expect(decoded.params.NAME).to.equal('report.bin');
        });

        it('decodes a reveal PSBT through the ordinary decodeActionFromPsbt entry point', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const psbt = buildRevealPsbt(acct, commit);
            const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');
            const decoded = decodeActionFromPsbt(psbt);
            expect(decoded.ok).to.equal(true);
            expect(decoded.action).to.equal('FILE');
            expect(decoded.actionString).to.equal(ACTION);
            void script;
        });

        it('refuses an envelope mixed with an OP_RETURN carrier (no action on chain)', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const psbt = buildRevealPsbt(acct, commit);
            psbt.addOutput({ script: bitcoin.payments.embed({ data: [Buffer.from('XCHNjunk')] }).output, value: 0 });
            const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');
            const decoded = decodeActionFromPsbt(psbt);
            expect(decoded.ok).to.equal(false);
            expect(decoded.reason).to.equal('ENVELOPE_MIXED_CARRIER');
        });

        it('refuses an envelope that is not input 0, and two envelope inputs', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');

            const notZero = new bitcoin.Psbt();
            notZero.addInput({ hash: crypto.randomBytes(32), index: 0,
                witnessUtxo: { script: acct.p2trScript, value: 5000 } });
            notZero.addInput({ hash: crypto.randomBytes(32), index: 0,
                witnessUtxo: { script: commit.output, value: 20000 },
                tapInternalKey: acct.aggKey,
                tapLeafScript: [{ leafVersion: LEAF_VERSION, script: commit.script, controlBlock: commit.controlBlock }] });
            notZero.addOutput({ script: acct.p2trScript, value: 20000 });
            expect(decodeActionFromPsbt(notZero).reason).to.equal('ENVELOPE_NOT_INPUT_ZERO');

            const two = buildRevealPsbt(acct, commit);
            two.addInput({ hash: crypto.randomBytes(32), index: 1,
                witnessUtxo: { script: commit.output, value: 20000 },
                tapInternalKey: acct.aggKey,
                tapLeafScript: [{ leafVersion: LEAF_VERSION, script: commit.script, controlBlock: commit.controlBlock }] });
            expect(decodeActionFromPsbt(two).reason).to.equal('MULTI_ENVELOPE');
        });
    });

    describe('role derivation', function () {
        it('classifies commit, reveal and cancel from the PSBT alone', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            expect(classifyEnvelopeRole(buildCommitPsbt(acct, commit), commit)).to.equal('commit');
            expect(classifyEnvelopeRole(buildRevealPsbt(acct, commit), commit)).to.equal('reveal');
            expect(classifyEnvelopeRole(buildCancelPsbt(acct, commit), commit)).to.equal('cancel');
        });

        it('classifies nothing for a transaction that neither funds nor spends the commit', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const unrelated = new bitcoin.Psbt();
            unrelated.addInput({ hash: crypto.randomBytes(32), index: 0,
                witnessUtxo: { script: acct.p2trScript, value: 100000 } });
            unrelated.addOutput({ script: acct.p2trScript, value: 90000 });
            expect(classifyEnvelopeRole(unrelated, commit)).to.equal(null);
        });
    });

    describe('delta (b): the reveal signs the leaf', function () {
        it('produces a signature that verifies under the leaf key over the BIP342 sighash', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildRevealPsbt(acct, commit);

            const res = await runRound(acct, co, psbt, script);
            const msg = envelopeScriptPathSighash(psbt, 0, undefined, commit.leafHash);
            expect(Buffer.from(res.msg).equals(msg)).to.equal(true);
            // The leaf's OP_CHECKSIG key is the BARE aggregate: no tweak.
            expect(schnorr.verify(res.signature, msg, acct.aggKey)).to.equal(true);
        });

        it('is NOT a key-path signature (the two messages differ)', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const psbt = buildRevealPsbt(acct, commit);
            const scriptPath = envelopeScriptPathSighash(psbt, 0, undefined, commit.leafHash);
            const tx = new bitcoin.Transaction();
            tx.version = psbt.version; tx.locktime = psbt.locktime;
            for (const ti of psbt.txInputs) tx.addInput(ti.hash, ti.index, ti.sequence);
            for (const to of psbt.txOutputs) tx.addOutput(to.script, to.value);
            const keyPath = tx.hashForWitnessV1(0, [commit.output], [20000], bitcoin.Transaction.SIGHASH_DEFAULT);
            expect(scriptPath.equals(keyPath)).to.equal(false);
        });
    });

    describe('delta (a): the cancel signs the tweaked key path', function () {
        it('produces a signature that verifies under the TWEAKED output key', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildCancelPsbt(acct, commit);

            const res = await runRound(acct, co, psbt, script);
            // The output key is what a key-path spend of the commit verifies
            // under, and it commits to the envelope leaf.
            expect(schnorr.verify(res.signature, res.msg, commit.outputXOnly)).to.equal(true);
            // ... and NOT under the untweaked aggregate, which is the whole point.
            expect(schnorr.verify(res.signature, res.msg, acct.aggKey)).to.equal(false);
        });

        it('derives the tweak rather than accepting one (G3 stays closed)', function () {
            const acct = makeAccount();
            expect(() => new CoSigner({
                secretKey: acct.coSk, publicKeys: acct.keys,
                tweaks: [{ tweak: crypto.randomBytes(32), xOnly: true }],
                policy: { allowedActions: new Set(['FILE']) },
            })).to.throw();
        });
    });

    describe('the commit round', function () {
        it('approves a commit, decoding the action from the script it commits to', async function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildCommitPsbt(acct, commit);
            const res = await runRound(acct, co, psbt, script);
            expect(schnorr.verify(res.signature, res.msg, acct.aggKey)).to.equal(true);
            expect(res.action).to.equal('FILE');
        });

        it('refuses a commit output above maxFeeSats', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct, { maxFeeSats: 5000 });
            const psbt = buildCommitPsbt(acct, commit, { commitValue: 20000 });
            const out = co.process({
                psbt: psbt.toHex(), envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('OUTPUT_OVER_CAP');
        });

        it('refuses a commit at all when maxFeeSats is unset (the prefunding would be unbounded)', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = new CoSigner({
                secretKey: acct.coSk, publicKeys: acct.keys, tweaks: [],
                policy: { allowedActions: new Set(['FILE']) },
            });
            const psbt = buildCommitPsbt(acct, commit);
            const out = co.process({
                psbt: psbt.toHex(), envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('ENVELOPE_COMMIT_UNBOUNDED');
        });

        it('refuses a second commit output (a second, ungated envelope on one tx)', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const psbt = buildCommitPsbt(acct, commit, { secondCommitOutput: true });
            const out = co.process({
                psbt: psbt.toHex(), envelope: { script: script.toString('hex') },
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('UNAUTHORIZED_OUTPUT');
        });
    });

    describe('refusals that keep the shipped guarantees', function () {
        function request(acct, co, psbt, scriptHex) {
            return co.process({
                psbt: psbt.toHex(),
                envelope: scriptHex ? { script: scriptHex } : undefined,
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
        }

        it('refuses an envelope script that is not the §3.2 grammar', function () {
            const acct = makeAccount();
            const { commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const out = request(acct, co, buildCommitPsbt(acct, commit), crypto.randomBytes(40).toString('hex'));
            expect(out.reason).to.equal('ENVELOPE_SCRIPT_INVALID');
        });

        it('refuses an envelope the transaction neither funds nor spends', function () {
            const acct = makeAccount();
            const { script } = commitFor(acct);
            const other = commitFor(acct);
            const co = makeCoSigner(acct);
            // A PSBT funding a DIFFERENT envelope than the script declares.
            const out = request(acct, co, buildCommitPsbt(acct, other.commit), script.toString('hex'));
            expect(out.reason).to.equal('ENVELOPE_NOT_COMMITTED');
        });

        it('refuses envelope work on a 2-of-3 account rather than improvising a tap tree', function () {
            const acct = makeAccount();
            const recovery = secp256k1.getPublicKey(crypto.randomBytes(32), true);
            const co = new CoSigner({
                secretKey: acct.coSk, publicKeys: acct.keys,
                recoveryPublicKey: recovery,
                policy: { allowedActions: new Set(['FILE']) }, maxFeeSats: 50000,
            });
            // Derive the envelope against THIS daemon's aggregate so the refusal
            // is about the account shape, not about a key mismatch.
            const script = buildEnvelopeScript(co.aggregateXOnly, ACTION, crypto.randomBytes(100));
            const commit = deriveEnvelopeCommit({ internalXOnly: co.aggregateXOnly, envelopeScript: script });
            const out = request(acct, co, buildCommitPsbt(acct, commit), script.toString('hex'));
            expect(out.reason).to.equal('ENVELOPE_UNSUPPORTED_ACCOUNT');
        });

        it('refuses a reveal whose output drains somewhere other than the account', function () {
            const acct = makeAccount();
            const { script, commit } = commitFor(acct);
            const co = makeCoSigner(acct);
            const foreign = bitcoin.payments.p2tr({ pubkey: makeAccount().aggKey }).output;
            const psbt = buildRevealPsbt(acct, commit, { outputScript: foreign });
            const out = request(acct, co, psbt, script.toString('hex'));
            expect(out.approved).to.equal(false);
            expect(out.reason).to.equal('UNAUTHORIZED_OUTPUT');
        });

        it('refuses an out-of-policy action carried by a perfectly valid envelope', function () {
            const acct = makeAccount();
            const script = buildEnvelopeScript(acct.aggKey,
                'SEND|0|MYTOKEN|10|1destX|m', crypto.randomBytes(100));
            const commit = deriveEnvelopeCommit({ internalXOnly: acct.aggKey, envelopeScript: script });
            const co = makeCoSigner(acct);   // policy allows FILE only
            const out = request(acct, co, buildCommitPsbt(acct, commit), script.toString('hex'));
            expect(out.approved).to.equal(false);
            expect(out.reason).to.not.equal(undefined);
            expect(out.reason).to.not.equal('APPROVED');
        });

        it('leaves ordinary (non-envelope) requests completely unchanged', function () {
            const acct = makeAccount();
            const inner = bitcoin.script.compile([Buffer.from('SEND|0|MYTOKEN|10|1destX|m', 'utf8')]);
            const prevHash = crypto.randomBytes(32);
            const txid = Buffer.from(prevHash).reverse().toString('hex');
            const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
            const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
            const psbt = new bitcoin.Psbt();
            psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
            psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
            psbt.addOutput({ script: acct.p2trScript, value: 90000 });
            const co = makeCoSigner(acct, { policy: { allowedActions: new Set(['SEND']) } });
            const out = co.process({
                psbt: psbt.toHex(),
                inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                    new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
            });
            expect(out.approved).to.equal(true);
            expect(out.envelopeRole).to.equal(undefined);
        });
    });

    describe('budget: one action, two transactions, one charge', function () {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');

        function freshStore() {
            const p = path.join(os.tmpdir(), `xc990-window-${crypto.randomBytes(6).toString('hex')}.json`);
            const store = new WindowStore(p, 24, null, { init: true });
            return { store, p };
        }

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

// The suite above drives the daemon in process, which is exactly the path that
// does NOT exercise either HTTP surface's request forwarding. A dropped
// `envelope` field there fails closed rather than dangerously, but it would make
// the same request succeed on one deployment and fail on another, which is the
// kind of divergence that only shows up in production. So drive it over real
// HTTP once, end to end, through the shipped sidecar.
describe(' co-signer: the envelope survives the wire', function () {
    const http = require('http');
    const { createCoSignerApp } = require('../../src/cosigner/server.js');
    const { createHostedCoSignerApp } = require('../../src/cosigner/hostedServer.js');

    function post(port, path, body, headers) {
        return new Promise((resolve, reject) => {
            const data = Buffer.from(JSON.stringify(body));
            const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
                headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {}) },
                (res) => {
                    let chunks = '';
                    res.on('data', (c) => { chunks += c; });
                    res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
                });
            req.on('error', reject);
            req.write(data); req.end();
        });
    }

    function envelopeRequest(acct, commit, script) {
        return {
            psbt: buildRevealPsbt(acct, commit).toHex(),
            envelope: { script: script.toString('hex') },
            inputs: [{ index: 0, agentPublicNonce: Buffer.from(
                new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk })).toString('hex') }],
        };
    }

    it('the single-tenant sidecar forwards it (a reveal approves over HTTP)', async function () {
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const app = createCoSignerApp(makeCoSigner(acct), { token: 'sekret' });
        const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
        try {
            const port = server.address().port;
            const ok = await post(port, '/cosign', envelopeRequest(acct, commit, script),
                { authorization: 'Bearer sekret' });
            expect(ok.status).to.equal(200);
            expect(ok.body.approved).to.equal(true);
            expect(ok.body.envelopeRole).to.equal('reveal');

            // Same request with the envelope field stripped must NOT approve:
            // that is what proves the approval above came from the forwarded
            // field rather than from the request happening to pass anyway.
            const stripped = envelopeRequest(acct, commit, script);
            delete stripped.envelope;
            const denied = await post(port, '/cosign', stripped, { authorization: 'Bearer sekret' });
            expect(denied.body.approved).to.equal(false);
        } finally {
            await new Promise((res) => server.close(res));
        }
    });

    it('the hosted multi-tenant surface forwards it too', async function () {
        // The hosted surface has its own construction contract: a >=16-char
        // tenant token, an explicit wire version on every request, and
        // listenSecure rather than listen.
        const HOSTED_TOKEN = 'tenant-envelope-token-0123456789';
        const acct = makeAccount();
        const { script, commit } = commitFor(acct);
        const app = createHostedCoSignerApp({
            tenants: [{ id: 't1', token: HOSTED_TOKEN, coSigner: makeCoSigner(acct) }],
        });
        const server = await new Promise((res) => {
            const s = app.listenSecure({ port: 0, host: '127.0.0.1', onListening: () => res(s) });
        });
        try {
            const port = server.address().port;
            const body = Object.assign({ version: 1 }, envelopeRequest(acct, commit, script));
            const ok = await post(port, '/v1/cosign', body, { authorization: 'Bearer ' + HOSTED_TOKEN });
            expect(ok.status).to.equal(200);
            expect(ok.body.approved).to.equal(true);
            expect(ok.body.envelopeRole).to.equal('reveal');

            const stripped = Object.assign({ version: 1 }, envelopeRequest(acct, commit, script));
            delete stripped.envelope;
            const denied = await post(port, '/v1/cosign', stripped, { authorization: 'Bearer ' + HOSTED_TOKEN });
            expect(denied.body.approved).to.equal(false);
        } finally {
            await new Promise((res) => server.close(res));
        }
    });
});

//  S5: the SDK must be able to REACH the encoder's new surface. It does
// not default to it (AUTO can return a commit/reveal pair where callers expect
// one PSBT, so that flip belongs to a major version), but a caller that wants
// the smallest footprint, or wants to opt out of compression, must be able to
// say so through the SDK rather than dropping to raw JSON-RPC.
describe(' S5: SDK create_tx passthrough', function () {
    const EncoderClient = require('../../src/encoder.js');

    function clientCapturing(captured) {
        // A real client with only the transport replaced, so the parameter
        // mapping under test is the shipped one.
        const enc = new EncoderClient({});
        enc._rpc = async (method, params) => {
            captured.method = method; captured.params = params;
            return { psbt: 'aa', encoding: 'P2WSH' };
        };
        return enc;
    }

    it('forwards encoding AUTO, compress and the options bag', async function () {
        const captured = {};
        const enc = clientCapturing(captured);
        await enc.createTx({
            pubkey: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef',
            data: 'FILE|0|a.log|text/plain',
            encoding: 'auto',
            compress: false,
            options: { signerSupportsTapscript: true },
        });
        expect(captured.params.encoding).to.equal('AUTO');
        expect(captured.params.compress).to.equal(false);
        expect(captured.params.options).to.deep.equal({ signerSupportsTapscript: true });
    });

    it('omits all three when the caller says nothing, so the encoder default applies', async function () {
        const captured = {};
        const enc = clientCapturing(captured);
        await enc.createTx({
            pubkey: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef',
            data: 'FILE|0|a.log|text/plain',
        });
        expect(captured.params).to.not.have.property('compress');
        expect(captured.params).to.not.have.property('options');
        expect(captured.params).to.not.have.property('encoding');
    });
});
