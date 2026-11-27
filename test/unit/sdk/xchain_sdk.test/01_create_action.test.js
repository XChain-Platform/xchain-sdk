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
const bitcoin = require('bitcoinjs-lib');
const XChainSDK = require('../../../../src/XChainSDK.js');

const NET = bitcoin.networks.regtest;
const OWN_HASH = Buffer.alloc(20, 0xab);
const OWN_SCRIPT = bitcoin.payments.p2wpkh({ hash: OWN_HASH, network: NET }).output;
const CHUNK_CALLER = bitcoin.payments.p2wpkh({ hash: OWN_HASH, network: NET }).address;

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

// Patch all encoder methods
function mockEncoder(sdk, returnVal = {}) {
    const encoder = sdk.encoder;
    const proto = Object.getPrototypeOf(encoder);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(m => !m.startsWith('_') && m !== 'constructor');
    for (const m of methods) {
        if (typeof encoder[m] === 'function') {
            const stub = sinon.stub(encoder, m);
            if (typeof returnVal === 'function') stub.callsFake(returnVal);
            else stub.resolves(returnVal);
        }
    }
    return encoder;
}

function actionCarrier(prevTxid, actionString) {
    const tagged = Buffer.concat([
        Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from(actionString, 'utf8')]),
    ]);
    const cipher = require('crypto').createCipheriv(
        'aes-128-ctr', prevTxid.substr(0, 16), prevTxid.substr(16, 16));
    return bitcoin.payments.embed({
        data: [Buffer.concat([cipher.update(tagged), cipher.final()])],
    }).output;
}

function fundingPsbt(req, options = {}) {
    const prev = new bitcoin.Transaction();
    prev.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prev.addOutput(OWN_SCRIPT, 100000);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prev.getId(), index: 0,
        witnessUtxo: { script: OWN_SCRIPT, value: 100000 }, nonWitnessUtxo: prev.toBuffer() });
    const carried = options.actionString || req.data;
    if (!options.noCarrier) psbt.addOutput({ script: actionCarrier(prev.getId(), carried), value: 0 });
    for (const output of (options.extraOutputs || [])) psbt.addOutput(output);
    psbt.addOutput({ script: OWN_SCRIPT, value: options.changeValue || 90000 });
    return { psbt: psbt.toHex(), encoding: options.encoding || 'OP_RETURN',
        carrierScripts: options.carrierScripts, compression: options.compression };
}

function chunkFunding(req, encoding) {
    const payload = bitcoin.script.compile([Buffer.from(req.data, 'utf8')]);
    const scripts = [];
    for (let offset = 0; offset < payload.length; offset += 40) {
        scripts.push(bitcoin.script.compile([
            payload.subarray(offset, offset + 40), bitcoin.opcodes.OP_DROP,
            bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160, OWN_HASH,
            bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG,
        ]));
    }
    const prev = new bitcoin.Transaction();
    prev.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prev.addOutput(OWN_SCRIPT, 100000);
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: prev.getId(), index: 0,
        witnessUtxo: { script: OWN_SCRIPT, value: 100000 }, nonWitnessUtxo: prev.toBuffer() });
    for (const script of scripts) {
        const output = encoding === 'P2SH'
            ? bitcoin.payments.p2sh({ redeem: { output: script }, network: NET }).output
            : bitcoin.payments.p2wsh({ redeem: { output: script }, network: NET }).output;
        psbt.addOutput({ script: output, value: 1000 });
    }
    psbt.addOutput({ script: OWN_SCRIPT, value: 90000 });
    return { psbt: psbt.toHex(), encoding, carrierScripts: scripts.map(s => s.toString('hex')) };
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

