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
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');

const CoSigner = require('../../../../../src/cosigner/co_signer.js');
const { inProcessTransport } = require('../../../../../src/cosigner/client.js');
const { deriveMuSig2P2TR, deriveMuSig2P2TR2of3 } = require('../../../../../src/cosigner/account.js');
const MuSig2AgentSession = require('../../../../../src/cosigner/musig2_agent_session.js');
const { SDKPolicyError } = require('../../../../../src/utils/errors.js');

const DEST = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

let tmpDir, stateFile, stateFileCounter = 0;

before(function () {
    this.timeout(30000);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musig2-agent-session-'));
});

beforeEach(function () {
    stateFile = path.join(tmpDir, `usage-${stateFileCounter++}.json`);
});

after(function () {
    this.timeout(30000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function psbtSpending(output, actionString, { value = 100000, inputs = 1, fee = 10000 } = {}) {
    const psbt = new bitcoin.Psbt();
    for (let i = 0; i < inputs; i++)
        psbt.addInput({ hash: crypto.randomBytes(32), index: i, witnessUtxo: { script: output, value } });
    const firstTxid = Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex');
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const cipher = crypto.createCipheriv('aes-128-ctr', firstTxid.substr(0, 16), firstTxid.substr(16, 16));
    const obf    = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('XCHN'), inner])), cipher.final()]);
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: output, value: value - fee });
    return psbt.toHex();
}

function buildAccountAndPsbt(actionString, opts = {}) {
    const agentSk = crypto.randomBytes(32), coSk = crypto.randomBytes(32);
    const agentPk = Buffer.from(secp256k1.getPublicKey(agentSk, true));
    const coPk    = Buffer.from(secp256k1.getPublicKey(coSk, true));
    const keys    = [agentPk, coPk];
    const acct    = deriveMuSig2P2TR(keys);
    const value   = opts.value || 100000;
    return { agentSk, coSk, agentPk, coPk, keys, acct, value, actionString,
             psbtHex: psbtSpending(acct.output, actionString, Object.assign({ value }, opts)) };
}

function expectValidKeyPathSpend(txHex, acct, value) {
    const tx = bitcoin.Transaction.fromHex(txHex);
    expect(tx.ins[0].witness).to.have.length(1);
    const sig = tx.ins[0].witness[0];
    expect(sig).to.have.length(64);
    const sighash = tx.hashForWitnessV1(0, [acct.output], [value], bitcoin.Transaction.SIGHASH_DEFAULT);
    expect(schnorr.verify(sig, sighash, acct.aggregateXOnly)).to.equal(true);
}

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
            getBitcoinNetwork: () => bitcoin.networks.bitcoin,
        },
        tickResolver:    { resolveActionParams: async (a, p) => p },
        addressResolver: { resolveActionParams: async (a, p) => p },
        actions:         { createAction: () => ({ actionString: s.actionString, action: 'SEND', version: 0 }) },
        requireEncoder: () => ({
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
        Object.assign({ allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '100' } }, allowUnkeyedSubmits: true }, localPolicy),
        { stateFile, coSigner: { transport, publicKeys: s.keys } });
}

