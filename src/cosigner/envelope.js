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
 * XChain Platform SDK - Taproot envelope support for the MuSig2 co-signer
 * ( spec §3.9)
 *
 * The shipped co-signer signs ONE shape: a BIP341 key-path spend of an
 * untweaked MuSig2 aggregate, with the action read from an inline OP_RETURN.
 * A Taproot envelope needs three things that shape does not have, and all
 * three are derived HERE so the daemon and the agent compute them
 * independently from the same public bytes:
 *
 *   (a) a tap-tweaked key path. The envelope commit output is
 *       p2tr(internal = the aggregate, tree = {envelope leaf}), so its output
 *       key commits to the leaf and a key-path spend (the §3.5 cancel) must
 *       sign under tweak = TapTweak(aggregate || leafHash).
 *   (b) a script path. The reveal spends that output through the envelope
 *       leaf, so its message is the BIP342 tapleaf sighash, not the key-path
 *       one. The leaf's OP_CHECKSIG key is the bare aggregate, so the MuSig2
 *       session for a reveal carries NO tweak.
 *   (c) an action that lives in the leaf script rather than in an OP_RETURN
 *       (see psbtActionDecode.js).
 *
 * G3 is why the tweak is derived and never accepted: a raw `tweaks` value is
 * an unverifiable commitment to an arbitrary tap tree, and whoever supplies
 * it chooses the tree. An envelope SCRIPT is different in kind - it is
 * self-describing bytes the daemon can parse, match against the grammar, read
 * the intended ACTION out of, and check commits to its own aggregate key. So
 * the envelope surface takes a script and computes the tweak itself; supplying
 * a tweak stays refused everywhere.
 *
 * parseEnvelopeScript is a deliberate strict mirror of the authoritative
 * decoder's detectEnvelopeWitness (XChainDecoder.js): same grammar, same
 * rejections, same never-throws contract. It must never recognize an envelope
 * the chain would not, nor read a different payload out of one.
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');

bitcoin.initEccLib(ecc);

// The one magic constant every XChain carrier shares, cleartext in the
// envelope by design (§3.2/§3.8: recognition must be free pattern matching).
const ENVELOPE_MAGIC = Buffer.from('XCHN', 'utf8');
// Format byte 0x00 is this version. An unknown format byte is NOT an envelope:
// invisible rather than invalid, so a future format is a coordinated
// recognition change and never a client-side surprise (§3.2).
const ENVELOPE_FORMAT_V0 = 0x00;
const TAPROOT_LEAF_VERSION = 0xc0;
const TAPROOT_ANNEX_MARKER = 0x50;

/*
 * Strict mirror of XChainDecoder.detectEnvelopeWitness's script half.
 *
 * Grammar (§3.2), exact, nothing more:
 *   OP_FALSE OP_IF <"XCHN"> <format byte> <payload push 1..n> OP_ENDIF
 *   <32-byte x-only key> OP_CHECKSIG
 *
 * @returns {object|null} { payload, checksigKey } - never throws.
 */
function parseEnvelopeScript(script) {
    try {
        if (!Buffer.isBuffer(script) || script.length < 8) return null;
        const decompiled = bitcoin.script.decompile(script);
        if (!decompiled || decompiled.length < 8) return null;
        let i = 0;
        if (decompiled[i++] !== bitcoin.opcodes.OP_0) return null;
        if (decompiled[i++] !== bitcoin.opcodes.OP_IF) return null;
        if (!Buffer.isBuffer(decompiled[i]) || !decompiled[i].equals(ENVELOPE_MAGIC)) return null;
        i++;
        const formatByte = decompiled[i++];
        if (!Buffer.isBuffer(formatByte) || formatByte.length !== 1) return null;
        if (formatByte[0] !== ENVELOPE_FORMAT_V0) return null;
        const payloadPushes = [];
        while (i < decompiled.length && Buffer.isBuffer(decompiled[i])) {
            payloadPushes.push(decompiled[i]);
            i++;
        }
        if (payloadPushes.length === 0) return null;
        if (decompiled[i++] !== bitcoin.opcodes.OP_ENDIF) return null;
        if (!Buffer.isBuffer(decompiled[i]) || decompiled[i].length !== 32) return null;
        const checksigKey = decompiled[i];
        i++;
        if (decompiled[i++] !== bitcoin.opcodes.OP_CHECKSIG) return null;
        if (i !== decompiled.length) return null;
        return { payload: Buffer.concat(payloadPushes), checksigKey };
    } catch (e) {
        // A fuzzed or hostile script must never throw out of recognition, in
        // either half of the platform.
        return null;
    }
}

