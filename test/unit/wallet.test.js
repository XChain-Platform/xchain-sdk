const { expect } = require('chai');
const nock = require('nock');
const bitcoin = require('bitcoinjs-lib');
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
    });
});
