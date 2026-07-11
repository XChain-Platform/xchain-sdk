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
// Operator 2-of-3 recovery spend: each script-path leaf (agent+recovery,
// daemon+recovery) produces a tapscript witness whose MuSig2 aggregate sig
// verifies under the leaf key over the BIP341 tapleaf sighash.

'use strict';

const { expect } = require('chai');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { deriveMuSig2P2TR2of3 } = require('../../src/cosigner/account.js');
const { buildRecoverySpend, localPairSigner, tapleafHash } = require('../../src/cosigner/recovery.js');

function key() {
    const sk = crypto.randomBytes(32);
    return { sk, pk: Buffer.from(secp256k1.getPublicKey(sk, true)) };
}

function account() {
    const agent = key(), daemon = key(), recovery = key();
    const acct = deriveMuSig2P2TR2of3({ agent: agent.pk, daemon: daemon.pk, recovery: recovery.pk });
    return { agent, daemon, recovery, acct };
}

// A fake UTXO at the account + a self-paying output.
function io(acct, value = 100000) {
    return {
        inputs:  [{ txid: crypto.randomBytes(32).toString('hex'), vout: 0, value }],
        outputs: [{ script: acct.output, value: value - 1000 }],
    };
}

// Recompute input 0's tapleaf sighash from a finalized tx and verify the witness.
function expectValidLeafSpend(txHex, acct, leaf, value) {
    const tx = bitcoin.Transaction.fromHex(txHex);
    const w = tx.ins[0].witness;
    expect(w).to.have.length(3);                       // [sig, script, controlBlock]
    expect(w[1].equals(leaf.script)).to.equal(true);
    expect(w[2].equals(leaf.controlBlock)).to.equal(true);
    const sighash = tx.hashForWitnessV1(0, [acct.output], [value],
        bitcoin.Transaction.SIGHASH_DEFAULT, tapleafHash(leaf.script));
    expect(schnorr.verify(w[0], sighash, leaf.aggregateXOnly)).to.equal(true);
}

describe('cosigner/recovery buildRecoverySpend', function () {

    it('agent+recovery spend leaf 1 (daemon lost)', async function () {
        const a = account();
        const { inputs, outputs } = io(a.acct);
        const sign = localPairSigner(a.acct.recovery.agentRecovery, [a.agent.sk, a.recovery.sk]);
        const out = await buildRecoverySpend({ account: a.acct, leafName: 'agentRecovery', inputs, outputs, sign });
        expect(out.txid).to.be.a('string');
        expectValidLeafSpend(out.txHex, a.acct, a.acct.recovery.agentRecovery, 100000);
    });

    it('daemon+recovery spend leaf 2 (agent lost)', async function () {
        const a = account();
        const { inputs, outputs } = io(a.acct);
        const sign = localPairSigner(a.acct.recovery.daemonRecovery, [a.daemon.sk, a.recovery.sk]);
        const out = await buildRecoverySpend({ account: a.acct, leafName: 'daemonRecovery', inputs, outputs, sign });
        expectValidLeafSpend(out.txHex, a.acct, a.acct.recovery.daemonRecovery, 100000);
    });

    it('supports a pluggable (transport) signer, not just the local pair', async function () {
        const a = account();
        const { inputs, outputs } = io(a.acct);
        const inner = localPairSigner(a.acct.recovery.agentRecovery, [a.agent.sk, a.recovery.sk]);
        let calls = 0;
        const sign = (sighash, i) => { calls++; expect(i).to.equal(0); return inner(sighash); };
        const out = await buildRecoverySpend({ account: a.acct, leafName: 'agentRecovery', inputs, outputs, sign });
        expect(calls).to.equal(1);
        expectValidLeafSpend(out.txHex, a.acct, a.acct.recovery.agentRecovery, 100000);
    });

    it('localPairSigner rejects keys that do not aggregate to the leaf (wrong order/keys)', function () {
        const a = account();
        // daemon's key in the agent-recovery leaf -> aggregate mismatch.
        expect(() => localPairSigner(a.acct.recovery.agentRecovery, [a.daemon.sk, a.recovery.sk]))
            .to.throw(/do not aggregate/);
    });

    it('fails closed on a bad leaf name / missing inputs', async function () {
        const a = account();
        const { inputs, outputs } = io(a.acct);
        const sign = localPairSigner(a.acct.recovery.agentRecovery, [a.agent.sk, a.recovery.sk]);
        let e1; try { await buildRecoverySpend({ account: a.acct, leafName: 'nope', inputs, outputs, sign }); } catch (e) { e1 = e; }
        expect(e1).to.match(/unknown recovery leaf/);
        let e2; try { await buildRecoverySpend({ account: a.acct, leafName: 'agentRecovery', inputs: [], outputs, sign }); } catch (e) { e2 = e; }
        expect(e2).to.match(/inputs are required/);
    });

    it('rejects outputs that exceed inputs (would burn nothing but be invalid)', async function () {
        const a = account();
        const inputs  = [{ txid: crypto.randomBytes(32).toString('hex'), vout: 0, value: 100000 }];
        const outputs = [{ script: a.acct.output, value: 150000 }]; // > inputs
        const sign = localPairSigner(a.acct.recovery.agentRecovery, [a.agent.sk, a.recovery.sk]);
        let e; try { await buildRecoverySpend({ account: a.acct, leafName: 'agentRecovery', inputs, outputs, sign }); } catch (err) { e = err; }
        expect(e).to.match(/exceed inputs/);
    });

    it('rejects an absurd fee-rate (silent fund-burn guard)', async function () {
        const a = account();
        // 1 BTC in, a dust output: the ~1 BTC remainder would be donated to miners.
        const inputs  = [{ txid: crypto.randomBytes(32).toString('hex'), vout: 0, value: 100000000 }];
        const outputs = [{ script: a.acct.output, value: 1000 }];
        const sign = localPairSigner(a.acct.recovery.agentRecovery, [a.agent.sk, a.recovery.sk]);
        let e; try { await buildRecoverySpend({ account: a.acct, leafName: 'agentRecovery', inputs, outputs, sign }); } catch (err) { e = err; }
        expect(e).to.match(/exceeds the .* sat\/vB ceiling/);
    });

    it('allows an absurd fee-rate when acceptHighFee is set', async function () {
        const a = account();
        const inputs  = [{ txid: crypto.randomBytes(32).toString('hex'), vout: 0, value: 100000000 }];
        const outputs = [{ script: a.acct.output, value: 1000 }];
        const sign = localPairSigner(a.acct.recovery.agentRecovery, [a.agent.sk, a.recovery.sk]);
        const out = await buildRecoverySpend({ account: a.acct, leafName: 'agentRecovery', inputs, outputs, sign, acceptHighFee: true });
        expect(out.txHex).to.be.a('string');
    });
});
