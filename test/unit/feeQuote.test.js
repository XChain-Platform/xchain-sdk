/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Native-coin fee quote tests
 *
 * Covers the client side of the native-coin fee pre-validation flow:
 *   - ExplorerClient.getFeeQuote / getFeeSchedule URL + query encoding
 *   - XChainSDK.quoteNativeFee (action/params split)
 *   - XChainSDK.estimateFees({ payFeeInNativeCoin }) output sizing + hard refusal
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../../src/explorer.js');
const { XChainSDK } = require('../../index.js');

describe('Native-coin fee quote (client)', function () {

    const BASE = 'http://explorer.test:8080';

    afterEach(function () { nock.cleanAll(); });

    describe('ExplorerClient', function () {
        let client;
        beforeEach(function () {
            client = new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'explorer.test', explorerPort: 8080, retry: false });
        });

        it('getFeeQuote hits /{COIN}/api/feequote with encoded action/params/source', async function () {
            nock(BASE).get('/RBTC/api/feequote')
                .query({ action: 'ISSUE', params: '0|NEWTICK', source: 'src1' })
                .reply(200, { supported: true, valid: true, requiredFeeSats: 2000, feeDestination: 'feeDest' });
            let q = await client.getFeeQuote({ action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src1' });
            expect(q).to.include({ supported: true, valid: true, requiredFeeSats: 2000 });
        });

        it('getFeeQuote accepts a pre-joined pipe string + feeOutputSats', async function () {
            nock(BASE).get('/RBTC/api/feequote')
                .query({ action: 'ISSUE', params: '0|NEWTICK', feeOutputSats: '1899' })
                .reply(200, { supported: true, valid: false, error: 'too small' });
            let q = await client.getFeeQuote({ action: 'ISSUE', params: '0|NEWTICK', feeOutputSats: 1899 });
            expect(q.valid).to.equal(false);
        });

        it('getFeeSchedule hits /{COIN}/api/feeschedule', async function () {
            nock(BASE).get('/RBTC/api/feeschedule').reply(200, { nativeFeeEnabled: true, feeDestination: 'feeDest' });
            let s = await client.getFeeSchedule();
            expect(s.nativeFeeEnabled).to.equal(true);
        });
    });

    describe('XChainSDK', function () {

        // A REAL encoder-shaped answer: one unsigned input, a zero-value carrier, and
        // change back to the funding script. estimateFees now runs the same fail-closed
        // reconcile gate submitAction does (), so a placeholder string is no
        // longer a usable stand-in for what the encoder returns.
        function estimatePsbtHex() {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const net = bitcoin.networks.regtest;
            const kp = ECPairFactory(ecc).makeRandom({ network: net });
            const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script, value: 100000 } });
            psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
            psbt.addOutput({ script, value: 99000 });
            return psbt.toHex();
        }

        function makeSdk(quote) {
            let sdk = new XChainSDK({ network: 'bitcoin-regtest' });
            sdk.explorer = {
                _seen: null,
                getFeeQuote: async function (args) { this._seen = args; return Object.assign({ supported: true, valid: true, requiredFeeSats: 2000, feeDestination: 'feeDest' }, quote || {}); }
            };
            sdk.encoder = {
                _seen: null,
                estimateFee: async function (params) { this._seen = params; return { fee: 1000, encoding: 'OP_RETURN', psbt: estimatePsbtHex() }; }
            };
            return sdk;
        }

        it('quoteNativeFee splits ACTION off the wire params', async function () {
            let sdk = makeSdk();
            let q = await sdk.quoteNativeFee({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { source: 'src1' });
            expect(sdk.explorer._seen.action).to.equal('ISSUE');
            expect(sdk.explorer._seen.params).to.be.an('array');
            expect(sdk.explorer._seen.params[0]).to.match(/^\d+$/); // leading VERSION/FORMAT, not the action name
            expect(sdk.explorer._seen.source).to.equal('src1');
            expect(q).to.have.property('actionString');
        });

        // : a client re-quoting a fee it composed earlier holds the exact bytes it is
        // about to broadcast. Re-deriving them from the form params it started with would price
        // a second, independently built action, so the same call takes the string directly.
        it('quoteNativeFee accepts an already-formatted action string', async function () {
            let sdk = makeSdk();
            let composed = sdk.actions.createAction({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } });
            let q = await sdk.quoteNativeFee(composed.actionString, { source: 'src1' });
            expect(sdk.explorer._seen.action).to.equal('ISSUE');
            expect(sdk.explorer._seen.params).to.deep.equal(composed.actionString.split('|').slice(1));
            expect(sdk.explorer._seen.source).to.equal('src1');
            expect(q.actionString).to.equal(composed.actionString);
        });

        it('quoteNativeFee asks the same question either way (string or actionData)', async function () {
            let fromData = makeSdk();
            let actionData = { action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } };
            await fromData.quoteNativeFee(actionData);
            let fromString = makeSdk();
            await fromString.quoteNativeFee(fromData.actions.createAction(actionData).actionString);
            expect(fromString.explorer._seen).to.deep.equal(fromData.explorer._seen);
        });

        it('estimateFees({ payFeeInNativeCoin }) adds a FEE_DESTINATION output sized to the quote', async function () {
            let sdk = makeSdk();
            let r = await sdk.estimateFees({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { payFeeInNativeCoin: true, pubkey: 'pk', change: 'src1' });
            let outs = sdk.encoder._seen.customOutputs;
            expect(outs).to.be.an('array').with.length(1);
            expect(outs[0]).to.deep.equal({ address: 'feeDest', value: 2000 });
            expect(r.nativeFeeQuote).to.include({ requiredFeeSats: 2000 });
        });

        it('estimateFees merges the native output with caller-supplied customOutputs', async function () {
            let sdk = makeSdk();
            await sdk.estimateFees({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } },
                { payFeeInNativeCoin: true, pubkey: 'pk', change: 'src1', customOutputs: [{ address: 'extra', value: 5 }] });
            let outs = sdk.encoder._seen.customOutputs;
            expect(outs).to.have.length(2);
            expect(outs.map(o => o.address)).to.have.members(['extra', 'feeDest']);
        });

        // : DEPLOY/EXECUTE are priced from the indexer's gas schedule with no VM dry-run, so
        // their quote is payable but carries NO verdict (valid:null). That must size the output
        // like any other quote: refusing anything short of valid:true would re-block the actions
        // on LTC/DOGE, where a native output is the only way to pay a protocol fee at all.
        it('estimateFees sizes the output from a verdict-free (valid:null) static quote', async function () {
            let sdk = makeSdk({ supported: true, valid: null, staticQuote: true, validated: false, requiredFeeSats: 1000100 });
            let r = await sdk.estimateFees({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } },
                { payFeeInNativeCoin: true, pubkey: 'pk', change: 'src1' });
            expect(sdk.encoder._seen.customOutputs).to.deep.equal([{ address: 'feeDest', value: 1000100 }]);
            expect(r.nativeFeeQuote.valid).to.equal(null);
            expect(r.nativeFeeQuote.staticQuote).to.equal(true);
        });

        it('estimateFees refuses (throws) when the quote is unsupported', async function () {
            let sdk = makeSdk({ supported: false, valid: false, error: 'not supported' });
            let threw = false;
            try { await sdk.estimateFees({ action: 'SEND', params: { tick: 'T', amount: '1', destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' } }, { payFeeInNativeCoin: true, pubkey: 'pk', change: 'src1' }); }
            catch (e) { threw = true; expect(e.code).to.equal('NATIVE_FEE_UNSUPPORTED'); }
            expect(threw, 'expected estimateFees to throw').to.equal(true);
        });

        it('estimateFees refuses (throws) when the oracle price is stale/invalid', async function () {
            let sdk = makeSdk({ supported: true, valid: false, error: 'no current oracle price for BTC/USD (missing or stale beyond 1800s)' });
            let threw = false;
            try { await sdk.estimateFees({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { payFeeInNativeCoin: true, pubkey: 'pk', change: 'src1' }); }
            catch (e) { threw = true; expect(e.code).to.equal('NATIVE_FEE_INVALID'); }
            expect(threw, 'expected estimateFees to throw').to.equal(true);
        });

        // Regression: a shared explorer that doesn't serve this coin can answer 200 with an
        // HTML page or an error envelope; neither is a quote, and silently treating it as one
        // built a doomed tx with no fee output (forfeits the fee on-chain).
        it('quoteNativeFee hard-fails on a non-JSON (HTML) explorer response', async function () {
            let sdk = makeSdk();
            sdk.explorer.getFeeQuote = async () => '<!DOCTYPE html><html><body>404</body></html>';
            let threw = false;
            try { await sdk.quoteNativeFee({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { source: 'src1' }); }
            catch (e) { threw = true; expect(e.code).to.equal('EXPLORER_BAD_FEEQUOTE'); }
            expect(threw, 'expected quoteNativeFee to throw').to.equal(true);
        });

        it('quoteNativeFee hard-fails on an error envelope without a supported flag', async function () {
            let sdk = makeSdk();
            sdk.explorer.getFeeQuote = async () => ({ error: 'indexer not ready' });
            let threw = false;
            try { await sdk.quoteNativeFee({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { source: 'src1' }); }
            catch (e) { threw = true; expect(e.code).to.equal('EXPLORER_BAD_FEEQUOTE'); expect(e.message).to.include('indexer not ready'); }
            expect(threw, 'expected quoteNativeFee to throw').to.equal(true);
        });

        it('estimateFees({ payFeeInNativeCoin }) propagates the malformed-quote refusal', async function () {
            let sdk = makeSdk();
            sdk.explorer.getFeeQuote = async () => null;
            let threw = false;
            try { await sdk.estimateFees({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { payFeeInNativeCoin: true, pubkey: 'pk', change: 'src1' }); }
            catch (e) { threw = true; expect(e.code).to.equal('EXPLORER_BAD_FEEQUOTE'); }
            expect(threw, 'expected estimateFees to throw').to.equal(true);
        });

        // The indexer admission cap answers busy:true, retryable:true under transient load;
        // quoteNativeFee retries once before callers surface a hard NATIVE_FEE_INVALID.
        it('quoteNativeFee retries once on a busy/retryable quote and returns the retry result', async function () {
            let sdk = makeSdk();
            let calls = 0;
            sdk.explorer.getFeeQuote = async () => (++calls === 1)
                ? { supported: true, valid: false, busy: true, retryable: true, error: 'fee quote busy' }
                : { supported: true, valid: true, requiredFeeSats: 2000, feeDestination: 'feeDest' };
            let q = await sdk.quoteNativeFee({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { source: 'src1', busyRetryDelayMs: 1 });
            expect(calls).to.equal(2);
            expect(q).to.include({ valid: true, requiredFeeSats: 2000 });
        });

        it('quoteNativeFee retries only once: a still-busy retry is returned as-is', async function () {
            let sdk = makeSdk();
            let calls = 0;
            sdk.explorer.getFeeQuote = async () => { calls++; return { supported: true, valid: false, busy: true, retryable: true, error: 'fee quote busy' }; };
            let q = await sdk.quoteNativeFee({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { source: 'src1', busyRetryDelayMs: 1 });
            expect(calls).to.equal(2);
            expect(q).to.include({ valid: false, busy: true, retryable: true });
        });

        it('quoteNativeFee does not retry a non-busy invalid quote', async function () {
            let sdk = makeSdk();
            let calls = 0;
            sdk.explorer.getFeeQuote = async () => { calls++; return { supported: true, valid: false, error: 'insufficient funds' }; };
            let q = await sdk.quoteNativeFee({ action: 'SEND', params: { tick: 'T', amount: '1', destination: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' } }, { source: 'src1', busyRetryDelayMs: 1 });
            expect(calls).to.equal(1);
            expect(q.valid).to.equal(false);
        });

        it('quoteNativeFee validates the retry response shape too', async function () {
            let sdk = makeSdk();
            let calls = 0;
            sdk.explorer.getFeeQuote = async () => (++calls === 1)
                ? { supported: true, valid: false, busy: true, retryable: true, error: 'fee quote busy' }
                : '<!DOCTYPE html><html><body>502</body></html>';
            let threw = false;
            try { await sdk.quoteNativeFee({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { source: 'src1', busyRetryDelayMs: 1 }); }
            catch (e) { threw = true; expect(e.code).to.equal('EXPLORER_BAD_FEEQUOTE'); }
            expect(threw, 'expected quoteNativeFee to throw').to.equal(true);
        });

        it('estimateFees without payFeeInNativeCoin adds no native output', async function () {
            let sdk = makeSdk();
            await sdk.estimateFees({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } }, { pubkey: 'pk', change: 'src1' });
            expect(sdk.encoder._seen.customOutputs).to.deep.equal([]);
        });
    });
});
