// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const CrossChainHelper = require('../../src/crossChain.js');

// Build a minimal stub SDK
function makeSdk(coin, overrides = {}) {
    return {
        coin,
        getBalances:    async (address, opts) => [{ tick: 'TOKEN', quantity: '100' }],
        waitForAction:  async (txid, opts) => ({ txid, status: 'confirmed' }),
        session: function(wif, opts) {
            return {
                swap:   async (params, enc, opts) => ({ submitted: true, action: 'SWAP', params }),
                link:   async (params, enc, opts) => ({ submitted: true, action: 'LINK', params }),
                submit: async (actionData, enc, opts) => ({ submitted: true, actionData }),
            };
        },
        ...overrides
    };
}

describe('CrossChainHelper', function () {

    /*
     *  Constructor
     */

    describe('constructor', function () {
        it('constructs with 2 SDKs', function () {
            let helper = new CrossChainHelper({ BTC: makeSdk('BTC'), LTC: makeSdk('LTC') });
            assert.ok(helper.sdks['BTC']);
            assert.ok(helper.sdks['LTC']);
        });

        it('uppercases keys', function () {
            let helper = new CrossChainHelper({ btc: makeSdk('BTC'), ltc: makeSdk('LTC') });
            assert.ok(helper.sdks['BTC']);
            assert.ok(helper.sdks['LTC']);
        });

        it('constructs with 3 SDKs', function () {
            let helper = new CrossChainHelper({
                BTC: makeSdk('BTC'),
                LTC: makeSdk('LTC'),
                DOGE: makeSdk('DOGE')
            });
            assert.strictEqual(Object.keys(helper.sdks).length, 3);
        });

        it('throws SDKConfigError when map has fewer than 2 entries', function () {
            try {
                new CrossChainHelper({ BTC: makeSdk('BTC') });
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
                assert.strictEqual(e.code, 'INVALID_SDK_MAP');
            }
        });

        it('throws SDKConfigError for null', function () {
            try {
                new CrossChainHelper(null);
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
            }
        });

        it('throws SDKConfigError for non-object', function () {
            try {
                new CrossChainHelper('BTC');
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
            }
        });

        it('throws SDKConfigError for empty object', function () {
            try {
                new CrossChainHelper({});
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
            }
        });
    });

    /*
     *  _requireSDK()
     */

    describe('_requireSDK()', function () {
        let helper;
        beforeEach(function () {
            helper = new CrossChainHelper({ BTC: makeSdk('BTC'), LTC: makeSdk('LTC') });
        });

        it('returns SDK for known chain', function () {
            let sdk = helper._requireSDK('BTC');
            assert.ok(sdk);
        });

        it('is case-insensitive (uppercases key)', function () {
            let sdk = helper._requireSDK('btc');
            assert.ok(sdk);
        });

        it('throws SDKConfigError for unknown chain', function () {
            try {
                helper._requireSDK('DOGE');
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
                assert.strictEqual(e.code, 'CHAIN_NOT_CONFIGURED');
                assert.ok(e.message.includes('DOGE'));
            }
        });
    });

    /*
     *  createSwap()
     */

    describe('createSwap()', function () {
        it('calls session.swap on the give chain', async function () {
            let capturedParams;
            let btcSdk = makeSdk('BTC');
            btcSdk.session = function(wif) {
                return {
                    swap: async (params) => { capturedParams = params; return { submitted: true }; }
                };
            };
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: makeSdk('LTC') });
            let result = await helper.createSwap({
                giveCoin: 'BTC', giveTick: 'XCHAIN', giveAmount: '100',
                getCoin: 'LTC', getTick: 'LCHAIN', getAmount: '200',
                wif: 'wif1'
            });
            assert.ok(result.swap);
            assert.strictEqual(capturedParams.giveTick, 'XCHAIN');
            assert.strictEqual(capturedParams.getTick, 'LCHAIN');
        });

        it('returns { swap: submitResult }', async function () {
            let helper = new CrossChainHelper({ BTC: makeSdk('BTC'), LTC: makeSdk('LTC') });
            let result = await helper.createSwap({
                giveCoin: 'BTC', giveTick: 'TOK', giveAmount: '10',
                getCoin: 'LTC', getTick: 'LTC', getAmount: '5',
                wif: 'wif'
            });
            assert.ok(Object.prototype.hasOwnProperty.call(result, 'swap'));
            assert.ok(result.swap.submitted);
        });

        it('throws for unknown giveCoin', async function () {
            let helper = new CrossChainHelper({ BTC: makeSdk('BTC'), LTC: makeSdk('LTC') });
            try {
                await helper.createSwap({ giveCoin: 'DOGE', wif: 'w' });
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
            }
        });
    });

    /*
     *  link()
     */

    describe('link()', function () {
        it('submits link on coin1 by default', async function () {
            let capturedParams;
            let btcSdk = makeSdk('BTC');
            btcSdk.session = function(wif) {
                return {
                    link: async (params) => { capturedParams = params; return { submitted: true }; }
                };
            };
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: makeSdk('LTC') });
            await helper.link({
                coin1: 'BTC', coin1ActionIndex: 10,
                coin2: 'LTC', coin2ActionIndex: 20,
                wif: 'wif1'
            });
            assert.strictEqual(capturedParams.coin1ActionIndex, 10);
            assert.strictEqual(capturedParams.coin2ActionIndex, 20);
        });

        it('submits on submitOn chain when specified', async function () {
            let usedChain = null;
            let btcSdk = makeSdk('BTC');
            let ltcSdk = makeSdk('LTC');
            ltcSdk.session = function(wif) {
                usedChain = 'LTC';
                return { link: async () => ({ submitted: true }) };
            };
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: ltcSdk });
            await helper.link({
                coin1: 'BTC', coin1ActionIndex: 1,
                coin2: 'LTC', coin2ActionIndex: 2,
                submitOn: 'LTC', wif: 'wif1'
            });
            assert.strictEqual(usedChain, 'LTC');
        });
    });

    /*
     *  parallel()
     */

    describe('parallel()', function () {
        it('runs all actions and returns results in order', async function () {
            let btcSdk = makeSdk('BTC');
            let ltcSdk = makeSdk('LTC');
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: ltcSdk });

            let results = await helper.parallel([
                { chain: 'BTC', wif: 'w1', actionData: { action: 'SEND', params: { tick: 'A' } } },
                { chain: 'LTC', wif: 'w2', actionData: { action: 'SEND', params: { tick: 'B' } } }
            ]);
            assert.strictEqual(results.length, 2);
            assert.ok(results[0].submitted);
            assert.ok(results[1].submitted);
        });

        it('throws for unknown chain', async function () {
            let helper = new CrossChainHelper({ BTC: makeSdk('BTC'), LTC: makeSdk('LTC') });
            try {
                await helper.parallel([{ chain: 'DOGE', wif: 'w', actionData: {} }]);
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
            }
        });

        it('passes encoderOpts and submitOpts to session.submit', async function () {
            let capturedEnc, capturedSubmit;
            let btcSdk = makeSdk('BTC');
            btcSdk.session = function(wif, submitOpts) {
                capturedSubmit = submitOpts;
                return {
                    submit: async (actionData, enc, sub) => { capturedEnc = enc; return { submitted: true }; }
                };
            };
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: makeSdk('LTC') });
            await helper.parallel([{
                chain: 'BTC', wif: 'w',
                actionData: { action: 'SEND' },
                encoderOpts: { fee: 1000 },
                submitOpts: { waitForIndexer: false }
            }]);
            assert.deepStrictEqual(capturedEnc, { fee: 1000 });
        });

        it('on partial failure, throws but preserves the successful leg txid', async function () {
            let btcSdk = makeSdk('BTC');
            btcSdk.session = () => ({ submit: async () => ({ submitted: true, txid: 'btc-broadcast-txid' }) });
            let ltcSdk = makeSdk('LTC');
            ltcSdk.session = () => ({ submit: async () => { throw new Error('LTC node unreachable'); } });
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: ltcSdk });

            try {
                await helper.parallel([
                    { chain: 'BTC', wif: 'w1', actionData: { action: 'SEND' } },
                    { chain: 'LTC', wif: 'w2', actionData: { action: 'SEND' } }
                ]);
                assert.fail('should have thrown on partial failure');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKActionError');
                assert.strictEqual(e.code, 'CROSS_CHAIN_PARTIAL_FAILURE');
                let results = e.details.results;
                assert.strictEqual(results.length, 2);
                // The BTC leg broadcast; its txid must survive the LTC failure.
                assert.strictEqual(results[0].chain, 'BTC');
                assert.strictEqual(results[0].ok, true);
                assert.strictEqual(results[0].result.txid, 'btc-broadcast-txid');
                assert.strictEqual(results[1].chain, 'LTC');
                assert.strictEqual(results[1].ok, false);
                assert.ok(results[1].error.includes('LTC node unreachable'));
            }
        });

        it('an unknown chain throws before any leg broadcasts', async function () {
            let broadcast = false;
            let btcSdk = makeSdk('BTC');
            btcSdk.session = () => ({ submit: async () => { broadcast = true; return { submitted: true }; } });
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: makeSdk('LTC') });

            try {
                await helper.parallel([
                    { chain: 'BTC', wif: 'w1', actionData: { action: 'SEND' } },
                    { chain: 'DOGE', wif: 'w2', actionData: { action: 'SEND' } }   // not configured
                ]);
                assert.fail('should have thrown for unknown chain');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKConfigError');
            }
            assert.strictEqual(broadcast, false, 'no leg should broadcast when a chain is unknown');
        });
    });

    /*
     *  waitForAll()
     */

    describe('waitForAll()', function () {
        it('waits for actions on multiple chains', async function () {
            let helper = new CrossChainHelper({ BTC: makeSdk('BTC'), LTC: makeSdk('LTC') });
            let results = await helper.waitForAll([
                { chain: 'BTC', txid: 'btctx' },
                { chain: 'LTC', txid: 'ltctx' }
            ]);
            assert.strictEqual(results.length, 2);
            assert.strictEqual(results[0].txid, 'btctx');
            assert.strictEqual(results[1].txid, 'ltctx');
        });

        it('on partial failure, throws but preserves the confirmed leg', async function () {
            let btcSdk = makeSdk('BTC');
            let ltcSdk = makeSdk('LTC');
            ltcSdk.waitForAction = async () => { throw new Error('timeout waiting for LTC'); };
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: ltcSdk });

            try {
                await helper.waitForAll([
                    { chain: 'BTC', txid: 'btctx' },
                    { chain: 'LTC', txid: 'ltctx' }
                ]);
                assert.fail('should have thrown on partial wait failure');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKActionError');
                assert.strictEqual(e.code, 'CROSS_CHAIN_WAIT_PARTIAL_FAILURE');
                let results = e.details.results;
                assert.strictEqual(results[0].ok, true);
                assert.strictEqual(results[0].result.txid, 'btctx');
                assert.strictEqual(results[1].ok, false);
                assert.ok(results[1].error.includes('timeout waiting for LTC'));
            }
        });
    });

    /*
     *  getAllBalances()
     */

    describe('getAllBalances()', function () {
        it('returns balances keyed by chain', async function () {
            let helper = new CrossChainHelper({ BTC: makeSdk('BTC'), LTC: makeSdk('LTC') });
            let result = await helper.getAllBalances('addr1');
            assert.ok(result.BTC);
            assert.ok(result.LTC);
            assert.ok(Array.isArray(result.BTC));
        });

        it('captures errors per-chain as { error: message }', async function () {
            let btcSdk = makeSdk('BTC');
            btcSdk.getBalances = async () => { throw new Error('connection refused'); };
            let helper = new CrossChainHelper({ BTC: btcSdk, LTC: makeSdk('LTC') });
            let result = await helper.getAllBalances('addr1');
            assert.ok(result.BTC.error);
            assert.ok(result.BTC.error.includes('connection refused'));
            // LTC still worked
            assert.ok(Array.isArray(result.LTC));
        });
    });

});