// BIP341 tapleaf hash for a single-leaf envelope tree. Pinned by test against
// bitcoinjs's own p2tr merkle root, which is what deriveEnvelopeCommit uses.
function envelopeLeafHash(script) {
    return bitcoin.crypto.taggedHash('TapLeaf', Buffer.concat([
        Buffer.from([TAPROOT_LEAF_VERSION]),
        compactSizePrefix(script),
        script,
    ]));
}

// Minimal compact-size encoder for the tapleaf serialization above. bitcoinjs
// exposes no public helper and the envelope script routinely exceeds 65,535
// bytes, where a 3-byte prefix would silently truncate the hash preimage.
function compactSizePrefix(buf) {
    const n = buf.length;
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}

/*
 * Derive everything about the commit output of an envelope owned by a MuSig2
 * account, from public bytes only.
 *
 * @param {object} args
 *   internalXOnly  {Buffer}  the account's aggregate x-only key (the internal key)
 *   envelopeScript {Buffer}  the leaf script (must parse; the caller checks the payload)
 *   network        {object}  bitcoinjs network
 * @returns {object} { leafHash, merkleRoot, tweak, output, address, controlBlock, outputXOnly }
 * @throws when the script is not a well-formed envelope, or does not commit to
 *         this account's key: both are refusals the caller must surface, never
 *         conditions to sign through.
 */
function deriveEnvelopeCommit(args = {}) {
    const { internalXOnly, envelopeScript, network } = args;
    if (!Buffer.isBuffer(internalXOnly) || internalXOnly.length !== 32)
        throw new Error('deriveEnvelopeCommit requires a 32-byte x-only internal key');
    const parsed = parseEnvelopeScript(envelopeScript);
    if (!parsed) throw new Error('envelope script does not match the  §3.2 grammar');
    // The leaf spends under OP_CHECKSIG against this key, so an envelope whose
    // checksig key is not our aggregate is somebody else's envelope: signing it
    // would be signing under a key we do not control the other half of.
    if (!parsed.checksigKey.equals(internalXOnly))
        throw new Error('envelope leaf commits to a different key than this account aggregate');

    const scriptTree = { output: envelopeScript };
    const p2tr = bitcoin.payments.p2tr({
        internalPubkey: internalXOnly, scriptTree, network: network || undefined,
    });
    const revealPayment = bitcoin.payments.p2tr({
        internalPubkey: internalXOnly, scriptTree,
        redeem: { output: envelopeScript, redeemVersion: TAPROOT_LEAF_VERSION },
        network: network || undefined,
    });
    const merkleRoot = p2tr.hash;
    return {
        leafHash:     merkleRoot,           // single-leaf tree: leaf hash IS the merkle root
        merkleRoot,
        tweak:        bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([internalXOnly, merkleRoot])),
        output:       p2tr.output,
        outputXOnly:  p2tr.output.subarray(2),
        address:      p2tr.address,
        controlBlock: revealPayment.witness[revealPayment.witness.length - 1],
        payload:      parsed.payload,
        script:       envelopeScript,
    };
}

/*
 * BIP342 tapleaf (script-path) sighash for one input, reconstructed from the
 * PSBT exactly as the key-path derivation is: caller-supplied messages are
 * never accepted on either path, and every input needs a witnessUtxo because
 * the sighash commits to all prevouts.
 */
