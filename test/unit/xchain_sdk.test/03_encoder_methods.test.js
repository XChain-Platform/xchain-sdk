// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const sinon   = require('sinon');
const XChainSDK = require('../../../src/XChainSDK.js');

// Helpers

// Env vars the SDK reads: clear them so tests are deterministic
const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];

// Build a minimal SDK pointed at a local regtest stack so no public
// defaults + no auto-hub are injected
function makeSDK(extra = {}) {
    return new XChainSDK(Object.assign({
        network:     'bitcoin-regtest',
        explorerUrl: 'http://localhost:8080',
        encoderUrl:  'http://localhost:3000',
        retry: false
    }, extra));
}

// Patch all explorer methods with a spy that resolves to {}
function mockExplorer(sdk, returnVal = {}) {
    const explorer = sdk.explorer;
    const proto = Object.getPrototypeOf(explorer);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(m => !m.startsWith('_') && m !== 'constructor');
    for (const m of methods) {
        if (typeof explorer[m] === 'function') {
            sinon.stub(explorer, m).resolves(returnVal);
        }
    }
    return explorer;
}

// A REAL encoder-shaped answer: one unsigned input, a zero-value carrier, and change
// back to the funding script. estimateFees runs the same fail-closed reconcile gate
// submitAction does, so a placeholder string is no longer a usable stand-in.
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

// Patch all encoder methods
function mockEncoder(sdk, returnVal = {}) {
    const encoder = sdk.encoder;
    const proto = Object.getPrototypeOf(encoder);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(m => !m.startsWith('_') && m !== 'constructor');
    for (const m of methods) {
        if (typeof encoder[m] === 'function') {
            sinon.stub(encoder, m).resolves(returnVal);
        }
    }
    return encoder;
}

