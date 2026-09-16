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
// MuSig2 co-signer composition with the Taproot envelope (§3.9). Three
// deltas, all exercised here against real Schnorr verification rather than
// against the daemon's own say-so:
//   (a) tap-tweaked key path for the cancel of a tree-committed output,
//   (b) BIP342 script-path sighash over the envelope leaf for the reveal,
//   (c) the action decoded from the leaf script instead of an OP_RETURN.

const { expect } = require('chai');
const crypto  = require('crypto');
require('../../../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2   = require('../../../../../src/cosigner/musig2.js');
const CoSigner = require('../../../../../src/cosigner/co_signer.js');
const CoSignerClient = require('../../../../../src/cosigner/client.js');
const WindowStore = require('../../../../../src/cosigner/window_store.js');
const {
    parseEnvelopeScript, deriveEnvelopeCommit, envelopeLeafHash,
    envelopeScriptPathSighash, classifyEnvelopeRole, envelopeRoundTweaks,
} = require('../../../../../src/cosigner/envelope.js');
const { deriveMuSig2P2TR2of3 } = require('../../../../../src/cosigner/account.js');
const { buildRecoverySpend, localPairSigner } = require('../../../../../src/cosigner/recovery.js');
const { decodeEnvelopeAction } = require('../../../../../src/cosigner/psbt_action_decode.js');

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

// 2-of-3 fixtures.
// A 2-of-3 account: the agent+daemon key path is BIP341-tweaked by the account's
// own recovery tree, so every envelope derivation has to stay on the UNTWEAKED
// cooperative aggregate, and the commit tree has to carry the recovery leaves.

function make2of3() {
    const agentSk = crypto.randomBytes(32), coSk = crypto.randomBytes(32), recSk = crypto.randomBytes(32);
    const agentPk = Buffer.from(secp256k1.getPublicKey(agentSk, true));
    const coPk    = Buffer.from(secp256k1.getPublicKey(coSk, true));
    const recPk   = Buffer.from(secp256k1.getPublicKey(recSk, true));
    const account = deriveMuSig2P2TR2of3({ agent: agentPk, daemon: coPk, recovery: recPk });
    const co = new CoSigner({
        secretKey: coSk, publicKeys: account.keyPath.publicKeys, recoveryPublicKey: recPk,
        policy: { allowedActions: new Set(['FILE']) }, maxFeeSats: 50000,
    });
    return { agentSk, coSk, recSk, agentPk, coPk, recPk, account, co,
             keys: account.keyPath.publicKeys };
}

function client3(a3, extra = {}) {
    return new CoSignerClient(Object.assign({
        transport: CoSignerClient.inProcessTransport(a3.co),
        publicKeys: a3.keys, recoveryPublicKey: a3.recPk,
    }, extra));
}

// The envelope of a 2-of-3, derived the way both halves derive it: internal key
// and leaf key are the untweaked cooperative aggregate, tree carries the
// account's two recovery leaves alongside the envelope leaf.
function envelopeFor3(a3, rawLen = 1200) {
    const script = buildEnvelopeScript(a3.account.internalXOnly, ACTION, crypto.randomBytes(rawLen));
    const commit = deriveEnvelopeCommit({
        internalXOnly: a3.account.internalXOnly, envelopeScript: script,
        recoveryLeaves: a3.account.recovery,
    });
    return { script, commit };
}

function commitPsbt3(a3, commit) {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0,
        witnessUtxo: { script: a3.account.output, value: 100000 } });
    psbt.addOutput({ script: commit.output, value: 20000 });
    psbt.addOutput({ script: a3.account.output, value: 70000 });
    return psbt;
}

function revealPsbt3(a3, commit) {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0,
        witnessUtxo: { script: commit.output, value: 20000 },
        tapInternalKey: a3.account.internalXOnly,
        tapLeafScript: [{ leafVersion: LEAF_VERSION, script: commit.script, controlBlock: commit.controlBlock }] });
    psbt.addOutput({ script: a3.account.output, value: 15000 });
    return psbt;
}

function cancelPsbt3(a3, commit) {
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0,
        witnessUtxo: { script: commit.output, value: 20000 },
        tapInternalKey: a3.account.internalXOnly, tapMerkleRoot: commit.merkleRoot });
    psbt.addOutput({ script: a3.account.output, value: 15000 });
    return psbt;
}

// Independently recompute the taproot output key a control block proves a path
// to: exactly what a validating node does, so this checks the merkle path
// rather than re-running the same derivation and calling it agreement.
function outputKeyFromControlBlock(controlBlock, leafScript) {
    const internal = controlBlock.subarray(1, 33);
    let node = envelopeLeafHash(leafScript);
    for (let i = 33; i < controlBlock.length; i += 32) {
        const sib = controlBlock.subarray(i, i + 32);
        node = Buffer.compare(node, sib) < 0
            ? bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([node, sib]))
            : bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([sib, node]));
    }
    const tweak = bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([internal, node]));
    const point = ecc.xOnlyPointAddTweak(internal, tweak);
    return { xOnly: Buffer.from(point.xOnlyPubkey), parity: point.parity };
}

module.exports = {
    expect, crypto, bitcoin, ecc, secp256k1, schnorr,
    MuSig2, CoSigner, CoSignerClient, WindowStore,
    parseEnvelopeScript, deriveEnvelopeCommit, envelopeLeafHash,
    envelopeScriptPathSighash, classifyEnvelopeRole, envelopeRoundTweaks,
    deriveMuSig2P2TR2of3, buildRecoverySpend, localPairSigner,
    decodeEnvelopeAction, LEAF_VERSION, ACTION, makeAccount,
    buildEnvelopeScript, commitFor, buildCommitPsbt, buildRevealPsbt,
    buildCancelPsbt, makeCoSigner, runRound, make2of3, client3,
    envelopeFor3, commitPsbt3, revealPsbt3, cancelPsbt3,
    outputKeyFromControlBlock,
};