function envelopeScriptPathSighash(psbt, inputIndex, hashType, leafHash) {
    const ins = psbt.txInputs;
    if (inputIndex < 0 || inputIndex >= ins.length)
        throw new Error('inputIndex ' + inputIndex + ' out of range');
    if (!Buffer.isBuffer(leafHash) || leafHash.length !== 32)
        throw new Error('script-path sighash requires a 32-byte leaf hash');
    const scripts = [], values = [];
    for (let i = 0; i < ins.length; i++) {
        const wu = psbt.data.inputs[i] && psbt.data.inputs[i].witnessUtxo;
        if (!wu || !wu.script) throw new Error('missing witnessUtxo for input ' + i);
        scripts.push(wu.script);
        values.push(wu.value);
    }
    const tx = new bitcoin.Transaction();
    tx.version  = psbt.version;
    tx.locktime = psbt.locktime;
    for (const ti of psbt.txInputs)  tx.addInput(ti.hash, ti.index, ti.sequence);
    for (const to of psbt.txOutputs) tx.addOutput(to.script, to.value);
    return tx.hashForWitnessV1(inputIndex, scripts, values,
        hashType === undefined ? bitcoin.Transaction.SIGHASH_DEFAULT : hashType,
        leafHash);
}

/*
 * Read an envelope leaf out of a PSBT input's tapLeafScript, if it carries
 * exactly one and it parses. Used to recognize a REVEAL without trusting the
 * caller to say what it is.
 *
 * @returns {object|null} { script, payload, checksigKey }
 */
function envelopeLeafFromPsbtInput(psbtInput) {
    if (!psbtInput || !Array.isArray(psbtInput.tapLeafScript) || psbtInput.tapLeafScript.length !== 1)
        return null;
    const leaf = psbtInput.tapLeafScript[0];
    if (!leaf || leaf.leafVersion !== TAPROOT_LEAF_VERSION || !Buffer.isBuffer(leaf.script)) return null;
    const parsed = parseEnvelopeScript(leaf.script);
    if (!parsed) return null;
    return { script: leaf.script, payload: parsed.payload, checksigKey: parsed.checksigKey };
}

/*
 * Classify what an envelope request is asking this account to sign, derived
 * from the PSBT and the account's own keys - never from a caller's label.
 *
 * COMMIT: an OUTPUT equals the derived commit script (the envelope is being
 *         funded; its inputs are ordinary account UTXOs, key-path, untweaked).
 * REVEAL: input 0 SPENDS the commit script through the envelope leaf
 *         (script-path, no tweak, message is the tapleaf sighash).
 * CANCEL: input 0 spends the commit script with no leaf presented
 *         (key-path, tweaked by the leaf, the §3.5 recovery path).
 *
 * @returns {'commit'|'reveal'|'cancel'|null}
 */
function classifyEnvelopeRole(psbt, commit) {
    const input0 = psbt.data.inputs[0];
    const wu0 = input0 && input0.witnessUtxo;
    if (wu0 && wu0.script && wu0.script.equals(commit.output)) {
        const leaf = envelopeLeafFromPsbtInput(input0);
        if (!leaf) return 'cancel';
        // A leaf that is not the one this commit committed to cannot spend the
        // output anyway (the control block would not verify), but classifying it
        // as a reveal would derive a signing message for the wrong leaf.
        return leaf.script.equals(commit.script) ? 'reveal' : null;
    }
    for (const out of psbt.txOutputs) {
        if (out.script.equals(commit.output)) return 'commit';
    }
    return null;
}

module.exports = {
    ENVELOPE_MAGIC,
    ENVELOPE_FORMAT_V0,
    TAPROOT_LEAF_VERSION,
    TAPROOT_ANNEX_MARKER,
    parseEnvelopeScript,
    envelopeLeafHash,
    deriveEnvelopeCommit,
    envelopeScriptPathSighash,
    envelopeLeafFromPsbtInput,
    classifyEnvelopeRole,
};
