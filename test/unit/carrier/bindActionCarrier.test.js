'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Binding the carrier to the submitted action, at the last moment before a
// signature exists.
//
// reconcileEncoded proves the encoder's answer still spends the caller's coin
// where the caller asked; it never reads the data carrier. So a PSBT that
// reconciles perfectly can still carry a different COMMAND, and the single-WIF
// path signed exactly that. The fixtures here build the carrier the way
// XChainEncoder does (XCHN magic + a compiled push, AES-128-CTR obfuscated under
// the first input's txid; chunk redeem scripts as a leading data push plus the
// P2PKH spend gate), so a change to either shape shows up here.

const { expect } = require('chai');
const crypto = require('crypto');
require('../../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const { assertCarrierBinding, assertEnvelopeCarrierBinding } = require('../../../src/carrier/bindActionCarrier.js');

const NET = bitcoin.networks.bitcoin;
const H160 = Buffer.alloc(20, 0xab);
const OWN = bitcoin.payments.p2wpkh({ hash: H160, network: NET }).output;

// The action the caller submits throughout: 1 token to recipient A.
const SEND_A = 'SEND|0|TOK|1|1RecipientAAAAAAAAAAAAAAAAAAAAAAAA|m';
// What a compromised encoder substitutes: 1000 to recipient B.
const SEND_B = 'SEND|0|TOK|1000|1RecipientBBBBBBBBBBBBBBBBBBBBBBBB|m';

function obfuscate(plain, prevHash) {
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function carrierScript(prevHash, actionString) {
    const tagged = Buffer.concat([Buffer.from('XCHN'),
        bitcoin.script.compile([Buffer.from(actionString, 'utf8')])]);
    return bitcoin.payments.embed({ data: [obfuscate(tagged, prevHash)] }).output;
}

// An inline OP_RETURN transaction: one carrier output plus change back to us.
function inlinePsbt(actionString, opts = {}) {
    const prevHash = opts.prevHash || crypto.randomBytes(32);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    if (actionString !== null) psbt.addOutput({ script: carrierScript(prevHash, actionString), value: 0 });
    if (opts.second) psbt.addOutput({ script: carrierScript(prevHash, opts.second), value: 0 });
    if (opts.decoy) psbt.addOutput({ script: bitcoin.payments.embed({ data: [Buffer.from('junk')] }).output, value: 0 });
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt;
}

// The P2SH/P2WSH reveal's marker: the tag, not an action.
function tagPsbt(tag) {
    const prevHash = crypto.randomBytes(32);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    const tagged = Buffer.concat([Buffer.from('XCHN'), Buffer.from(tag, 'utf8')]);
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obfuscate(tagged, prevHash)] }).output, value: 0 });
    psbt.addOutput({ script: OWN, value: 90000 });
    return psbt;
}

// Chunk lane fixtures, mirroring XChainEncoder's redeem-script shape.
function redeemFor(chunk) {
    return bitcoin.script.compile([chunk, bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160, H160, bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG]);
}

function chunkLane(actionString, encoding) {
    const data = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const redeems = [];
    for (let i = 0; i < data.length; i += 40) redeems.push(redeemFor(data.subarray(i, i + 40)));
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
    for (const r of redeems) {
        const script = encoding === 'P2SH'
            ? bitcoin.payments.p2sh({ redeem: { output: r }, network: NET }).output
            : bitcoin.payments.p2wsh({ redeem: { output: r }, network: NET }).output;
        psbt.addOutput({ script, value: 1000 });
    }
    psbt.addOutput({ script: OWN, value: 80000 });
    return { psbt, carrierScripts: redeems.map(r => r.toString('hex')) };
}

// A §3.2 envelope leaf, built here so the suite stands alone.
function envelopeLeaf(actionString, rawData) {
    const payload = bitcoin.script.compile(
        rawData === null ? [Buffer.from(actionString, 'utf8')]
                         : [Buffer.from(actionString, 'utf8'), rawData]);
    const pushes = [];
    for (let i = 0; i < payload.length; i += 520) pushes.push(payload.subarray(i, i + 520));
    const key = crypto.randomBytes(32);
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_FALSE, bitcoin.opcodes.OP_IF,
        Buffer.from('XCHN', 'utf8'), Buffer.from([0x00]), ...pushes,
        bitcoin.opcodes.OP_ENDIF, key, bitcoin.opcodes.OP_CHECKSIG,
    ]);
}

