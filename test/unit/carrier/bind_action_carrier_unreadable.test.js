'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The carrier binding refuses an XCHN inline carrier it cannot read. Once the
// magic word matches, the decoder treats the output as a carrier and can still
// execute a command from bytes this SDK's stricter reader gives up on, so an
// unreadable carrier is a possible substitution and never a pass.

const { expect } = require('chai');
const crypto = require('crypto');
require('../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { assertCarrierBinding } = require('../../../src/carrier/bind_action_carrier.js');

const NET = bitcoin.networks.bitcoin;
const OWN = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xab), network: NET }).output;
const SEND_A = 'SEND|0|TOK|1|1RecipientAAAAAAAAAAAAAAAAAAAAAAAA|m';
const SEND_B = 'SEND|0|TOK|1000|1RecipientBBBBBBBBBBBBBBBBBBBBBBBB|m';

// AES-128-CTR under the first input's txid, as the encoder obfuscates a carrier.
function obfuscate(plain, prevHash) {
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function bind(args) {
    return () => assertCarrierBinding(Object.assign({ network: NET, label: 'transaction' }, args));
}

// An inline transaction whose post-magic body is supplied raw, for shapes the
// encoder never builds but a compromised one could.
function rawBodyPsbt(body) {
    const prevHash = crypto.randomBytes(32);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    const tagged = Buffer.concat([Buffer.from('XCHN'), body]);
    const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, obfuscate(tagged, prevHash)]);
    psbt.addOutput({ script, value: 0 });
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt;
}

// Return the error a binding throws, or null when it passes.
function bindError(args) {
    try { bind(args)(); return null; } catch (e) { return e; }
}

describe('carrier binding: an XCHN carrier this SDK cannot read', function () {

    // The decoder sizes only the leading push (plus a data second push), so a
    // substituted SEND followed by trailing opcodes still executes on chain.
    it('refuses an oversized body that hides a substituted action ahead of trailing opcodes', function () {
        const body = Buffer.concat([bitcoin.script.compile([Buffer.from(SEND_B, 'utf8')]), Buffer.alloc(8300, 0x51)]);
        for (const encoding of ['OP_RETURN', undefined, 'MULTISIGN']) {
            const e = bindError({ psbt: rawBodyPsbt(body), actionString: SEND_A, encoding });
            expect(e, `encoding=${encoding}`).to.be.an('error');
            expect(e.code).to.equal('CARRIER_UNREADABLE');
            expect(e.details.reason).to.equal('OVERSIZED');
        }
    });

    // The decoder falls back to lenient UTF-8 and still reads the action.
    it('refuses an action push that is not valid UTF-8', function () {
        const push = Buffer.concat([Buffer.from(SEND_B, 'utf8'), Buffer.from([0xff])]);
        const e = bindError({ psbt: rawBodyPsbt(bitcoin.script.compile([push])), actionString: SEND_A, encoding: 'OP_RETURN' });
        expect(e).to.be.an('error');
        expect(e.code).to.equal('CARRIER_UNREADABLE');
        expect(e.details.reason).to.equal('NOT_UTF8');
    });

    // The decoder joins XCHN bytes from every carrier output before it
    // decompiles, so a body that does not decompile alone can still complete one.
    it('refuses a truncated push and a magic word with nothing after it', function () {
        for (const body of [Buffer.from([0x4c, 0xff, 0x41, 0x42]), Buffer.alloc(0)]) {
            const e = bindError({ psbt: rawBodyPsbt(body), actionString: SEND_A, encoding: 'OP_RETURN' });
            expect(e, 'body=' + body.toString('hex')).to.be.an('error');
            expect(e.code).to.equal('CARRIER_UNREADABLE');
            expect(e.details.reason).to.equal('INNER_DECOMPILE_FAILED');
        }
    });
});

// A bare-multisig output in the decoder's MULTISIGN carrier shape: six elements ending OP_CHECKMULTISIG.
function multisigScript(m) {
    const slot = (b) => Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, b)]);
    return bitcoin.script.compile([m, slot(0x11), slot(0x22), slot(0x33), bitcoin.opcodes.OP_3,
        bitcoin.opcodes.OP_CHECKMULTISIG]);
}

function multisigPsbt(m, inline) {
    const psbt = inline ? rawBodyPsbt(bitcoin.script.compile([Buffer.from(SEND_A, 'utf8')]))
        : new bitcoin.Psbt({ network: NET });
    if (!inline) psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    psbt.addOutput({ script: multisigScript(m), value: 1000 });
    if (!inline) psbt.addOutput({ script: OWN, value: 90000 });
    return psbt;
}

// The decoder reads a bare-multisig output as an action carrier and this SDK has no read-back
// for it, so the binding refuses one outright rather than leaning on reconcile having run first.
describe('carrier binding: a bare-multisig carrier this SDK cannot read back', function () {

    it('refuses a 1-of-3 multisig carrier whatever encoding the encoder reports', function () {
        for (const encoding of ['MULTISIGN', 'OP_RETURN', 'P2SH', 'P2WSH', 'TAPROOT', undefined]) {
            const e = bindError({ psbt: multisigPsbt(bitcoin.opcodes.OP_1), actionString: SEND_A, encoding });
            expect(e, `encoding=${encoding}`).to.be.an('error');
            expect(e.code).to.equal('CARRIER_UNREADABLE');
            expect(e.details.reason).to.equal('MULTISIG_CARRIER_UNSUPPORTED');
        }
    });

    it('refuses a 2-of-3 shape too, since the decoder never checks m or n', function () {
        const e = bindError({ psbt: multisigPsbt(bitcoin.opcodes.OP_2), actionString: SEND_A, encoding: 'MULTISIGN' });
        expect(e && e.code).to.equal('CARRIER_UNREADABLE');
    });

    it('refuses the same PSBT handed over as hex', function () {
        const e = bindError({ psbt: multisigPsbt(bitcoin.opcodes.OP_1).toHex(), actionString: SEND_A });
        expect(e && e.code).to.equal('CARRIER_UNREADABLE');
    });

    it('refuses a multisig carrier riding beside a matching inline carrier', function () {
        expect(bindError({ psbt: rawBodyPsbt(bitcoin.script.compile([Buffer.from(SEND_A, 'utf8')])),
            actionString: SEND_A, encoding: 'OP_RETURN' })).to.equal(null);
        const e = bindError({ psbt: multisigPsbt(bitcoin.opcodes.OP_1, true), actionString: SEND_A, encoding: 'OP_RETURN' });
        expect(e && e.code).to.equal('CARRIER_UNREADABLE');
        expect(e.details.reason).to.equal('MULTISIG_CARRIER_UNSUPPORTED');
    });
});