function registerEnvHooks() {
    let saved;
    beforeEach(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
}

describe('XChainSDK', function () {
    registerEnvHooks();

    // Encoder methods

    describe('encoder methods', function () {

        it('encodeTx delegates to encoder.createTx', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'OP_RETURN' });
            const result = await sdk.encodeTx({ data: 'TEST', pubkey: 'pub' });
            expect(sdk.encoder.createTx.calledOnce).to.be.true;
        });

        it('spendP2sh delegates to encoder.spendP2sh', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'P2SH' });
            await sdk.spendP2sh({ pubkey: 'pub', p2shHash: 'h', p2shHex: 'x' });
            expect(sdk.encoder.spendP2sh.calledOnce).to.be.true;
        });

        it('pingEncoder delegates to encoder.ping', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { status: 'ok' });
            await sdk.pingEncoder();
            expect(sdk.encoder.ping.calledOnce).to.be.true;
        });

        it('estimateFees builds actionString and calls encoder.estimateFee', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub' }
            );
            expect(sdk.encoder.estimateFee.calledOnce).to.be.true;
            expect(result.actionString).to.be.a('string');
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('encoder methods', function () {

        // estimateFees hands back a PSBT the SDK docs say can be signed and
        // broadcast directly, so it has to clear the same fail-closed intent gate
        // submitAction applies, keeping every signing route behind an intent gate.
        it('estimateFees REFUSES an encoder answer that diverts value to a destination nobody asked for', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const net = bitcoin.networks.regtest;
            const ECPair = ECPairFactory(ecc);
            const mine = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const theirs = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: mine, value: 100000 } });
            psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
            psbt.addOutput({ script: theirs, value: 99000 });        // the drain

            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: psbt.toHex(), encoding: 'OP_RETURN', fee: 1000 });
            let err = null;
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub' }
                );
            } catch (e) { err = e; }
            expect(err, 'estimateFees must fail closed on an unaccountable output').to.be.ok;
            expect(err.code).to.equal('UNRECONCILED_OUTPUT');
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('encoder methods', function () {

        // Second half of the same rule. The envelope reveal reaches estimateFees so the commit's
        // funding leg can be pinned to what actually spends it, but it is a GATE INPUT: the
        // gate above never reconciles it, so returning it would hand back a second signable
        // PSBT nothing checked - the same hole one field over.
        it('estimateFees consumes an envelope reveal as the phase pin and never returns it', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const net = bitcoin.networks.regtest;
            const ECPair = ECPairFactory(ecc);
            const script = () => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const mine = script();
            const leg  = bitcoin.script.compile([bitcoin.opcodes.OP_1, Buffer.from('bb'.repeat(32), 'hex')]);

            const commit = new bitcoin.Psbt({ network: net });
            commit.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: mine, value: 100000 } });
            commit.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
            commit.addOutput({ script: leg, value: 50000 });
            commit.addOutput({ script: mine, value: 49000 });

            // A reveal that pays a stranger. The commit reconciles either way, so this is
            // only safe because the reveal does not leave the method.
            const reveal = new bitcoin.Psbt({ network: net });
            reveal.addInput({ hash: 'cc'.repeat(32), index: 0, witnessUtxo: { script: leg, value: 50000 } });
            reveal.addOutput({ script: script(), value: 49000 });

            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: commit.toHex(), encoding: 'TAPROOT', revealPsbt: reveal.toHex(), fee: 1000 });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub' }
            );
            expect(result.psbt, 'the gated commit is still returned').to.equal(commit.toHex());
            expect(result.revealPsbt, 'an ungated reveal must never reach the caller').to.equal(undefined);
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('encoder methods', function () {

        // The pin the reveal exists for: a shaped leg the companion transaction does not
        // spend is value parked in a script only the encoder controls.
        it('estimateFees REFUSES an envelope commit whose funding leg the reveal never spends', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const net = bitcoin.networks.regtest;
            const ECPair = ECPairFactory(ecc);
            const mine = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const leg  = bitcoin.script.compile([bitcoin.opcodes.OP_1, Buffer.from('bb'.repeat(32), 'hex')]);

            const commit = new bitcoin.Psbt({ network: net });
            commit.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: mine, value: 100000 } });
            commit.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
            commit.addOutput({ script: leg, value: 50000 });      // parked
            commit.addOutput({ script: mine, value: 49000 });

            const reveal = new bitcoin.Psbt({ network: net });
            reveal.addInput({ hash: 'cc'.repeat(32), index: 0, witnessUtxo: { script: leg, value: 1000 } });
            reveal.addOutput({ script: mine, value: 800 });

            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: commit.toHex(), encoding: 'TAPROOT', revealPsbt: reveal.toHex(), fee: 1000 });
            let err = null;
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub' }
                );
            } catch (e) { err = e; }
            expect(err, 'a parked funding leg must fail closed').to.be.ok;
            expect(err.code).to.equal('PHASE_FUNDING_UNSPENT');
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('encoder methods', function () {

        it('estimateFees with payFeeInNativeCoin calls quoteNativeFee', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
            mockExplorer(sdk, { supported: true, valid: true, requiredFeeSats: 5000, feeDestination: 'feeaddr', actionString: 'SEND|...' });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub', payFeeInNativeCoin: true, source: 'addr1' }
            );
            expect(result.nativeFeeQuote).to.be.ok;
        });

        it('estimateFees throws when native fee unsupported', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
            mockExplorer(sdk, { supported: false, valid: false, error: 'unsupported' });
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub', payFeeInNativeCoin: true }
                );
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('NATIVE_FEE_UNSUPPORTED');
            }
        });

        it('estimateFees throws when native fee invalid', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
            mockExplorer(sdk, { supported: true, valid: false, error: 'stale price' });
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub', payFeeInNativeCoin: true }
                );
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('NATIVE_FEE_INVALID');
            }
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // quoteNativeFee

    describe('quoteNativeFee', function () {

        it('calls explorer.getFeeQuote with parsed action parts', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk, { supported: true, valid: true, requiredFeeSats: 1000 });
            const result = await sdk.quoteNativeFee(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { source: 'addr1' }
            );
            expect(sdk.explorer.getFeeQuote.calledOnce).to.be.true;
            expect(result.actionString).to.be.a('string');
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // getFeeSchedule

    describe('getFeeSchedule', function () {

        it('delegates to explorer.getFeeSchedule', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk, { actions: [] });
            await sdk.getFeeSchedule();
            expect(sdk.explorer.getFeeSchedule.calledOnce).to.be.true;
        });
    });
});
