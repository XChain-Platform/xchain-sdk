// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../src/utils/wallet.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

// Helper: build an unsigned PSBT with the given inputs/outputs.
// Inputs use witnessUtxo for segwit types and nonWitnessUtxo for
// legacy types; the test constructs a minimal valid previous
// transaction for each input so the PSBT parses.
function buildTestPsbt(network, inputs, outputs) {
    const psbt = new bitcoin.Psbt({ network });
    for (const inp of inputs) {
        const prevTx = new bitcoin.Transaction();
        prevTx.version = 2;
        // A single dummy coinbase-style input is enough for the
        // prev-tx to serialize; we only care about its outputs.
        prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
        prevTx.addOutput(inp.prevOutScript, inp.value);
        const prevTxBuf = prevTx.toBuffer();
        const prevTxId = prevTx.getId();

        const addInput = {
            hash: prevTxId,
            index: 0,
            sequence: 0xfffffffd,
        };
        if (inp.useWitnessUtxo) {
            addInput.witnessUtxo = { script: inp.prevOutScript, value: inp.value };
        } else {
            addInput.nonWitnessUtxo = prevTxBuf;
        }
        if (inp.redeemScript) addInput.redeemScript = inp.redeemScript;
        if (inp.witnessScript) addInput.witnessScript = inp.witnessScript;
        psbt.addInput(addInput);
    }
    for (const out of outputs) {
        psbt.addOutput({ script: out.script, value: out.value });
    }
    return psbt.toHex();
}

describe('WalletUtils', function() {

    describe('decomposePsbt()', function() {
        it('should throw on missing PSBT', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.decomposePsbt('')).to.throw(/PSBT hex string is required/);
            expect(() => wallet.decomposePsbt(null)).to.throw(/PSBT hex string is required/);
        });

        it('should throw INVALID_PSBT on non-PSBT hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.decomposePsbt('deadbeef')).to.throw(/Failed to parse PSBT/);
        });

        it('#3922: a >2^53 satoshi value survives decomposition exactly, as a decimal string', function() {
            // applyBufferutilsPatch hands these back as BigInt; Number() rounded them
            // straight into the hardware-signer envelope. Values at or below 2^53-1 keep
            // their Number type (asserted by every other case in this describe).
            const wallet = new WalletUtils('dogecoin-mainnet');
            const net = getNetwork('dogecoin-mainnet');
            const kp = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const outputScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

            const IN  = 9007199254740993n;   // 2^53 + 1: the first value a double cannot hold
            const OUT = 9007199254740991n;
            const psbtHex = buildTestPsbt(net, [
                { prevOutScript: inputScript, value: IN, useWitnessUtxo: true },
            ], [
                { script: outputScript, value: OUT },
            ]);

            const decomposed = wallet.decomposePsbt(psbtHex);
            expect(decomposed.inputs[0].value).to.equal('9007199254740993');
            expect(BigInt(decomposed.inputs[0].value)).to.equal(IN);
            // OUT is exactly representable, so it stays on the Number fast path.
            expect(decomposed.outputs[0].value).to.equal(9007199254740991);
        });
    });
});

