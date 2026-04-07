const { expect } = require('chai');
const nock = require('nock');
const WalletUtils = require('../../src/wallet.js');

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
