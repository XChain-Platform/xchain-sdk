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
// 2-of-3 recovery account (deriveMuSig2P2TR2of3): proves all three spend paths
// are real - the agent+daemon key path (BIP341-tweaked, drives the address
// output key) and the two operator-recovery script-path leaves (agent+recovery,
// daemon+recovery), each a MuSig2 2-of-2 over its tapleaf sighash.

'use strict';

const { expect } = require('chai');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2   = require('../../src/musig2.js');
const CoSigner = require('../../src/cosigner/coSigner.js');
const CoSignerClient = require('../../src/cosigner/client.js');
const { inProcessTransport } = CoSignerClient;
const { deriveMuSig2P2TR2of3 } = require('../../src/cosigner/account.js');

bitcoin.initEccLib(ecc);

function key() {
    const sk = crypto.randomBytes(32);
    return { sk, pk: Buffer.from(secp256k1.getPublicKey(sk, true)) };
}

// BIP341 tapleaf hash for a small (< 253-byte) tapscript.
function tapleafHash(script) {
    const ser = Buffer.concat([Buffer.from([0xc0, script.length]), script]);
    return bitcoin.crypto.taggedHash('TapLeaf', ser);
}

// Build a 1-input PSBT spending the account's P2TR output, OP_RETURN + change-to-self.
function spendPsbt(accountOutput, actionString) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const inner = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: accountOutput, value: 100000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: accountOutput, value: 90000 });   // change to self
    return psbt;
}

// In-process MuSig2 2-of-2 over `msg` with no tweak (the recovery script-path case).
function coSign2of2(keys, secrets, msg) {
    const a = new MuSig2(), b = new MuSig2();
    const na = a.generateNonce({ publicKey: keys[0], secretKey: secrets[0] });
    const nb = b.generateNonce({ publicKey: keys[1], secretKey: secrets[1] });
    const agg = a.aggregateNonces([na, nb]);
    const sa = a.startSession(agg, msg, keys, []);
    const sb = b.startSession(agg, msg, keys, []);
    const pa = a.partialSign({ secretKey: secrets[0], publicNonce: na, sessionKey: sa });
    const pb = b.partialSign({ secretKey: secrets[1], publicNonce: nb, sessionKey: sb });
    return Buffer.from(a.aggregateSignatures([pa, pb], sa));
}

describe('cosigner/account deriveMuSig2P2TR2of3 (recovery)', function () {

    it('derives the canonical tap tree (internal = agg(agent,daemon); two recovery leaves)', function () {
        const agent = key(), daemon = key(), recovery = key();
        const acct = deriveMuSig2P2TR2of3({ agent: agent.pk, daemon: daemon.pk, recovery: recovery.pk });

        // Address matches a plain bitcoinjs p2tr over the same internal key + tree.
        const leafAR = acct.recovery.agentRecovery.script;
        const leafDR = acct.recovery.daemonRecovery.script;
        const ref = bitcoin.payments.p2tr({
            internalPubkey: acct.internalXOnly,
            scriptTree: [{ output: leafAR }, { output: leafDR }],
        });
        expect(acct.address).to.equal(ref.address);
        expect(acct.output.equals(ref.output)).to.equal(true);

        // Each leaf is <32-byte aggregate> OP_CHECKSIG, with a 65-byte control block.
        const decAR = bitcoin.script.decompile(leafAR);
        expect(decAR[0].equals(acct.recovery.agentRecovery.aggregateXOnly)).to.equal(true);
        expect(decAR[1]).to.equal(bitcoin.opcodes.OP_CHECKSIG);
        expect(acct.recovery.agentRecovery.controlBlock).to.have.length(65);
        expect(acct.recovery.daemonRecovery.controlBlock).to.have.length(65);
    });

    it('agent+daemon spend the address via the tweaked key path', async function () {
        const agent = key(), daemon = key(), recovery = key();
        const acct = deriveMuSig2P2TR2of3({ agent: agent.pk, daemon: daemon.pk, recovery: recovery.pk });

        // Construct the co-signer (daemon) and client (agent) on the KEY-PATH set.
        // The daemon is given the recovery PUBLIC KEY and re-derives the tree (and
        // therefore the tweak) itself; it never accepts a tweak from the caller,
        // because an opaque tweak commits to a tree the daemon cannot inspect (G3).
        const co = new CoSigner({ secretKey: daemon.sk, publicKeys: acct.keyPath.publicKeys,
            recoveryPublicKey: recovery.pk, policy: { allowedActions: new Set(['SEND']) } });
        const client = new CoSignerClient({ transport: inProcessTransport(co),
            publicKeys: acct.keyPath.publicKeys, tweaks: acct.keyPath.tweaks });

        const psbt = spendPsbt(acct.output, 'SEND|0|TOK|5|1destX|m');
        const out = await client.sign({ psbt: psbt.toHex(), secretKey: agent.sk });

        // The aggregate sig verifies under the address's OUTPUT key (post-tweak).
        expect(schnorr.verify(out.signature, out.msg, acct.outputXOnly)).to.equal(true);
    });

    it('agent+recovery satisfy leaf 1 (script-path recovery if the daemon is lost)', function () {
        const agent = key(), daemon = key(), recovery = key();
        const acct = deriveMuSig2P2TR2of3({ agent: agent.pk, daemon: daemon.pk, recovery: recovery.pk });
        const leaf = acct.recovery.agentRecovery;

        // A script-path spend: sighash commits to the tapleaf; the leaf key is the
        // bare MuSig2(agent,recovery) aggregate (no taptweak on a script path).
        const tx = new bitcoin.Transaction();
        tx.addInput(crypto.randomBytes(32), 0);
        tx.addOutput(acct.output, 90000);
        const sighash = tx.hashForWitnessV1(0, [acct.output], [100000],
            bitcoin.Transaction.SIGHASH_DEFAULT, tapleafHash(leaf.script));

        const sig = coSign2of2(leaf.publicKeys, [agent.sk, recovery.sk], sighash);
        expect(schnorr.verify(sig, sighash, leaf.aggregateXOnly)).to.equal(true);
    });

    it('daemon+recovery satisfy leaf 2 (script-path recovery if the agent is lost)', function () {
        const agent = key(), daemon = key(), recovery = key();
        const acct = deriveMuSig2P2TR2of3({ agent: agent.pk, daemon: daemon.pk, recovery: recovery.pk });
        const leaf = acct.recovery.daemonRecovery;

        const tx = new bitcoin.Transaction();
        tx.addInput(crypto.randomBytes(32), 0);
        tx.addOutput(acct.output, 90000);
        const sighash = tx.hashForWitnessV1(0, [acct.output], [100000],
            bitcoin.Transaction.SIGHASH_DEFAULT, tapleafHash(leaf.script));

        const sig = coSign2of2(leaf.publicKeys, [daemon.sk, recovery.sk], sighash);
        expect(schnorr.verify(sig, sighash, leaf.aggregateXOnly)).to.equal(true);
    });

    it('rejects missing parties', function () {
        expect(() => deriveMuSig2P2TR2of3({ agent: key().pk, daemon: key().pk }))
            .to.throw(/agent, daemon, recovery/);
    });
});