function revealPsbt(leafScript) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({
        hash: crypto.randomBytes(32), index: 0,
        witnessUtxo: { script: Buffer.alloc(34, 0x51), value: 20000 },
        tapInternalKey: crypto.randomBytes(32),
        tapLeafScript: [{ leafVersion: 0xc0, script: leafScript, controlBlock: Buffer.concat([Buffer.from([0xc0]), crypto.randomBytes(32)]) }],
    });
    psbt.addOutput({ script: OWN, value: 15000 });
    return psbt;
}

function bind(args) {
    return () => assertCarrierBinding(Object.assign({ network: NET, label: 'transaction' }, args));
}

describe('carrier binding: the transaction must carry the action that was submitted', function () {

    describe('the inline OP_RETURN lane', function () {
        it('passes when the carrier holds exactly the submitted action', function () {
            expect(bind({ psbt: inlinePsbt(SEND_A), actionString: SEND_A, encoding: 'OP_RETURN' })).to.not.throw();
        });

        // The finding's proof of concept: identical native outputs, identical fee,
        // a different amount and a different destination inside the carrier.
        it('refuses a substituted amount and destination', function () {
            expect(bind({ psbt: inlinePsbt(SEND_B), actionString: SEND_A, encoding: 'OP_RETURN' }))
                .to.throw(/does not carry the action/);
            try { assertCarrierBinding({ psbt: inlinePsbt(SEND_B), actionString: SEND_A, encoding: 'OP_RETURN', network: NET }); }
            catch (e) { expect(e.code).to.equal('CARRIER_ACTION_MISMATCH'); }
        });

        // The reported encoding is the encoder's own claim, so it may only make the
        // check stricter. An encoder answering "MULTISIGN" while writing an inline
        // SEND must not buy itself a skip.
        it('refuses a substituted carrier whatever encoding the encoder claims', function () {
            for (const encoding of ['MULTISIGN', 'P2SH', 'TAPROOT', undefined]) {
                expect(bind({ psbt: inlinePsbt(SEND_B), actionString: SEND_A, encoding }),
                    `encoding=${encoding}`).to.throw(/does not carry the action/);
            }
        });

        it('refuses a second carrier riding alongside the real one', function () {
            expect(bind({ psbt: inlinePsbt(SEND_A, { second: SEND_B }), actionString: SEND_A, encoding: 'OP_RETURN' }))
                .to.throw(/does not carry the action/);
        });

        // The bound is what the CHAIN can execute. This decoder mirrors the
        // authoritative one, so an OP_RETURN it cannot read is one no action comes
        // out of: the transaction publishes nothing, which is a wasted fee and not a
        // substituted command. Widening the gate to those would make it a second
        // opinion about the encoder's framing rather than a fund-safety check.
        it('lets an unreadable OP_RETURN through, because the chain reads no action from it either', function () {
            expect(bind({ psbt: inlinePsbt(null, { decoy: true }), actionString: SEND_A, encoding: 'OP_RETURN' }))
                .to.not.throw();
            expect(bind({ psbt: inlinePsbt(null), actionString: SEND_A, encoding: 'OP_RETURN' })).to.not.throw();
        });

        it('skips the P2SH/P2WSH reveal tag, which carries a marker and no params', function () {
            expect(bind({ psbt: tagPsbt('p2sh'), actionString: SEND_A })).to.not.throw();
            expect(bind({ psbt: tagPsbt('p2wsh'), actionString: SEND_A })).to.not.throw();
        });

        it('skips a lane that emits no OP_RETURN at all (MULTISIGN, chunk funding, commit)', function () {
            const psbt = new bitcoin.Psbt({ network: NET });
            psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
            psbt.addOutput({ script: OWN, value: 90000 });
            expect(bind({ psbt, actionString: SEND_A, encoding: 'MULTISIGN' })).to.not.throw();
        });
    });

    // Transparent FILE compression is ON by default at the encoder, and it rewrites
    // the action string it is handed. A byte-equality rule with no tolerance for it
    // would deny every compressed FILE: fail-closed, but a break of a shipped lane
    // rather than a safety property.
    describe('the one rewrite the encoder is allowed to make', function () {
        const FILE_RAW = 'FILE|0|report.bin|application/octet-stream';
        const FILE_COMPRESSED = 'FILE|0|report.bin|application/octet-stream|||||||1';

        it('accepts a FILE whose COMPRESSION field the encoder set', function () {
            expect(bind({ psbt: inlinePsbt(FILE_COMPRESSED), actionString: FILE_RAW, encoding: 'OP_RETURN' }))
                .to.not.throw();
        });

        it('still refuses a FILE whose OTHER fields moved under cover of it', function () {
            const tampered = 'FILE|0|payload.exe|application/octet-stream|||||||1';
            expect(bind({ psbt: inlinePsbt(tampered), actionString: FILE_RAW, encoding: 'OP_RETURN' }))
                .to.throw(/does not carry the action/);
        });

        it('grants no such tolerance to a SEND', function () {
            expect(bind({ psbt: inlinePsbt(SEND_A + '|1'), actionString: SEND_A, encoding: 'OP_RETURN' }))
                .to.throw(/does not carry the action/);
        });
    });

    // The chunk lanes carry the largest payloads in redeem scripts the PSBT holds
    // only the hashes of, so nothing PSBT-only can see them.
    ['P2SH', 'P2WSH'].forEach((encoding) => {
        describe(`the ${encoding} chunk lane`, function () {
            it('passes when the committed scripts reassemble to the submitted action', function () {
                const { psbt, carrierScripts } = chunkLane(SEND_A, encoding);
                expect(bind({ psbt, carrierScripts, actionString: SEND_A, encoding })).to.not.throw();
            });

            it('refuses scripts that reassemble to a different action', function () {
                const good = chunkLane(SEND_A, encoding);
                const forged = chunkLane(SEND_B, encoding);
                expect(bind({ psbt: good.psbt, carrierScripts: forged.carrierScripts, actionString: SEND_A, encoding }))
                    .to.throw(/does not carry the action/);
            });

            it('refuses a response that returns no carrier scripts, rather than passing unchecked', function () {
                const { psbt } = chunkLane(SEND_A, encoding);
                expect(bind({ psbt, carrierScripts: undefined, actionString: SEND_A, encoding }))
                    .to.throw(/does not carry the action/);
            });

            it('accepts the PSBT hex form the encoder actually answers in', function () {
                const { psbt, carrierScripts } = chunkLane(SEND_A, encoding);
                expect(bind({ psbt: psbt.toHex(), carrierScripts, actionString: SEND_A, encoding })).to.not.throw();
                const forged = chunkLane(SEND_B, encoding);
                expect(bind({ psbt: psbt.toHex(), carrierScripts: forged.carrierScripts, actionString: SEND_A, encoding }))
                    .to.throw(/does not carry the action/);
            });

            // A lane that emits no chunk output carries nothing for anyone to
            // substitute, and reconcileEncoded authorizes a shaped leg only on the
            // lane that declares one. The check follows the transaction, not the
            // label on the response.
            it('skips a response that declares the lane but emits no chunk output', function () {
                const psbt = new bitcoin.Psbt({ network: NET });
                psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 100000 } });
                psbt.addOutput({ script: OWN, value: 90000 });
                expect(bind({ psbt, carrierScripts: undefined, actionString: SEND_A, encoding })).to.not.throw();
            });
        });
    });

    describe('the Taproot envelope reveal', function () {
        it('passes when the leaf declares the submitted action', function () {
            const psbt = revealPsbt(envelopeLeaf(SEND_A, crypto.randomBytes(600)));
            expect(() => assertEnvelopeCarrierBinding({ revealPsbt: psbt, actionString: SEND_A })).to.not.throw();
        });

        it('refuses a leaf that declares a different one', function () {
            const psbt = revealPsbt(envelopeLeaf(SEND_B, crypto.randomBytes(600)));
            expect(() => assertEnvelopeCarrierBinding({ revealPsbt: psbt, actionString: SEND_A }))
                .to.throw(/does not carry the action/);
        });

        // create_tx answers in hex, and this is the form the lifecycle actually
        // hands over. Read as a bare string it looked like a PSBT with no inputs,
        // which would have denied every real reveal.
        it('reads the PSBT hex form the encoder answers in', function () {
            const good = revealPsbt(envelopeLeaf(SEND_A, crypto.randomBytes(600)));
            expect(() => assertEnvelopeCarrierBinding({ revealPsbt: good.toHex(), actionString: SEND_A }))
                .to.not.throw();
            const bad = revealPsbt(envelopeLeaf(SEND_B, crypto.randomBytes(600)));
            expect(() => assertEnvelopeCarrierBinding({ revealPsbt: bad.toHex(), actionString: SEND_A }))
                .to.throw(/does not carry the action/);
        });

        it('refuses a reveal whose envelope cannot be read at all', function () {
            const psbt = new bitcoin.Psbt({ network: NET });
            psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: OWN, value: 20000 } });
            psbt.addOutput({ script: OWN, value: 15000 });
            expect(() => assertEnvelopeCarrierBinding({ revealPsbt: psbt, actionString: SEND_A }))
                .to.throw(/does not carry the action/);
        });
    });

    it('refuses to run at all without the caller\'s action string', function () {
        expect(bind({ psbt: inlinePsbt(SEND_A), actionString: undefined, encoding: 'OP_RETURN' }))
            .to.throw(/without the caller/);
    });
});