function registerCreateActionCoreTests() {
        it('returns actionString for SEND without encoder', async function () {
            const sdk = makeSDK();
            const result = await sdk.createAction({ action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' } });
            expect(result.actionString).to.be.a('string');
            expect(result.actionString).to.include('SEND');
        });

        it('calls encoder.createTx when encoder options with pubkey provided', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, req => fundingPsbt(req));
            const result = await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                encoder: { pubkey: 'mypubkey' }
            });
            expect(result.psbt).to.be.a('string');
            expect(result.encoding).to.equal('OP_RETURN');
            expect(result.signable).to.equal(true);
            expect(sdk.encoder.createTx.calledOnce).to.be.true;
            expect(sdk.encoder.createTx.firstCall.args[0].attachPrevTx).to.equal(true);
        });

        it('withholds a Taproot commit whose reveal must use submitAction', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, {
                psbt: 'aabbcc', revealPsbt: 'ddeeff', encoding: 'TAPROOT',
                carrierScripts: ['51'], envelope: { tapleafHash: '11' },
            });
            const result = await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                encoder: { pubkey: 'mypubkey' }
            });
            expect(result.psbt).to.equal(null);
            expect(result.signable).to.equal(false);
            expect(result.unsignableReason).to.equal('ENVELOPE_PAIR_SIGN_VIA_SUBMIT_ACTION');
            expect(result).not.to.have.property('revealPsbt');
            expect(result).not.to.have.property('envelope');
        });
}

function registerCreateActionFieldTests() {
        it('preserves named carrier and compression fields for single-phase results', async function () {
            const sdk = makeSDK();
            const compression = { compressed: false };
            mockEncoder(sdk, req => fundingPsbt(req, { compression, carrierScripts: ['51'] }));
            const result = await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                encoder: { pubkey: 'mypubkey' }
            });
            expect(result).to.include({ encoding: 'OP_RETURN', signable: true });
            expect(result.carrierScripts).to.deep.equal(['51']);
            expect(result.compression).to.equal(compression);
        });

        it('refuses compressed results that omit the carried bytes', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, {
                psbt: 'aabbcc', encoding: 'P2SH', compression: { compressed: true },
            });
            let error;
            try {
                await sdk.createAction({
                    action: 'SEND',
                    params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                    encoder: { pubkey: 'mypubkey' }
                });
            } catch (e) { error = e; }
            expect(error).to.have.property('code', 'COMPRESSION_BYTES_UNREPORTED');
        });

        // The shared list keeps feeQuote, compress, options and sourceAddress aligned
        // with createTx so a high-level caller retains its protocol-fee output, FILE
        // compression policy, Taproot signer capability and source-address UTXO
        // selection.
        it('forwards EVERY optional encoder field to encoder.createTx', async function () {
            const EncoderClient = require('../../../../src/clients/encoder.js');
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            const encoderOpts = { pubkey: 'mypubkey' };
            // A distinguishable value per optional field, whatever the list holds today.
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS) encoderOpts[key] = 'set:' + key;
            try { await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                encoder: encoderOpts
            }); } catch (error) { expect(error).to.be.an('error'); }
            const sent = sdk.encoder.createTx.firstCall.args[0];
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS)
                expect(sent[key], key + ' must reach createTx').to.equal('set:' + key);
            expect(sent.pubkey).to.equal('mypubkey');
            expect(sent.data).to.be.a('string');
        });
}

function registerCreateActionTwoPhaseTests() {
        it('withholds checked P2SH and P2WSH funding legs for managed submission', async function () {
            for (const encoding of ['P2SH', 'P2WSH']) {
                const sdk = makeSDK();
                mockEncoder(sdk, req => chunkFunding(req, encoding));
                const result = await sdk.createAction({
                    action: 'SEND',
                    params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                    encoder: { pubkey: CHUNK_CALLER },
                });
                expect(result.psbt).to.be.a('string');
                expect(result.signable).to.equal(false);
                expect(result.unsignableReason).to.equal('TWO_PHASE_SIGN_VIA_SUBMIT_ACTION');
            }
        });
}