describe('WalletUtils', function() {

    describe('decomposePsbt()', function() {
        it('#3922: serializePrevTx carries a >2^53 prev-output amount without rounding', function() {
            const wallet = new WalletUtils('dogecoin-mainnet');
            const net = getNetwork('dogecoin-mainnet');
            const kp = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const outputScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

            const psbtHex = buildTestPsbt(net, [
                { prevOutScript: inputScript, value: 9007199254740993n, useWitnessUtxo: false },
            ], [
                { script: outputScript, value: 1000 },
            ]);

            const decomposed = wallet.decomposePsbt(psbtHex);
            const prevTxInfo = decomposed.inputs[0].prevTxInfo;
            expect(prevTxInfo.bin_outputs[0].amount).to.equal('9007199254740993');
            expect(decomposed.inputs[0].value).to.equal('9007199254740993');
        });

        it('should decompose a P2WPKH PSBT (bitcoin-regtest)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const outputScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

            const psbtHex = buildTestPsbt(net, [
                { prevOutScript: inputScript, value: 100_000, useWitnessUtxo: true },
            ], [
                { script: outputScript, value: 90_000 },
            ]);

            const decomposed = wallet.decomposePsbt(psbtHex);
            expect(decomposed.network).to.equal('bitcoin-regtest');
            expect(decomposed.inputs).to.have.lengthOf(1);
            expect(decomposed.outputs).to.have.lengthOf(1);

            const inp = decomposed.inputs[0];
            expect(inp.scriptType).to.equal('p2wpkh');
            expect(inp.value).to.equal(100_000);
            expect(inp.witnessUtxoScriptHex).to.equal(inputScript.toString('hex'));
            expect(inp.nonWitnessUtxoHex).to.be.null;
            expect(inp.address).to.be.a('string').that.matches(/^bcrt1q/);
            expect(inp.prevTxHash).to.be.a('string').of.length(64);
            expect(inp.prevTxIndex).to.equal(0);
            expect(inp.sequence).to.equal(0xfffffffd);

            const out = decomposed.outputs[0];
            expect(out.scriptType).to.equal('p2wpkh');
            expect(out.value).to.equal(90_000);
            expect(out.address).to.match(/^bcrt1q/);
        });
    });
});

describe('WalletUtils', function() {

    describe('decomposePsbt()', function() {
        // A PSBT may legally carry BOTH fields for a segwit input, and
        // the encoder does exactly that on request, because a hardware
        // signer cannot sign without the full previous transaction: Ledger
        // takes the outpoint it signs from those bytes rather than from the
        // PSBT's own txid. That branch was an else-if, so the prev tx was
        // silently dropped whenever a witnessUtxo was present - which read from
        // the outside as "the PSBT does not have one".
        it('should report the prev tx for a segwit input carrying BOTH utxo fields', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const outputScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.version = 2;
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 100_000);
            psbt.addInput({
                hash: prevTx.getId(),
                index: 0,
                sequence: 0xfffffffd,
                witnessUtxo: { script: inputScript, value: 100_000 },
                nonWitnessUtxo: prevTx.toBuffer(),
            });
            psbt.addOutput({ script: outputScript, value: 90_000 });

            const inp = wallet.decomposePsbt(psbt.toHex()).inputs[0];
            // Both are reported. Value and script still come from the
            // witnessUtxo, so nothing that already worked changes.
            expect(inp.witnessUtxoScriptHex).to.equal(inputScript.toString('hex'));
            expect(inp.nonWitnessUtxoHex).to.equal(prevTx.toBuffer().toString('hex'));
            expect(inp.value).to.equal(100_000);
            expect(inp.scriptType).to.equal('p2wpkh');
            // And the parsed form, which is what the Trezor code path reads. It is
            // gated on p2pkh there, so this is inert for that signer rather
            // than a behaviour change to it.
            expect(inp.prevTxInfo).to.be.an('object');
            expect(inp.prevTxInfo.hash).to.equal(prevTx.getId());
        });
    });
});

