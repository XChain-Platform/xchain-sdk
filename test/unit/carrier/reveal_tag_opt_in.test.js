/*
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 */

// The P2SH/P2WSH reveal tag makes the decoder read an action out of every input
// of the tagged transaction, so the carrier binding accepts it only from the
// phase-2 reveal, which opts in and then binds those inputs. Every other PSBT
// carrying the tag is refused, the attack shape included: an unsigned caller
// input first and a finalized foreign P2SH input whose redeem script holds a
// different action.

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
require('../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { assertCarrierBinding } = require('../../../src/carrier/bind_action_carrier.js');

const NET = bitcoin.networks.bitcoin;
const H160 = Buffer.alloc(20, 0xab);
const CALLER = bitcoin.payments.p2wpkh({ hash: H160, network: NET }).address;
const OWN = bitcoin.payments.p2wpkh({ hash: H160, network: NET }).output;
const SEND_A = 'SEND|0|TOK|1|1RecipientAAAAAAAAAAAAAAAAAAAAAAAA|m';
const SEND_B = 'SEND|0|TOK|1000|1RecipientBBBBBBBBBBBBBBBBBBBBBBBB|m';

function tagOutput(prevHash, tag) {
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const plain = Buffer.concat([Buffer.from('XCHN'), Buffer.from(tag, 'utf8')]);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { script: bitcoin.payments.embed({ data: [data] }).output, value: 0 };
}

// A tag marker plus change, spending one caller input.
function tagPsbt(tag) {
    const prevHash = crypto.randomBytes(32);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    psbt.addOutput(tagOutput(prevHash, tag));
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt;
}

// The substitution shape: the caller's unsigned P2WPKH input first, then a
// finalized foreign P2SH input whose redeem script leads with another action.
function attackPsbt() {
    const prevHash = crypto.randomBytes(32);
    const redeem = bitcoin.script.compile([Buffer.from(SEND_B, 'utf8'), bitcoin.opcodes.OP_DROP,
        bitcoin.opcodes.OP_TRUE]);
    const foreign = new bitcoin.Transaction();
    foreign.addInput(crypto.randomBytes(32), 0);
    foreign.addOutput(bitcoin.payments.p2sh({ redeem: { output: redeem }, network: NET }).output, 10000);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    psbt.addInput({ hash: foreign.getHash(), index: 0, nonWitnessUtxo: foreign.toBuffer(),
        finalScriptSig: bitcoin.script.compile([bitcoin.opcodes.OP_0, Buffer.from('aa', 'hex'), redeem]) });
    psbt.addOutput(tagOutput(prevHash, 'p2sh'));
    psbt.addOutput({ script: OWN, value: 100000 });
    return psbt;
}

function bindError(args) {
    try {
        assertCarrierBinding(Object.assign({ network: NET, callerIdentities: CALLER, actionString: SEND_A }, args));
    } catch (e) { return e; }
    return null;
}

function expectTagRefused(err) {
    expect(err, 'the reveal tag must be refused').to.be.an('error');
    expect(err.code).to.equal('CARRIER_UNREADABLE');
    expect(err.details.reason).to.equal('P2SH_P2WSH_UNSUPPORTED');
}

describe('carrier binding: the reveal tag is an explicit opt-in', function () {
    it('accepts the tag when the phase-2 reveal opts in', function () {
        for (const tag of ['p2sh', 'p2wsh'])
            expect(bindError({ psbt: tagPsbt(tag), label: 'phase-2 reveal', allowRevealTag: true })).to.equal(null);
    });

    it('refuses the tag without the opt-in, whatever encoding or label is reported', function () {
        for (const tag of ['p2sh', 'p2wsh'])
            for (const encoding of ['OP_RETURN', 'P2SH', 'P2WSH', 'MULTISIGN', undefined])
                for (const label of ['transaction', 'fee estimate', 'message'])
                    expectTagRefused(bindError({ psbt: tagPsbt(tag), encoding, label }));
    });

    it('refuses the tag in hex form too', function () {
        expectTagRefused(bindError({ psbt: tagPsbt('p2wsh').toHex(), encoding: 'OP_RETURN' }));
    });

    it('treats any value other than true as no opt-in', function () {
        for (const allowRevealTag of [false, 'true', 1, null])
            expectTagRefused(bindError({ psbt: tagPsbt('p2sh'), allowRevealTag }));
    });

    it('refuses a phase-1 PSBT pairing the tag with a finalized foreign data input', function () {
        for (const encoding of ['OP_RETURN', 'P2SH'])
            expectTagRefused(bindError({ psbt: attackPsbt(), encoding, label: 'transaction' }));
    });
});