function registerCreateActionSafetyTests() {
        it('refuses an encoder reply that redirects value to a foreign output', async function () {
            const sdk = makeSDK();
            const foreign = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xcd), network: NET }).output;
            mockEncoder(sdk, req => fundingPsbt(req, {
                extraOutputs: [{ script: foreign, value: 1000 }], changeValue: 89000,
            }));
            let error;
            try {
                await sdk.createAction({ action: 'SEND',
                    params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                    encoder: { pubkey: 'mypubkey' } });
            } catch (caught) { error = caught; }
            expect(error).to.have.property('code', 'UNRECONCILED_OUTPUT');
        });

        it('refuses an encoder reply whose fee exceeds the caller cap', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, req => fundingPsbt(req));
            let error;
            try {
                await sdk.createAction({ action: 'SEND',
                    params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                    encoder: { pubkey: 'mypubkey', maxFeeSats: 5000 } });
            } catch (caught) { error = caught; }
            expect(error).to.have.property('code', 'FEE_OVER_CAP');
            expect(sdk.encoder.createTx.firstCall.args[0]).not.to.have.property('maxFeeSats');
        });

        it('refuses an encoder reply carrying a different action', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, req => fundingPsbt(req, { actionString: 'SEND|0|EVIL' }));
            let error;
            try {
                await sdk.createAction({ action: 'SEND',
                    params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                    encoder: { pubkey: 'mypubkey' } });
            } catch (caught) { error = caught; }
            expect(error).to.have.property('code', 'CARRIER_ACTION_MISMATCH');
        });
}

function registerCreateActionCarrierPresenceTests() {
        it('refuses an encoder reply that carries no action at all', async function () {
            for (const encoding of ['OP_RETURN', 'MULTISIGN', 'P2SH', 'P2WSH']) {
                const sdk = makeSDK();
                mockEncoder(sdk, req => fundingPsbt(req, { noCarrier: true, encoding }));
                let error;
                let result;
                try {
                    result = await sdk.createAction({ action: 'SEND',
                        params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                        encoder: { pubkey: CHUNK_CALLER } });
                } catch (caught) { error = caught; }
                expect(result, encoding).to.equal(undefined);
                expect(error, encoding).to.have.property('code', 'CARRIER_MISSING');
            }
        });
}

describe('XChainSDK', function () {
    registerEnvHooks();

    // ACTION methods

    describe('createAction', function () {
        registerCreateActionCoreTests();
        registerCreateActionFieldTests();
        registerCreateActionTwoPhaseTests();
        registerCreateActionSafetyTests();
        registerCreateActionCarrierPresenceTests();
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('createAction', function () {

        it('omits optional encoder fields the caller did not set (absent is not false)', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            try { await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC' },
                encoder: { pubkey: 'mypubkey' }
            }); } catch (error) { expect(error).to.be.an('error'); }
            const sent = sdk.encoder.createTx.firstCall.args[0];
            // createTx reads absent and explicit-false as different wire meanings
            // (compress is tri-state), so an unset field must not appear at all.
            expect(Object.prototype.hasOwnProperty.call(sent, 'compress')).to.equal(false);
            expect(Object.prototype.hasOwnProperty.call(sent, 'feeQuote')).to.equal(false);
            expect(sent.attachPrevTx).to.equal(true);
        });

        // Drift guard: the shared list is the ONLY place the optional set is named,
        // so it has to stay equal to what createTx's own mapper actually reads.
        it('the shared option list covers every optional field createTx maps', function () {
            const fs = require('fs');
            const path = require('path');
            const EncoderClient = require('../../../../src/clients/encoder.js');
            const src = fs.readFileSync(path.join(__dirname, '../../../../src/clients/encoder/transactions.js'), 'utf8');
            // createTx reads its options in two places: the wire mapper, and createTx
            // itself for the SDK-side fields. Each marker must be found, or the scan
            // reads nothing and passes whatever the list holds.
            const bodies = [['function buildCreateTxParams(params)', '\n}\n'], ['async createTx(params)', '\n    async ']]
                .map(([marker, stop]) => {
                    const start = src.indexOf(marker);
                    expect(start, 'marker not found: ' + marker).to.not.equal(-1);
                    // Stop at the next function, or spendP2sh's own params leak into the scan.
                    return src.slice(start, src.indexOf(stop, start + 1));
                });
            const read = new Set();
            for (const body of bodies)
                for (const m of body.matchAll(/params\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]);
            expect(read.size, 'the scan found no option reads at all').to.be.above(10);
            read.delete('data'); read.delete('pubkey');   // required, set explicitly by each caller
            const listed = new Set(EncoderClient.CREATE_TX_OPTION_FIELDS);
            const missing = [...read].filter(k => !listed.has(k));
            expect(missing, 'createTx reads these but the shared list drops them: ' + missing.join(', ')).to.deep.equal([]);
        });
    });
});