describe('WalletUtils', function() {

    describe('decomposePsbt()', function() {
        it('should decompose a P2PKH PSBT (dogecoin-regtest)', function() {
            const wallet = new WalletUtils('dogecoin-regtest');
            const net = getNetwork('dogecoin-regtest');
            const kp = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: net }).output;
            const outputScript = bitcoin.payments.p2pkh({ pubkey: recipient.publicKey, network: net }).output;

            const psbtHex = buildTestPsbt(net, [
                { prevOutScript: inputScript, value: 500_000, useWitnessUtxo: false },
            ], [
                { script: outputScript, value: 480_000 },
            ]);

            const decomposed = wallet.decomposePsbt(psbtHex);
            const inp = decomposed.inputs[0];
            expect(inp.scriptType).to.equal('p2pkh');
            expect(inp.value).to.equal(500_000);
            expect(inp.witnessUtxoScriptHex).to.be.null;
            expect(inp.nonWitnessUtxoHex).to.be.a('string').that.has.length.greaterThan(0);

            // prevTxInfo is populated for nonWitnessUtxo cases so
            // Trezor's refTxs + Ledger's prev-tx input arguments can be
            // constructed without bitcoinjs-lib in the wallet.
            expect(inp.prevTxInfo).to.be.an('object');
            expect(inp.prevTxInfo.hash).to.be.a('string').of.length(64);
            expect(inp.prevTxInfo.version).to.be.a('number');
            expect(inp.prevTxInfo.bin_outputs).to.be.an('array').with.lengthOf(1);
            expect(inp.prevTxInfo.bin_outputs[0].amount).to.equal('500000');
            expect(inp.prevTxInfo.bin_outputs[0].script_pubkey)
                .to.equal(inputScript.toString('hex'));
            expect(inp.prevTxInfo.inputs).to.be.an('array').with.lengthOf(1);

            const out = decomposed.outputs[0];
            expect(out.scriptType).to.equal('p2pkh');
            expect(out.value).to.equal(480_000);
        });
    });
});

describe('WalletUtils', function() {

    describe('decomposePsbt()', function() {
        it('should decompose a P2SH-P2WPKH PSBT (nested segwit)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const p2wpkhRedeem = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net });
            const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkhRedeem, network: net });

            const psbtHex = buildTestPsbt(net, [
                {
                    prevOutScript: p2sh.output,
                    value: 200_000,
                    useWitnessUtxo: true,
                    redeemScript: p2wpkhRedeem.output,
                },
            ], [
                { script: p2sh.output, value: 190_000 },
            ]);

            const decomposed = wallet.decomposePsbt(psbtHex);
            const inp = decomposed.inputs[0];
            expect(inp.scriptType).to.equal('p2sh-p2wpkh');
            expect(inp.redeemScriptHex).to.equal(p2wpkhRedeem.output.toString('hex'));
            expect(inp.value).to.equal(200_000);
        });
    });
});

describe('WalletUtils', function() {

    describe('decomposePsbt()', function() {
        it('should decompose a multi-input, multi-output PSBT', function() {
            const wallet = new WalletUtils('litecoin-regtest');
            const net = getNetwork('litecoin-regtest');
            const kpA = wallet.generateKeyPair();
            const kpB = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const scriptA = bitcoin.payments.p2wpkh({ pubkey: kpA.publicKey, network: net }).output;
            const scriptB = bitcoin.payments.p2wpkh({ pubkey: kpB.publicKey, network: net }).output;
            const outScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

            const psbtHex = buildTestPsbt(net, [
                { prevOutScript: scriptA, value: 300_000, useWitnessUtxo: true },
                { prevOutScript: scriptB, value: 150_000, useWitnessUtxo: true },
            ], [
                { script: outScript, value: 100_000 },
                { script: outScript, value: 340_000 },
            ]);

            const decomposed = wallet.decomposePsbt(psbtHex);
            expect(decomposed.inputs).to.have.lengthOf(2);
            expect(decomposed.outputs).to.have.lengthOf(2);
            expect(decomposed.inputs[0].value).to.equal(300_000);
            expect(decomposed.inputs[1].value).to.equal(150_000);
            expect(decomposed.outputs.reduce((s, o) => s + o.value, 0)).to.equal(440_000);
            for (const inp of decomposed.inputs) expect(inp.scriptType).to.equal('p2wpkh');
        });

        it('should expose sequence + locktime + version', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;

            const psbtHex = buildTestPsbt(net, [
                { prevOutScript: script, value: 10_000, useWitnessUtxo: true },
            ], [
                { script, value: 9_000 },
            ]);

            const decomposed = wallet.decomposePsbt(psbtHex);
            expect(decomposed.txVersion).to.be.a('number');
            expect(decomposed.locktime).to.be.a('number');
            expect(decomposed.inputs[0].sequence).to.equal(0xfffffffd);
        });
    });
});
