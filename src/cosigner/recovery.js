/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - MuSig2 2-of-3 Recovery Spend
 *
 * The operator escape hatch for the 2-of-3 recovery account
 * (deriveMuSig2P2TR2of3). When a party is lost, two of the three can still
 * move funds: agent+daemon on the cheap KEY path (the normal co-signer
 * flow), or agent+recovery / daemon+recovery on a SCRIPT path - this file.
 *
 * A script-path spend of a `<aggXonly> OP_CHECKSIG` leaf has witness
 * [schnorr_sig, leafScript, controlBlock], where the signature is a MuSig2
 * 2-of-2 of that leaf's pair over the BIP341 TAPSCRIPT sighash (no taptweak
 * on a script path - the leaf key signs directly).
 *
 * Transport-agnostic, like the co-signer: pass a `sign(sighash, i)` that
 * returns the 64-byte aggregate signature, or use localPairSigner() when the
 * operator holds both shares of the pair in-process.
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const MuSig2  = require('../musig2.js');

bitcoin.initEccLib(ecc);

function toBytes(v, label) {
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === 'string') return Buffer.from(v, 'hex');
    throw new Error(label + ' must be a hex string or Uint8Array');
}

// compactSize for tapleaf serialization (recovery scripts are tiny: 34 bytes).
function compactSize(n) {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) return Buffer.from([0xfd, n & 0xff, (n >> 8) & 0xff]);
    throw new Error('recovery leaf script unexpectedly large');
}

// BIP341 tapleaf hash: tagged('TapLeaf', leafVersion || compactSize(script) || script).
function tapleafHash(script, leafVersion) {
    const ver = (leafVersion === undefined) ? 0xc0 : leafVersion;
    return bitcoin.crypto.taggedHash('TapLeaf',
        Buffer.concat([Buffer.from([ver]), compactSize(script.length), script]));
}

// An in-process signer for the operator-holds-both-shares case: a MuSig2 2-of-2
// of the leaf pair over the message, NO tweak (script-path signs the leaf key).
function localPairSigner(leaf, secretKeys) {
    if (!leaf || !Array.isArray(leaf.publicKeys) || leaf.publicKeys.length !== 2)
        throw new Error('localPairSigner requires a recovery leaf with a 2-key pair');
    if (!Array.isArray(secretKeys) || secretKeys.length !== 2)
        throw new Error('localPairSigner requires the pair of secret keys, in leaf order');
    const sk = secretKeys.map((k, i) => toBytes(k, `secretKeys[${i}]`));
    const { secp256k1 } = require('@noble/curves/secp256k1');
    // Sanity: the supplied keys must aggregate to the leaf key (else the witness
    // would never satisfy the script). Fail loudly rather than emit a dead tx.
    const pub = sk.map((s) => Buffer.from(secp256k1.getPublicKey(s, true)));
    const agg = Buffer.from(new MuSig2().aggregateKeys(leaf.publicKeys).xOnlyPubkey);
    const aggFromSk = Buffer.from(new MuSig2().aggregateKeys(pub).xOnlyPubkey);
    if (!agg.equals(aggFromSk))
        throw new Error('localPairSigner: secret keys do not aggregate to the leaf key (wrong keys/order)');

    return (msg) => {
        const a = new MuSig2(), b = new MuSig2();
        const na = a.generateNonce({ publicKey: leaf.publicKeys[0], secretKey: sk[0] });
        const nb = b.generateNonce({ publicKey: leaf.publicKeys[1], secretKey: sk[1] });
        const aggNonce = a.aggregateNonces([na, nb]);
        const sa = a.startSession(aggNonce, msg, leaf.publicKeys, []);
        const sb = b.startSession(aggNonce, msg, leaf.publicKeys, []);
        const pa = a.partialSign({ secretKey: sk[0], publicNonce: na, sessionKey: sa });
        const pb = b.partialSign({ secretKey: sk[1], publicNonce: nb, sessionKey: sb });
        return Buffer.from(a.aggregateSignatures([pa, pb], sa));
    };
}

/*
 * Build a finalized script-path recovery spend.
 *
 * @param {object} cfg
 *   account   the deriveMuSig2P2TR2of3 result (needs .output + .recovery)
 *   leafName  'agentRecovery' | 'daemonRecovery'
 *   inputs    [{ txid, vout, value }]  UTXOs at the account (all share account.output)
 *   outputs   [{ address|script, value }]
 *   sign      async|sync (sighash:Buffer, inputIndex:number) -> Buffer(64) aggregate sig
 *             (use localPairSigner for the operator-holds-both case)
 *   network   bitcoinjs network (for address outputs)
 *   version   tx version (default 2)
 *   sequence  input sequence (default 0xffffffff)
 * @returns {Promise<{ txHex, txid }>}
 */
async function buildRecoverySpend(cfg = {}) {
    const { account, leafName, inputs, outputs, sign, network } = cfg;
    if (!account || !account.output || !account.recovery)
        throw new Error('buildRecoverySpend requires a deriveMuSig2P2TR2of3 account');
    const leaf = account.recovery[leafName];
    if (!leaf) throw new Error(`unknown recovery leaf "${leafName}" (use agentRecovery|daemonRecovery)`);
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('inputs are required');
    if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('outputs are required');
    if (typeof sign !== 'function') throw new Error('a sign(sighash, i) function is required');

    const seq = Number.isInteger(cfg.sequence) ? cfg.sequence : 0xffffffff;
    const tx = new bitcoin.Transaction();
    tx.version = Number.isInteger(cfg.version) ? cfg.version : 2;
    for (const i of inputs)
        tx.addInput(Buffer.from(i.txid, 'hex').reverse(), i.vout, seq);
    for (const o of outputs) {
        const script = o.script
            ? (Buffer.isBuffer(o.script) ? o.script : Buffer.from(o.script, 'hex'))
            : bitcoin.address.toOutputScript(o.address, network || undefined);
        tx.addOutput(script, o.value);
    }

    // Every input spends the same account output (the prevout set the sighash
    // commits to). One tapleaf sighash + signature per input.
    const prevScripts = inputs.map(() => account.output);
    const prevValues  = inputs.map((i) => i.value);
    const leafHash = tapleafHash(leaf.script, leaf.leafVersion);

    for (let i = 0; i < inputs.length; i++) {
        const sighash = tx.hashForWitnessV1(i, prevScripts, prevValues,
            bitcoin.Transaction.SIGHASH_DEFAULT, leafHash);
        const sig = await sign(sighash, i);
        const sigBuf = Buffer.isBuffer(sig) ? sig : Buffer.from(sig);
        if (sigBuf.length !== 64) throw new Error('recovery signer must return a 64-byte Schnorr signature');
        // Tapscript-path witness: [signature, leafScript, controlBlock].
        tx.ins[i].witness = [sigBuf, leaf.script, leaf.controlBlock];
    }

    return { txHex: tx.toHex(), txid: tx.getId() };
}

module.exports = { buildRecoverySpend, localPairSigner, tapleafHash };
