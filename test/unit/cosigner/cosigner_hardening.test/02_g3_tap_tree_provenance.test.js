// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    expect,
    crypto,
    bitcoin,
    secp256k1,
    schnorr,
    MuSig2,
    CoSigner,
    deriveMuSig2P2TR2of3,
    makeAccount,
} = require('./helpers/cosigner_hardening_helpers.js');

// G3: a supplied taproot tweak is an unverifiable commitment.

// The attack this closes: a compromised agent controlling provisioning hands
// the daemon a tweak computed over a tree that contains `<agentPubkey>
// OP_CHECKSIG`. The daemon derives exactly the funded address, every gate
// passes, and the agent can then spend the entire account alone through that
// leaf - no daemon, no policy, no window, and on-chain indistinguishable
// from a cooperative spend.
function poisonedTree(agentPk, daemonPk) {
    const internal   = Buffer.from(new MuSig2().aggregateKeys([agentPk, daemonPk]).xOnlyPubkey);
    const agentXOnly = Buffer.from(agentPk).subarray(1);          // drop the parity byte
    const agentLeaf  = bitcoin.script.compile([agentXOnly, bitcoin.opcodes.OP_CHECKSIG]);
    const p2tr       = bitcoin.payments.p2tr({ internalPubkey: internal, scriptTree: { output: agentLeaf } });
    const tweak      = bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([internal, p2tr.hash]));
    return { internal, agentLeaf, agentXOnly, output: p2tr.output, tweak };
}

describe('G3: tap-tree provenance', function () {

    it('the poisoned tree really does grant the agent a unilateral spend', function () {
        // Establishes that the refusal below is protecting against a live hazard
        // rather than a theoretical one: a single agent signature satisfies the
        // leaf, with no daemon participation of any kind.
        const acct   = makeAccount();
        const tree   = poisonedTree(acct.agentPk, acct.coPk);
        const leafHash = bitcoin.crypto.taggedHash('TapLeaf',
            Buffer.concat([Buffer.from([0xc0]), bitcoin.script.compile([tree.agentLeaf]).subarray(0, 0),
                           Buffer.from([tree.agentLeaf.length]), tree.agentLeaf]));
        const sig = schnorr.sign(leafHash, acct.agentSk);
        expect(schnorr.verify(sig, leafHash, tree.agentXOnly)).to.equal(true);
    });
});

describe('G3: tap-tree provenance', function () {

    it('refuses a supplied tweak outright', function () {
        const acct = makeAccount();
        const tree = poisonedTree(acct.agentPk, acct.coPk);
        expect(() => new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            tweaks: [{ tweak: tree.tweak, xOnly: true }],
            policy: { allowedActions: new Set(['SEND']) },
        })).to.throw(/not accepted/);
    });

    it('derives the 2-of-3 tree itself, and lands somewhere the agent did not choose', function () {
        const acct       = makeAccount();
        const recoverySk = crypto.randomBytes(32);
        const recoveryPk = Buffer.from(secp256k1.getPublicKey(recoverySk, true));

        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            recoveryPublicKey: recoveryPk, policy: { allowedActions: new Set(['SEND']) } });

        const canonical = deriveMuSig2P2TR2of3({
            agent: acct.agentPk, daemon: acct.coPk, recovery: recoveryPk,
        });
        expect(co.accountScript.equals(canonical.output)).to.equal(true);

        // The whole point: the agent's chosen tree is NOT what the daemon guards.
        const poisoned = poisonedTree(acct.agentPk, acct.coPk);
        expect(co.accountScript.equals(poisoned.output)).to.equal(false);
    });
});

describe('G3: tap-tree provenance', function () {

    it('an empty tweaks array is still accepted (it is the 2-of-2 no-tweak case)', function () {
        const acct = makeAccount();
        expect(() => new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            tweaks: [], policy: { allowedActions: new Set(['SEND']) } })).to.not.throw();
    });
});