describe('MuSig2AgentSession', function () {
    // construction

    it('requires a transport and the full publicKeys set', function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        const sdk = makeSdk(s, captured);
        expect(() => new MuSig2AgentSession(sdk, 'WIF', { allowedActions: ['SEND'] }, { coSigner: { publicKeys: s.keys } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_CONFIG');
        expect(() => new MuSig2AgentSession(sdk, 'WIF', { allowedActions: ['SEND'] }, { coSigner: { transport: () => {}, publicKeys: [s.agentPk] } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_CONFIG');
    });

    it('fails closed (COSIGNER_CONFIG) rather than silently deriving the aggregate account against Bitcoin mainnet when no network is available', function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        // No opts.coSigner.network AND the sdk has no getBitcoinNetwork accessor
        // (or it returns falsy): must throw, never fall through to bitcoinjs's
        // own `network: undefined` -> Bitcoin mainnet default.
        const sdkNoAccessor = { wallet: { importWIF: () => ({
            privateKey: Buffer.from(s.agentSk), publicKey: Buffer.from(s.agentPk),
            publicKeyHex: Buffer.from(s.agentPk).toString('hex'), compressed: true }) } };
        expect(() => new MuSig2AgentSession(sdkNoAccessor, 'WIF', { allowedActions: ['SEND'] },
            { coSigner: { transport: () => {}, publicKeys: s.keys } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_CONFIG');

        const sdkNullNetwork = { wallet: Object.assign({}, sdkNoAccessor.wallet, { getBitcoinNetwork: () => null }) };
        expect(() => new MuSig2AgentSession(sdkNullNetwork, 'WIF', { allowedActions: ['SEND'] },
            { coSigner: { transport: () => {}, publicKeys: s.keys } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_CONFIG');
    });

    it('falls back to sdk.wallet.getBitcoinNetwork() when opts.coSigner.network is omitted, and an explicit network still wins', function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const captured = { broadcasts: [], encodeCalls: 0 };
        const LTC = { messagePrefix: 'Litecoin Signed Message:\n', bech32: 'ltc',
            bip32: { public: 0x019da462, private: 0x019d9cfe },
            pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
        const co = new CoSigner({ secretKey: s.coSk, publicKeys: s.keys, tweaks: s.acct.tweaks,
            policy: { allowedActions: new Set(['SEND']) } });
        const transport = inProcessTransport(co);

        const sdk = makeSdk(s, captured);
        // Fallback path: no opts.coSigner.network, sdk supplies bitcoin.networks.bitcoin
        // (matches how the accounts in this suite were derived, so addresses match).
        const session = new MuSig2AgentSession(sdk, 'WIF',
            { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '100' } } },
            { coSigner: { transport, publicKeys: s.keys } });
        expect(session.address).to.equal(s.acct.address);

        // Explicit path: opts.coSigner.network is honored even though the SDK
        // would supply a different fallback (LTC != the sdk's bitcoin.networks.bitcoin).
        const explicitAcct = deriveMuSig2P2TR(s.keys, LTC);
        const explicitSession = new MuSig2AgentSession(sdk, 'WIF',
            { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '100' } } },
            { coSigner: { transport, publicKeys: s.keys, network: LTC } });
        expect(explicitSession.address).to.equal(explicitAcct.address);
    });
});

describe('MuSig2AgentSession', function () {
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
});

describe('MuSig2AgentSession', function () {
    // submit path

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

describe('MuSig2AgentSession', function () {
    it('recovery mode: derives a 2-of-3 address and spends it via the agent+daemon key path', async function () {
        const agentSk = crypto.randomBytes(32), daemonSk = crypto.randomBytes(32), recSk = crypto.randomBytes(32);
        const agentPk  = Buffer.from(secp256k1.getPublicKey(agentSk, true));
        const daemonPk = Buffer.from(secp256k1.getPublicKey(daemonSk, true));
        const recPk    = Buffer.from(secp256k1.getPublicKey(recSk, true));
        const a3 = deriveMuSig2P2TR2of3({ agent: agentPk, daemon: daemonPk, recovery: recPk });
        const value = 100000;
        const actionString = `SEND|0|TOK|5|${DEST}|m`;
        const s = { agentSk, agentPk, actionString, psbtHex: psbtSpending(a3.output, actionString, { value }) };

        // The daemon derives the 2-of-3 tree from the recovery PUBLIC KEY; a raw
        // tweak is not an accepted configuration surface (G3).
        const co = new CoSigner({ secretKey: daemonSk, publicKeys: a3.keyPath.publicKeys, recoveryPublicKey: recPk,
            policy: { allowedActions: new Set(['SEND']) } });
        const captured = { broadcasts: [], encodeCalls: 0 };
        const session = new MuSig2AgentSession(makeSdk(s, captured), 'WIF',
            { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '100' } }, allowUnkeyedSubmits: true },
            { stateFile, coSigner: { transport: inProcessTransport(co), publicKeys: [agentPk, daemonPk], recovery: recPk } });

        expect(session.address).to.equal(a3.address);
        await session.send({ tick: 'TOK', amount: '5', destination: DEST },
            { utxos: [{ txid: 'a', vout: 0, value }] }, { waitForIndexer: false });
        expect(captured.broadcasts).to.have.length(1);
        // The broadcast witness verifies under the 2-of-3 address's tweaked output key.
        expectValidKeyPathSpend(captured.broadcasts[0], { output: a3.output, aggregateXOnly: a3.outputXOnly }, value);
    });

    it('recovery mode requires exactly the [agent, daemon] pair', function () {
        const s = buildAccountAndPsbt(`SEND|0|TOK|5|${DEST}|m`);
        const recPk = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
        const third = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
        expect(() => new MuSig2AgentSession(makeSdk(s, { broadcasts: [], encodeCalls: 0 }), 'WIF',
            { allowedActions: ['SEND'] },
            { coSigner: { transport: () => {}, publicKeys: [s.agentPk, s.coPk, third], recovery: recPk } }))
            .to.throw(SDKPolicyError).with.property('code', 'COSIGNER_CONFIG');
    });
});
