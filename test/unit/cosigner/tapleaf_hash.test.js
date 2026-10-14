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
// The co-signer's one BIP341 TapLeaf hash, checked against bitcoinjs's own
// p2tr hashing rather than against itself, for the 2-of-3 recovery leaves and
// the envelope leaf alike.

'use strict';

const { expect } = require('chai');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { deriveMuSig2P2TR2of3 } = require('../../../src/cosigner/account.js');
const recovery = require('../../../src/cosigner/recovery.js');
const envelope = require('../../../src/cosigner/envelope.js');

bitcoin.initEccLib(ecc);

// The secp256k1 generator's x coordinate: any valid x-only key works as the internal key.
const INTERNAL = Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');

// A single-leaf p2tr's merkle root IS that leaf's hash, so bitcoinjs serves as the oracle.
function bitcoinjsLeafHash(script, version) {
    return bitcoin.payments.p2tr({ internalPubkey: INTERNAL,
        scriptTree: { output: script, version: version === undefined ? 0xc0 : version } }).hash;
}

function key() {
    return Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
}

describe('cosigner tapleaf hash', function () {

    it('hashes both 2-of-3 recovery leaves as bitcoinjs does and composes the account merkle root', function () {
        const acct = deriveMuSig2P2TR2of3({ agent: key(), daemon: key(), recovery: key() });
        const leaves = [acct.recovery.agentRecovery, acct.recovery.daemonRecovery];
        const hashes = leaves.map(l => recovery.tapleafHash(l.script, l.leafVersion));
        leaves.forEach((l, i) => {
            expect(hashes[i].equals(bitcoinjsLeafHash(l.script, l.leafVersion))).to.equal(true);
            expect(hashes[i].equals(envelope.envelopeLeafHash(l.script))).to.equal(true);
        });
        const [lo, hi] = hashes.slice().sort(Buffer.compare);
        const branch = bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([lo, hi]));
        expect(branch.equals(acct.merkleRoot)).to.equal(true);
    });

    // 65536 is the length the recovery copy used to refuse; the others are the compact-size edges.
    it('matches bitcoinjs at every compact-size boundary', function () {
        for (const n of [1, 252, 253, 65535, 65536]) {
            const script = Buffer.alloc(n, 0x51);
            expect(recovery.tapleafHash(script).equals(bitcoinjsLeafHash(script)), 'length ' + n).to.equal(true);
        }
    });

    it('defaults the leaf version to 0xc0 and honours an explicit one', function () {
        const script = Buffer.alloc(34, 0x51);
        expect(recovery.tapleafHash(script, 0xc0).equals(recovery.tapleafHash(script))).to.equal(true);
        expect(recovery.tapleafHash(script, 0xc2).equals(bitcoinjsLeafHash(script, 0xc2))).to.equal(true);
        expect(recovery.tapleafHash(script, 0xc2).equals(recovery.tapleafHash(script))).to.equal(false);
    });

    it('keeps exactly one definition behind both public names', function () {
        expect(recovery.tapleafHash).to.equal(envelope.tapleafHash);
    });
});
