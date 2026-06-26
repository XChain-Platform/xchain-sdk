// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// P3 slice 2: the MuSig2-backed agent submit path. Covers the signer adapter
// (single-input key-path spend, multi-input fail-closed) and MuSig2AgentSession
// wiring (aggregate spending account, local policy pre-flight, co-signer as the
// authoritative gate). The encoder + broadcast are mocked; everything from the
// PSBT through the co-signer round to the finalized witness is real.

'use strict';

const { expect } = require('chai');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');

const CoSigner = require('../../src/cosigner/coSigner.js');
const CoSignerClient = require('../../src/cosigner/client.js');
const { inProcessTransport } = CoSignerClient;
const { deriveMuSig2P2TR } = require('../../src/cosigner/account.js');
const { buildMuSig2Signer } = require('../../src/cosigner/musig2Signer.js');
const MuSig2AgentSession = require('../../src/cosigner/musig2AgentSession.js');
const { SDKPolicyError } = require('../../src/errors.js');

const DEST = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

// A 2-of-2 aggregate account plus an unsigned PSBT spending `inputs` UTXOs from
// it, carrying `actionString` in an obfuscated OP_RETURN built exactly like the
// encoder (AES-128-CTR keyed by the first input's txid, 'XCHN' magic).
function buildAccountAndPsbt(actionString, { value = 100000, inputs = 1 } = {}) {
    const agentSk = crypto.randomBytes(32), coSk = crypto.randomBytes(32);
    const agentPk = Buffer.from(secp256k1.getPublicKey(agentSk, true));
    const coPk    = Buffer.from(secp256k1.getPublicKey(coSk, true));
    const keys    = [agentPk, coPk];
    const acct    = deriveMuSig2P2TR(keys);

    const psbt = new bitcoin.Psbt();
    for (let i = 0; i < inputs; i++) {
        const prevHash = crypto.randomBytes(32);
        psbt.addInput({ hash: prevHash, index: i, witnessUtxo: { script: acct.output, value } });
    }
    const firstTxid = Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex');
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', firstTxid.substr(0, 16), firstTxid.substr(16, 16));
    const obf    = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: acct.output, value: value - 10000 });   // change back to the account

    return { agentSk, coSk, agentPk, coPk, keys, acct, value, psbtHex: psbt.toHex() };
}

// Verify a finalized tx carries one valid key-path Schnorr witness for input 0
// under the aggregate key (the whole point: it spends the derived address).
function expectValidKeyPathSpend(txHex, acct, value) {
    const tx = bitcoin.Transaction.fromHex(txHex);
    expect(tx.ins[0].witness).to.have.length(1);
    const sig = tx.ins[0].witness[0];
    expect(sig).to.have.length(64);
    const sighash = tx.hashForWitnessV1(0, [acct.output], [value], bitcoin.Transaction.SIGHASH_DEFAULT);
    expect(schnorr.verify(sig, sighash, acct.aggregateXOnly)).to.equal(true);
}

describe('MuSig2 signer adapter (buildMuSig2Signer)', function () {

    it('completes a single-input key-path spend via the co-signer', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']) } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });
        const sign = buildMuSig2Signer({ coSignerClient: client, secretKey: s.agentSk });

        const out = await sign(s.psbtHex);
        expect(out.txid).to.be.a('string');
        expectValidKeyPathSpend(out.txHex, s.acct, s.value);
    });

    it('signs every input of a multi-input aggregate spend in one round', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`, { inputs: 3 });
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']) } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });
        const sign = buildMuSig2Signer({ coSignerClient: client, secretKey: s.agentSk });

        const out = await sign(s.psbtHex);
        const tx = bitcoin.Transaction.fromHex(out.txHex);
        expect(tx.ins).to.have.length(3);
        const scripts = tx.ins.map(() => s.acct.output);
        const values  = tx.ins.map(() => s.value);
        for (let i = 0; i < tx.ins.length; i++) {
            expect(tx.ins[i].witness).to.have.length(1);
            const sighash = tx.hashForWitnessV1(i, scripts, values, bitcoin.Transaction.SIGHASH_DEFAULT);
            expect(schnorr.verify(tx.ins[i].witness[0], sighash, s.acct.aggregateXOnly)).to.equal(true);
        }
    });

    it('propagates a co-signer denial as SDKPolicyError (no tx produced)', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|100|${DEST}|m`);
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '50' } } } });
        const client = new CoSignerClient({ transport: inProcessTransport(co), publicKeys: s.keys, tweaks: s.acct.tweaks });
        const sign = buildMuSig2Signer({ coSignerClient: client, secretKey: s.agentSk });

        let err;
        try { await sign(s.psbtHex); } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKPolicyError);
        expect(err.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('rejects bad construction', function () {
        expect(() => buildMuSig2Signer({ secretKey: Buffer.alloc(32) })).to.throw(/CoSignerClient/);
        expect(() => buildMuSig2Signer({ coSignerClient: { sign() {} } })).to.throw(/secretKey/);
    });
});

