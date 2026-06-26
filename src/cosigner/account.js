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
 * XChain Platform SDK - MuSig2 Account Derivation (co-signer)
 *
 * Derives the agent's 2-of-N MuSig2 P2TR spending account from the signer
 * set. This matches the wallet's `taproot-musig2` scheme
 * (wallet.js: bitcoin.payments.p2tr({ pubkey: aggregatedXOnly })): the
 * aggregated x-only key is used DIRECTLY as the Taproot output key, with NO
 * BIP341 taproot tweak. So spends are key-path signatures under the bare
 * aggregate, and the co-signer/agent sign with tweaks=[] (no tweak to
 * reconcile). This is a key-path-only output (no script commitment); the
 * 2-of-3 recovery tree, which DOES need a script-path tap tree, is a
 * separate derivation handled by deriveMuSig2P2TR2of3 below.
 *
 * --- 2-of-3 recovery (deriveMuSig2P2TR2of3) ---
 *
 * For real-value agents a dead co-signer must not freeze funds. The locked
 * decision is a 2-of-3 across {agent, daemon, operator-recovery} built as a
 * Taproot tree of MuSig2 pairs (canonical BIP341 shape):
 *   - KEY PATH  = MuSig2(agent, daemon)  - the hot cooperative spend (same
 *     parties as the 2-of-2 above), now BIP341-tweaked to commit the leaves.
 *   - LEAF 1 (script path) = MuSig2(agent, recovery)  OP_CHECKSIG
 *   - LEAF 2 (script path) = MuSig2(daemon, recovery) OP_CHECKSIG
 * So any two of the three can spend: agent+daemon on the cheap key path,
 * agent+recovery or daemon+recovery on a script path if one party is lost.
 * The key-path tweak plugs into the SAME `tweaks` the co-signer already
 * forwards, so the hot path needs no co-signer code change - only the
 * agent/daemon construct with keyPath.publicKeys + keyPath.tweaks.
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const MuSig2  = require('../musig2.js');

bitcoin.initEccLib(ecc);

/*
 * @param {(Uint8Array|string)[]} publicKeys  the full signer set, in the agreed
 *        order (key aggregation is order-sensitive; both parties must match)
 * @param {object} [network]  bitcoinjs network (default mainnet)
 * @returns {object}
 *   aggregateXOnly {Buffer}  the 32-byte aggregated x-only key (== output key)
 *   output         {Buffer}  the P2TR scriptPubKey
 *   address        {string}  the bech32m address
 *   tweaks         {Array}   always [] for this key-path scheme - sign with no tweak
 */
function deriveMuSig2P2TR(publicKeys, network) {
    const agg = new MuSig2().aggregateKeys(publicKeys);   // throws on < 2 keys / bad pubkey
    const aggregateXOnly = Buffer.from(agg.xOnlyPubkey);
    const p2tr = bitcoin.payments.p2tr({ pubkey: aggregateXOnly, network: network || undefined });
    return {
        aggregateXOnly,
        output:  p2tr.output,
        address: p2tr.address,
        tweaks:  [],
    };
}

// BIP341 tapscript leaf version.
const LEAF_VERSION = 0xc0;

/*
 * Derive the 2-of-3 recovery account (see the module header).
 *
 * @param {object} parties  { agent, daemon, recovery } single compressed pubkeys
 *        (Uint8Array|hex). Pair order is fixed as listed; both sides must match.
 * @param {object} [network]  bitcoinjs network
 * @returns {object}
 *   internalXOnly {Buffer}  MuSig2(agent,daemon) - the Taproot internal key
 *   address       {string}  the bech32m 2-of-3 address
 *   output        {Buffer}  P2TR scriptPubKey
 *   outputXOnly   {Buffer}  32-byte tweaked output key (what a key-path sig verifies under)
 *   merkleRoot    {Buffer}  tap tree merkle root
 *   keyPath       { publicKeys:[agent,daemon], tweaks:[{tweak,xOnly:true}] }
 *                 - construct the agent + daemon (CoSigner/CoSignerClient) with these
 *                   to sign the cooperative key path.
 *   recovery      { agentRecovery, daemonRecovery } each:
 *                 { publicKeys:[X,recovery], aggregateXOnly, script, controlBlock, leafVersion }
 *                 - a script-path spend signs the leaf with MuSig2(pair) (NO tweak)
 *                   over the tapleaf sighash; witness = [sig, script, controlBlock].
 */
function deriveMuSig2P2TR2of3(parties, network) {
    const { agent, daemon, recovery } = parties || {};
    if (!agent || !daemon || !recovery)
        throw new Error('deriveMuSig2P2TR2of3 requires { agent, daemon, recovery } public keys');

    const m = new MuSig2();
    const internal = Buffer.from(m.aggregateKeys([agent, daemon]).xOnlyPubkey);
    const arAgg    = Buffer.from(m.aggregateKeys([agent, recovery]).xOnlyPubkey);
    const drAgg    = Buffer.from(m.aggregateKeys([daemon, recovery]).xOnlyPubkey);

    const leafAR = bitcoin.script.compile([arAgg, bitcoin.opcodes.OP_CHECKSIG]);
    const leafDR = bitcoin.script.compile([drAgg, bitcoin.opcodes.OP_CHECKSIG]);
    const scriptTree = [{ output: leafAR }, { output: leafDR }];
    const net = network || undefined;

    const p2tr = bitcoin.payments.p2tr({ internalPubkey: internal, scriptTree, network: net });
    const merkleRoot = p2tr.hash;   // 32-byte tap merkle root
    const tweak = bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([internal, merkleRoot]));

    // Per-leaf control block (1 + 32 internal + 32 sibling = 65 bytes for a 2-leaf tree).
    const leaf = (output, agg, pair) => {
        const r = bitcoin.payments.p2tr({
            internalPubkey: internal, scriptTree,
            redeem: { output, redeemVersion: LEAF_VERSION }, network: net,
        });
        return {
            publicKeys:     pair,
            aggregateXOnly: agg,
            script:         output,
            controlBlock:   r.witness[r.witness.length - 1],
            leafVersion:    LEAF_VERSION,
        };
    };

    return {
        internalXOnly: internal,
        address:       p2tr.address,
        output:        p2tr.output,
        outputXOnly:   p2tr.output.subarray(2),
        merkleRoot,
        keyPath: { publicKeys: [agent, daemon], tweaks: [{ tweak, xOnly: true }] },
        recovery: {
            agentRecovery:  leaf(leafAR, arAgg, [agent, recovery]),
            daemonRecovery: leaf(leafDR, drAgg, [daemon, recovery]),
        },
    };
}

module.exports = { deriveMuSig2P2TR, deriveMuSig2P2TR2of3 };
