// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai');
const nock = require('nock');
const sinon = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const WalletUtils = require('../../src/wallet.js');
const { getNetwork } = require('../../src/networks.js');

describe('WalletUtils', function() {

    const NETWORKS = ['bitcoin-regtest', 'litecoin-regtest', 'dogecoin-regtest'];

    describe('generateKeyPair()', function() {
        for (const network of NETWORKS) {
            it(`should generate a keypair on ${network}`, function() {
                const wallet = new WalletUtils(network);
                const kp = wallet.generateKeyPair();
                expect(kp).to.have.property('wif').that.is.a('string');
                expect(kp).to.have.property('privateKey');
                expect(kp).to.have.property('publicKey');
                expect(kp).to.have.property('publicKeyHex').that.is.a('string');
                expect(kp).to.have.property('compressed', true);
                expect(kp.publicKey).to.have.lengthOf(33); // compressed
            });
        }

        it('should generate uncompressed keypair when requested', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair({ compressed: false });
            expect(kp.compressed).to.be.false;
            expect(kp.publicKey).to.have.lengthOf(65);
        });

        it('should throw without network configured', function() {
            const wallet = new WalletUtils();
            expect(() => wallet.generateKeyPair()).to.throw(/Network not configured/);
        });
    });

    describe('importWIF()', function() {
        it('should import a WIF and return key info', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const imported = wallet.importWIF(kp.wif);
            expect(imported.wif).to.equal(kp.wif);
            expect(imported.publicKeyHex).to.equal(kp.publicKeyHex);
        });

        it('should throw NETWORK_MISMATCH for wrong network WIF', function() {
            const btcWallet = new WalletUtils('bitcoin-regtest');
            const kp = btcWallet.generateKeyPair();

            const dogeWallet = new WalletUtils('dogecoin-mainnet');
            expect(() => dogeWallet.importWIF(kp.wif)).to.throw(/does not match configured network/);
        });

        it('should throw INVALID_WIF for garbage input', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.importWIF('not-a-wif')).to.throw();
        });

        it('should throw on missing WIF', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.importWIF('')).to.throw(/WIF string is required/);
        });
    });

    describe('deriveAddress()', function() {
        it('should derive P2PKH address by default', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);
            expect(address).to.be.a('string');
            // Bitcoin regtest P2PKH starts with m or n
            expect(address).to.match(/^[mn]/);
        });

        it('should derive P2WPKH (bech32) address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });
            expect(address).to.match(/^bcrt1q/);
        });

        it('should derive P2SH-P2WPKH address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey, { type: 'p2sh-p2wpkh' });
            expect(address).to.match(/^2/); // testnet/regtest P2SH
        });

        it('should accept hex string public key', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address1 = wallet.deriveAddress(kp.publicKey);
            const address2 = wallet.deriveAddress(kp.publicKeyHex);
            expect(address1).to.equal(address2);
        });

        it('should throw SEGWIT_NOT_SUPPORTED for dogecoin', function() {
            const wallet = new WalletUtils('dogecoin-regtest');
            const btcWallet = new WalletUtils('bitcoin-regtest');
            // Generate on BTC regtest (same WIF byte as DOGE testnet/regtest)
            const kp = btcWallet.generateKeyPair();
            expect(() => wallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' })).to.throw(/not supported/);
        });

        it('should throw on invalid public key', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveAddress('deadbeef')).to.throw(/Invalid public key length/);
            expect(() => wallet.deriveAddress(42)).to.throw(/must be a Buffer or hex string/);
        });

        it('should derive litecoin addresses', function() {
            const wallet = new WalletUtils('litecoin-regtest');
            const kp = wallet.generateKeyPair();
            const p2pkh = wallet.deriveAddress(kp.publicKey);
            const p2wpkh = wallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });
            expect(p2pkh).to.be.a('string');
            expect(p2wpkh).to.match(/^rltc1q/);
        });
    });

    describe('validateAddress()', function() {
        it('should validate a bitcoin regtest P2PKH address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey);
            const result = wallet.validateAddress(address);
            expect(result.valid).to.be.true;
            expect(result.type).to.equal('p2pkh');
            expect(result.network).to.equal('bitcoin-regtest');
        });

        it('should validate a bech32 address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const address = wallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });
            const result = wallet.validateAddress(address);
            expect(result.valid).to.be.true;
            expect(result.type).to.equal('p2wpkh');
        });

        it('should return valid:false for invalid address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const result = wallet.validateAddress('not-an-address');
            expect(result.valid).to.be.false;
            expect(result.error).to.be.a('string');
        });

        it('should return valid:false for empty input', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(wallet.validateAddress('').valid).to.be.false;
            expect(wallet.validateAddress(null).valid).to.be.false;
        });

        it('should accept network override', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const ltcWallet = new WalletUtils('litecoin-regtest');
            const kp = ltcWallet.generateKeyPair();
            const ltcAddr = ltcWallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });

            // Validate a litecoin address against litecoin network from a bitcoin-configured wallet
            const result = wallet.validateAddress(ltcAddr, 'litecoin-regtest');
            expect(result.valid).to.be.true;
            expect(result.network).to.equal('litecoin-regtest');
        });

        it('should check all networks when none configured', function() {
            const wallet = new WalletUtils();
            const btcWallet = new WalletUtils('bitcoin-regtest');
            const kp = btcWallet.generateKeyPair();
            const address = btcWallet.deriveAddress(kp.publicKey, { type: 'p2wpkh' });

            const result = wallet.validateAddress(address);
            expect(result.valid).to.be.true;
            expect(result.network).to.equal('bitcoin-regtest');
        });
    });

    describe('signPsbt()', function() {
        it('should throw on missing PSBT', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signPsbt('', 'wif')).to.throw(/PSBT hex string is required/);
        });

        it('should throw on missing WIF', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signPsbt('deadbeef', '')).to.throw(/WIF private key is required/);
        });

        it('should throw INVALID_PSBT on non-PSBT hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.signPsbt('deadbeef', kp.wif)).to.throw(/Failed to parse PSBT/);
        });
    });

    describe('decomposePsbt()', function() {

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

        it('should throw on missing PSBT', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.decomposePsbt('')).to.throw(/PSBT hex string is required/);
            expect(() => wallet.decomposePsbt(null)).to.throw(/PSBT hex string is required/);
        });

        it('should throw INVALID_PSBT on non-PSBT hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.decomposePsbt('deadbeef')).to.throw(/Failed to parse PSBT/);
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

            // prevTxInfo is populated for nonWitnessUtxo lanes so
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

    describe('broadcastTx()', function() {
        it('should throw without encoder', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.broadcastTx('aabbcc', null);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('ENCODER_REQUIRED');
            }
        });

        it('should throw on empty txHex', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.broadcastTx('', {});
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('INVALID_TX_HEX');
            }
        });
    });

    describe('getUTXOs()', function() {
        afterEach(() => sinon.restore());

        it('should throw without encoder', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.getUTXOs('addr', null);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('ENCODER_REQUIRED');
            }
        });

        it('should throw on empty address', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.getUTXOs('', {});
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('INVALID_ADDRESS');
            }
        });

        it('should return utxos array from encoder.getUTXOs({utxos:[...]})', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { getUTXOs: async () => ({ utxos: [{ txid: 'abc', vout: 0, value: 1000 }] }) };
            const result = await wallet.getUTXOs('mTestAddr', encoder);
            expect(result).to.be.an('array').with.lengthOf(1);
            expect(result[0].txid).to.equal('abc');
        });

        it('should return raw array when encoder.getUTXOs returns array directly', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { getUTXOs: async () => [{ txid: 'xyz', vout: 1, value: 500 }] };
            const result = await wallet.getUTXOs('mTestAddr', encoder);
            expect(result).to.be.an('array').with.lengthOf(1);
            expect(result[0].txid).to.equal('xyz');
        });

        it('should wrap non-SDK errors as UTXO_FETCH_FAILED', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { getUTXOs: async () => { throw new Error('network error'); } };
            try {
                await wallet.getUTXOs('mTestAddr', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('UTXO_FETCH_FAILED');
            }
        });

        it('should re-throw SDK errors from encoder.getUTXOs', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const { SDKWalletError } = require('../../src/errors.js');
            const sdkErr = new SDKWalletError('SOME_CODE', 'sdk error');
            const encoder = { getUTXOs: async () => { throw sdkErr; } };
            try {
                await wallet.getUTXOs('mTestAddr', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('SOME_CODE');
            }
        });
    });

    describe('broadcastTx() — success and error paths', function() {
        afterEach(() => sinon.restore());

        it('should return txid from encoder.broadcastTx', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { broadcastTx: async (hex) => ({ txid: 'deadbeef1234' }) };
            const result = await wallet.broadcastTx('aabbcc', encoder);
            expect(result.txid).to.equal('deadbeef1234');
        });

        it('should wrap non-SDK errors as BROADCAST_FAILED', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { broadcastTx: async () => { throw new Error('mempool full'); } };
            try {
                await wallet.broadcastTx('aabbcc', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('BROADCAST_FAILED');
            }
        });

        it('should re-throw SDK errors from encoder.broadcastTx', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const { SDKWalletError } = require('../../src/errors.js');
            const sdkErr = new SDKWalletError('SOME_BROADCAST_ERR', 'sdk-level error');
            const encoder = { broadcastTx: async () => { throw sdkErr; } };
            try {
                await wallet.broadcastTx('aabbcc', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('SOME_BROADCAST_ERR');
            }
        });
    });

    describe('signEcdsa()', function() {
        it('should return a DER-encoded signature for valid inputs', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            // secretKey is kp.privateKey (Buffer → Uint8Array view)
            const secretKey = new Uint8Array(kp.privateKey);
            const msgHash = new Uint8Array(32).fill(0xab);
            const sig = wallet.signEcdsa(msgHash, secretKey);
            expect(sig).to.be.instanceof(Uint8Array);
            // DER signature starts with 0x30
            expect(sig[0]).to.equal(0x30);
            // Length byte at sig[1] should cover the rest
            expect(sig.length).to.equal(sig[1] + 2);
        });

        it('should throw INVALID_INPUT for wrong msgHash type (string)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Pass a plain string (not a Uint8Array) — the instanceof check fires
            expect(() => wallet.signEcdsa('notauint8array', new Uint8Array(32))).to.throw(/msgHash must be a 32-byte Uint8Array/);
        });

        it('should throw INVALID_INPUT for wrong msgHash length', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const secretKey = new Uint8Array(32).fill(1);
            expect(() => wallet.signEcdsa(new Uint8Array(16), secretKey)).to.throw(/msgHash must be a 32-byte Uint8Array/);
        });

        it('should throw INVALID_INPUT for wrong secretKey type (string)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Valid msgHash (Uint8Array, 32 bytes), but secretKey is a plain string
            expect(() => wallet.signEcdsa(new Uint8Array(32), 'notauint8array')).to.throw(/secretKey must be a 32-byte Uint8Array/);
        });

        it('should throw INVALID_INPUT for wrong secretKey length', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signEcdsa(new Uint8Array(32), new Uint8Array(16))).to.throw(/secretKey must be a 32-byte Uint8Array/);
        });

        it('should throw INVALID_INPUT for invalid secp256k1 scalar (zero key)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const badKey = new Uint8Array(32); // all zeros — invalid scalar
            expect(() => wallet.signEcdsa(new Uint8Array(32), badKey)).to.throw(/not a valid secp256k1 scalar/);
        });

        it('should produce consistent DER structure across varying r/s magnitudes', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Use a known-valid key
            const kp = wallet.generateKeyPair();
            const secretKey = new Uint8Array(kp.privateKey);
            // Sign 10 different messages; all should parse as valid DER
            for (let i = 0; i < 10; i++) {
                const msgHash = new Uint8Array(32).fill(i + 1);
                const sig = wallet.signEcdsa(msgHash, secretKey);
                expect(sig[0]).to.equal(0x30); // SEQUENCE
                expect(sig[2]).to.equal(0x02); // INTEGER for r
                const rLen = sig[3];
                expect(sig[4 + rLen]).to.equal(0x02); // INTEGER for s
            }
        });
    });

    describe('deriveMultisigAddress()', function() {
        it('should throw without params', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress(null)).to.throw(/params required/);
        });

        it('should throw with empty scriptTemplate', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({ scriptTemplate: '', scheme: 'p2sh-multisig' })).to.throw(/scriptTemplate must be a non-empty string/);
        });

        it('should throw for unknown scheme', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({ scriptTemplate: 'multi:1:03abc', scheme: 'unknown' })).to.throw(/scheme must be one of/);
        });

        it('should derive p2sh-multisig address for 2-of-3', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp1 = wallet.generateKeyPair();
            const kp2 = wallet.generateKeyPair();
            const kp3 = wallet.generateKeyPair();
            const template = `multi:2:${kp1.publicKeyHex}:${kp2.publicKeyHex}:${kp3.publicKeyHex}`;
            const result = wallet.deriveMultisigAddress({ scriptTemplate: template, scheme: 'p2sh-multisig' });
            expect(result.address).to.be.a('string');
            expect(result.scheme).to.equal('p2sh-multisig');
            expect(result.redeemScript).to.be.a('string');
            expect(result.witnessScript).to.be.null;
            expect(result.outputPubkey).to.be.null;
        });

        it('should derive p2wsh-multisig address for 1-of-2', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp1 = wallet.generateKeyPair();
            const kp2 = wallet.generateKeyPair();
            const template = `multi:1:${kp1.publicKeyHex}:${kp2.publicKeyHex}`;
            const result = wallet.deriveMultisigAddress({ scriptTemplate: template, scheme: 'p2wsh-multisig' });
            expect(result.address).to.be.a('string').that.matches(/^bcrt1q/);
            expect(result.scheme).to.equal('p2wsh-multisig');
            expect(result.witnessScript).to.be.a('string');
            expect(result.redeemScript).to.be.null;
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for bad multi: format', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: 'bad:format', scheme: 'p2sh-multisig'
            })).to.throw(/scriptTemplate must look like/);
        });

        it('should throw INVALID_SCRIPT_TEMPLATE when threshold > cosigner count', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `multi:3:${kp.publicKeyHex}:${kp.publicKeyHex}`,
                scheme: 'p2sh-multisig'
            })).to.throw(/threshold .* exceeds cosigner/);
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for non-integer threshold', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            // Need 4+ parts: multi:<threshold>:<pk1>:<pk2>
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `multi:abc:${kp.publicKeyHex}:${kp.publicKeyHex}`,
                scheme: 'p2sh-multisig'
            })).to.throw(/threshold .* must be a positive integer/);
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for uncompressed pubkey in multisig template', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // 65-byte (130 hex chars) uncompressed pubkey — need at least 4 parts
            const validKp = wallet.generateKeyPair();
            const badPubkey = '04' + 'ab'.repeat(64);
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `multi:1:${badPubkey}:${validKp.publicKeyHex}`,
                scheme: 'p2sh-multisig'
            })).to.throw(/must be 33 bytes compressed/);
        });

        it('should derive taproot-musig2 address', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Derive a valid x-only pubkey by stripping the prefix byte from a
            // compressed secp256k1 public key. This guarantees the x-coordinate
            // is on the curve and P2TR derivation succeeds.
            const kp = wallet.generateKeyPair();
            // compressed pubkey = 33 bytes: [02|03] + x (32 bytes)
            const xonly = kp.publicKey.slice(1).toString('hex'); // 32 bytes → 64 hex chars
            const result = wallet.deriveMultisigAddress({
                scriptTemplate: `musig2:${xonly}`,
                scheme: 'taproot-musig2'
            });
            expect(result.address).to.be.a('string');
            expect(result.scheme).to.equal('taproot-musig2');
            expect(result.outputPubkey).to.equal(xonly.toLowerCase());
            expect(result.redeemScript).to.be.null;
            expect(result.witnessScript).to.be.null;
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for bad musig2 template format', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: 'musig2:notvalidhex!!!',
                scheme: 'taproot-musig2'
            })).to.throw(/taproot-musig2 scriptTemplate must look like/);
        });

        it('should throw INVALID_SCRIPT_TEMPLATE for musig2 with wrong pubkey length', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // 16 bytes — too short
            const shortXOnly = 'deadbeef'.repeat(4);
            expect(() => wallet.deriveMultisigAddress({
                scriptTemplate: `musig2:${shortXOnly}`,
                scheme: 'taproot-musig2'
            })).to.throw(/aggregated x-only pubkey must be 32 bytes/);
        });

        it('should support network override via params.network', function() {
            // No instance network, but pass network via params
            const wallet = new WalletUtils();
            const kp1 = new WalletUtils('bitcoin-regtest').generateKeyPair();
            const kp2 = new WalletUtils('bitcoin-regtest').generateKeyPair();
            const template = `multi:1:${kp1.publicKeyHex}:${kp2.publicKeyHex}`;
            const result = wallet.deriveMultisigAddress({
                scriptTemplate: template,
                scheme: 'p2sh-multisig',
                network: 'bitcoin-regtest'
            });
            expect(result.address).to.be.a('string');
        });
    });

    describe('txidOf()', function() {
        it('should throw on empty input', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.txidOf('')).to.throw(/Transaction hex string is required/);
            expect(() => wallet.txidOf(null)).to.throw(/Transaction hex string is required/);
        });

        it('should throw on invalid hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.txidOf('not-hex-at-all')).to.throw(/Failed to parse transaction/);
        });

        it('should return a 64-char txid for a valid signed transaction', function() {
            // Build and sign a minimal P2WPKH transaction via signPsbt
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
            const prevTxId = prevTx.getId();

            psbt.addInput({
                hash: prevTxId,
                index: 0,
                sequence: 0xfffffffd,
                witnessUtxo: { script: inputScript, value: 100_000 }
            });
            psbt.addOutput({ script: outputScript, value: 90_000 });
            const psbtHex = psbt.toHex();
            const signed = wallet.signPsbt(psbtHex, kp.wif);

            const txid = wallet.txidOf(signed.txHex);
            expect(txid).to.be.a('string').of.length(64);
            expect(txid).to.equal(signed.txid);
        });
    });

    describe('signMultisigPsbt() and finalizeMultisigPsbt()', function() {
        it('should throw on missing PSBT or WIF in signMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signMultisigPsbt('', 'wif')).to.throw(/PSBT hex is required/);
            expect(() => wallet.signMultisigPsbt('abc', '')).to.throw(/WIF is required/);
        });

        it('should throw on invalid PSBT in signMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.signMultisigPsbt('deadbeef', kp.wif)).to.throw(/Failed to parse PSBT/);
        });

        it('should throw on bad WIF in signMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 1000);
            psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 1000 } });
            psbt.addOutput({ script: inputScript, value: 900 });
            expect(() => wallet.signMultisigPsbt(psbt.toHex(), 'not-a-wif')).to.throw(/Failed to import WIF/);
        });

        it('should throw on missing PSBT in finalizeMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.finalizeMultisigPsbt('')).to.throw(/PSBT hex is required/);
        });

        it('should throw on invalid PSBT in finalizeMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.finalizeMultisigPsbt('deadbeef')).to.throw(/Failed to parse PSBT/);
        });

        it('sign + finalize completes a 1-of-1 p2wpkh PSBT', function() {
            // Build a single-key P2WPKH PSBT, sign with signPsbt — exercise finalize path
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 50_000);
            psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 50_000 } });
            psbt.addOutput({ script: inputScript, value: 49_000 });
            const psbtHex = psbt.toHex();
            // signMultisigPsbt adds partial sig but doesn't finalize
            const partial = wallet.signMultisigPsbt(psbtHex, kp.wif);
            expect(partial.psbtHex).to.be.a('string');
            // finalizeMultisigPsbt finalizes it
            const finalized = wallet.finalizeMultisigPsbt(partial.psbtHex);
            expect(finalized.txHex).to.be.a('string');
            expect(finalized.txid).to.be.a('string').of.length(64);
            expect(finalized.psbtHex).to.be.a('string');
        });
    });

    describe('validateAddress() — extended', function() {
        it('should validate a P2SH address on bitcoin-regtest', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const p2sh = wallet.deriveAddress(kp.publicKey, { type: 'p2sh-p2wpkh' });
            const result = wallet.validateAddress(p2sh);
            expect(result.valid).to.be.true;
            expect(result.type).to.equal('p2sh');
        });

        it('should return unknown type for p2wsh address (32 byte data)', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp1 = wallet.generateKeyPair();
            const kp2 = wallet.generateKeyPair();
            // Build a P2WSH address from 1-of-2 multisig
            const result = wallet.deriveMultisigAddress({
                scriptTemplate: `multi:1:${kp1.publicKeyHex}:${kp2.publicKeyHex}`,
                scheme: 'p2wsh-multisig'
            });
            // validateAddress should recognize the bech32 / p2wsh
            const validation = wallet.validateAddress(result.address);
            expect(validation.valid).to.be.true;
            // type will be 'p2wsh' (32-byte bech32 data)
            expect(['p2wsh', 'bech32']).to.include(validation.type);
        });
    });

    describe('deriveAddress() — extended', function() {
        it('should throw INVALID_ADDRESS_TYPE for unknown type', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.deriveAddress(kp.publicKey, { type: 'p2tr' })).to.throw(/Unknown address type/);
        });
    });

    describe('signRevealPsbt()', function() {
        it('should throw on missing PSBT', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signRevealPsbt('', 'wif')).to.throw(/PSBT hex string is required/);
            expect(() => wallet.signRevealPsbt(null, 'wif')).to.throw(/PSBT hex string is required/);
        });

        it('should throw on missing WIF', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signRevealPsbt('deadbeef', '')).to.throw(/WIF private key is required/);
        });

        it('should throw INVALID_WIF on bad WIF', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Build a minimal valid PSBT so it parses, but the WIF is bad
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 1000);
            psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 1000 } });
            psbt.addOutput({ script: inputScript, value: 900 });
            expect(() => wallet.signRevealPsbt(psbt.toHex(), 'not-a-wif')).to.throw(/Failed to import WIF/);
        });

        it('should throw INVALID_PSBT on non-PSBT hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.signRevealPsbt('deadbeef01020304', kp.wif)).to.throw(/Failed to parse PSBT/);
        });

        it('should sign and finalize a P2SH reveal PSBT', function() {
            // Build a PSBT that simulates the XChain P2SH "reveal" pattern:
            // the redeem script is a simple non-standard 1-push script (OP_TRUE),
            // and bitcoinjs-lib's custom finalizer assembles the scriptSig.
            // To be signable, we use a P2PKH-style script that ECPair can sign.
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();

            // Build a minimal P2SH input whose redeem script is a simple
            // pay-to-pubkey so signAllInputs can produce a partialSig.
            const redeemScript = bitcoin.script.compile([
                kp.publicKey,
                bitcoin.opcodes.OP_CHECKSIG,
            ]);
            const p2sh = bitcoin.payments.p2sh({
                redeem: { output: redeemScript, network: net },
                network: net,
            });
            const inputScript = p2sh.output;

            // Create the prev-tx
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 50_000);

            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({
                hash:           prevTx.getId(),
                index:          0,
                sequence:       0xfffffffd,
                nonWitnessUtxo: prevTx.toBuffer(),
                redeemScript:   redeemScript,
            });
            psbt.addOutput({ script: inputScript, value: 49_000 });

            const result = wallet.signRevealPsbt(psbt.toHex(), kp.wif);
            expect(result.txHex).to.be.a('string');
            expect(result.txid).to.be.a('string').of.length(64);
            expect(result.psbtHex).to.be.a('string');
        });
    });

    describe('decomposePsbt() — OP_RETURN and missing UTXO paths', function() {
        it('should set address null for OP_RETURN output', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            // OP_RETURN output — cannot be converted to an address
            const opReturnScript = bitcoin.script.compile([
                bitcoin.opcodes.OP_RETURN,
                Buffer.from('58434841494e', 'hex'), // "XCHAIN" in hex
            ]);

            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 100_000);

            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({
                hash:         prevTx.getId(),
                index:        0,
                sequence:     0xfffffffd,
                witnessUtxo:  { script: inputScript, value: 100_000 },
            });
            // Add a real P2WPKH output + an OP_RETURN output
            psbt.addOutput({ script: inputScript, value: 90_000 });
            psbt.addOutput({ script: opReturnScript, value: 0 });

            const decomposed = wallet.decomposePsbt(psbt.toHex());
            expect(decomposed.outputs).to.have.lengthOf(2);
            // OP_RETURN output should have address=null
            const opReturnOut = decomposed.outputs[1];
            expect(opReturnOut.address).to.be.null;
            expect(opReturnOut.scriptType).to.equal('unknown');
        });
    });
});