describe('MuSig2AgentSession', function () {

    // Fake just enough SDK for the session + LifecycleManager. createTx returns a
    // pre-built PSBT spending the aggregate; broadcastTx is captured.
    function makeSdk(s, captured) {
        return {
            wallet: {
                importWIF: () => ({
                    privateKey:    Buffer.from(s.agentSk),
                    publicKey:     Buffer.from(s.agentPk),
                    publicKeyHex:  Buffer.from(s.agentPk).toString('hex'),
                    compressed:    true,
                }),
                deriveAddress: () => 'agentP2PKHaddr',
            },
            tickResolver:    { resolveActionParams: async (a, p) => p },
            addressResolver: { resolveActionParams: async (a, p) => p },
            actions:         { createAction: () => ({ actionString: 'SEND|x', action: 'SEND', version: 0 }) },
            _requireEncoder: () => ({
                createTx:    async () => { captured.encodeCalls++; return { psbt: s.psbtHex, encoding: 'OP_RETURN' }; },
                broadcastTx: async (txHex) => { captured.broadcasts.push(txHex); return { txid: 'ok' }; },
                getUTXOs:    async () => ({ utxos: [] }),
            }),
        };
    }

    function makeSession(s, sdk, localPolicy) {
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: Object.assign({ allowedActions: new Set(['SEND']) }, s.coPolicy) });
        const transport = inProcessTransport(co);
        return new MuSig2AgentSession(sdk, 'WIF',
            Object.assign({ allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '100' } } }, localPolicy),
            { coSigner: { transport, publicKeys: s.keys } });
    }

    /* ── construction ─────────────────────────────────────────────── */

    it('requires a transport and the full publicKeys set', function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        const sdk = makeSdk(s, captured);
        expect(() => new MuSig2AgentSession(sdk, 'WIF', { allowedActions: ['SEND'] }, { coSigner: { publicKeys: s.keys } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_CONFIG');
        expect(() => new MuSig2AgentSession(sdk, 'WIF', { allowedActions: ['SEND'] }, { coSigner: { transport: () => {}, publicKeys: [s.agentPk] } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_CONFIG');
    });

    it('fails closed when the agent key is not in the signer set', function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        const sdk = makeSdk(s, captured);
        const otherPk = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
        expect(() => new MuSig2AgentSession(sdk, 'WIF', { allowedActions: ['SEND'] },
            { coSigner: { transport: () => {}, publicKeys: [otherPk, s.coPk] } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_KEY_MISMATCH');
    });

    it('spends from the aggregate P2TR account, not the agent p2pkh', function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        const session = makeSession(s, makeSdk(s, captured));
        expect(session.address).to.equal(s.acct.address);
        expect(session.musig2Account.address).to.equal(s.acct.address);
    });

    /* ── submit path ──────────────────────────────────────────────── */

    it('submits an in-policy action and broadcasts a valid aggregate-signed tx', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        const session = makeSession(s, makeSdk(s, captured));

        const res = await session.send({ tick: 'TOK', amount: '5', destination: DEST },
            { utxos: [{ txid: 'a', vout: 0, value: s.value }] }, { waitForIndexer: false });

        expect(captured.broadcasts).to.have.length(1);
        expectValidKeyPathSpend(captured.broadcasts[0], s.acct, s.value);
        expect(res.policy.action).to.equal('SEND');
    });

    it('denies an out-of-local-policy action BEFORE encoding (fast pre-flight)', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        const session = makeSession(s, makeSdk(s, captured), { maxPerAction: { SEND: { TOK: '1' } } });

        let err;
        try {
            await session.send({ tick: 'TOK', amount: '5', destination: DEST },
                { utxos: [{ txid: 'a', vout: 0, value: s.value }] }, { waitForIndexer: false });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKPolicyError);
        expect(err.code).to.equal('POLICY_AMOUNT_EXCEEDED');
        expect(captured.encodeCalls).to.equal(0);   // never reached the encoder
        expect(captured.broadcasts).to.have.length(0);
    });

    it('lets local policy pass but the co-signer deny: encodes, never broadcasts', async function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        s.coPolicy = { allowedActions: new Set(['SEND']), maxPerAction: { SEND: { TOK: '1' } } };
        const captured = { broadcasts: [], encodeCalls: 0 };
        const session = makeSession(s, makeSdk(s, captured));   // local cap 100 allows; co-signer cap 1 denies

        let err;
        try {
            await session.send({ tick: 'TOK', amount: '5', destination: DEST },
                { utxos: [{ txid: 'a', vout: 0, value: s.value }] }, { waitForIndexer: false });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKPolicyError);
        expect(err.code).to.equal('POLICY_AMOUNT_EXCEEDED');
        expect(captured.encodeCalls).to.equal(1);    // reached the encoder
        expect(captured.broadcasts).to.have.length(0);   // co-signer withheld -> no broadcast
    });
});
