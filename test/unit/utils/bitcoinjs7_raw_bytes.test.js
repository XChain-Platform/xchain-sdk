// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// bitcoinjs-lib 7 returns plain Uint8Array from address.toOutputScript,
// script.compile/decompile, payments and Psbt parsing. apply_bufferutils_patch
// turns those into Buffers, but only in a process that loaded it, and most unit
// files load it, so a check written as Buffer.isBuffer(libValue) passes the
// suite while refusing every real value in a consumer that deep-requires the
// co-signer, carrier or decoder modules (the MuSig2 envelope e2e does exactly
// that). Each scenario here therefore runs in a fresh child process that never
// loads the patch, and first asserts that the library really is handing back
// non-Buffer bytes, so a leaked patch fails loudly instead of passing vacuously.

'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..', '..', 'src');

// ---------------------------------------------------------------- child side

function rawLib() {
    const bitcoin = require('bitcoinjs-lib');
    assert(!bitcoin.Transaction.prototype.__xchainNumberValues,
        'apply_bufferutils_patch is loaded; this scenario must see raw bitcoinjs-lib 7 values');
    const probe = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 1) }).output;
    assert(probe instanceof Uint8Array && !Buffer.isBuffer(probe),
        'bitcoinjs-lib returned a Buffer; this scenario needs raw Uint8Array outputs');
    return bitcoin;
}

const REGTEST = () => require('bitcoinjs-lib').networks.regtest;

// One standard address of each template on regtest, built and read back by the raw library.
function standardAddresses(bitcoin) {
    const net = REGTEST();
    const ecc = require('@bitcoinerlab/secp256k1');
    bitcoin.initEccLib(ecc);
    const h20 = Buffer.alloc(20, 0x11);
    const h32 = Buffer.alloc(32, 0x22);
    const xonly = Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
    return {
        P2PKH:  bitcoin.payments.p2pkh({ hash: h20, network: net }).address,
        P2SH:   bitcoin.payments.p2sh({ hash: h20, network: net }).address,
        P2WPKH: bitcoin.payments.p2wpkh({ hash: h20, network: net }).address,
        P2WSH:  bitcoin.payments.p2wsh({ hash: h32, network: net }).address,
        P2TR:   bitcoin.payments.p2tr({ pubkey: xonly, network: net }).address,
    };
}

function musigAccount() {
    const crypto = require('crypto');
    const { secp256k1 } = require('@noble/curves/secp256k1.js');
    const { deriveMuSig2P2TR } = require(path.join(SRC, 'cosigner/account.js'));
    const agentSk = crypto.randomBytes(32);
    const daemonSk = crypto.randomBytes(32);
    const publicKeys = [secp256k1.getPublicKey(agentSk, true), secp256k1.getPublicKey(daemonSk, true)];
    const account = deriveMuSig2P2TR(publicKeys, REGTEST());
    return { agentSk, daemonSk, publicKeys, account };
}

function windowStore(tag) {
    const os = require('os');
    const WindowStore = require(path.join(SRC, 'cosigner/windowStore.js'));
    const file = path.join(os.tmpdir(), `bitcoinjs7-raw-${tag}-${process.pid}-${Date.now()}.json`);
    return new WindowStore(file, 24, null, { init: true });
}

function obfuscatedCarrier(bitcoin, prevHash, actionString) {
    const crypto = require('crypto');
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const tagged = Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from(actionString, 'utf8')])]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    return bitcoin.payments.embed({ data: [Buffer.concat([cipher.update(tagged), cipher.final()])] }).output;
}

const SCENARIOS = {
    // The allow-list gate on exactly the inputs the MuSig2 envelope e2e hands it.
    'co-signer allow-list accepts every standard address template'() {
        const bitcoin = rawLib();
        const { isStandardPaymentScript } = require(path.join(SRC, 'cosigner/co_signer/output_policy.js'));
        const CoSigner = require(path.join(SRC, 'cosigner/coSigner.js'));
        const addresses = standardAddresses(bitcoin);
        for (const [kind, address] of Object.entries(addresses)) {
            const script = bitcoin.address.toOutputScript(address, REGTEST());
            assert(!Buffer.isBuffer(script), `${kind}: toOutputScript should return a raw Uint8Array`);
            const chunks = bitcoin.script.decompile(script);
            assert(chunks.some((c) => c instanceof Uint8Array && !Buffer.isBuffer(c)),
                `${kind}: decompile should return raw Uint8Array pushes`);
            assert.strictEqual(isStandardPaymentScript(script), true, `${kind} script is standard`);
        }
        const { daemonSk, publicKeys } = musigAccount();
        const store = windowStore('allow');
        try {
            // Mirrors createMuSig2Signer in the MuSig2 envelope e2e, one entry per template.
            const co = new CoSigner({
                secretKey: daemonSk, publicKeys, tweaks: [],
                policy: { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 10 } },
                allowedOutputs: Object.values(addresses).map((address) => ({ address, maxValue: 1000 }))
                    .concat([{ script: bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 3) }).output, maxValue: 5 }]),
                windowStore: store, maxFeeSats: 500000, network: REGTEST(),
            });
            assert.strictEqual(co.allowedOutputs.length, 6);
            for (const entry of co.allowedOutputs) assert(Buffer.isBuffer(entry.script), 'entries are normalized to Buffer');
        } finally { store.release(); }
    },

    'co-signer allow-list still refuses bare multisig and OP_RETURN'() {
        const bitcoin = rawLib();
        const { isStandardPaymentScript } = require(path.join(SRC, 'cosigner/co_signer/output_policy.js'));
        const CoSigner = require(path.join(SRC, 'cosigner/coSigner.js'));
        const k = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
        const multisig = bitcoin.payments.p2ms({ m: 1, pubkeys: [k, k, k] }).output;
        const opReturn = bitcoin.payments.embed({ data: [Buffer.from('XCHN')] }).output;
        assert.strictEqual(isStandardPaymentScript(multisig), false);
        assert.strictEqual(isStandardPaymentScript(opReturn), false);
        const { daemonSk, publicKeys } = musigAccount();
        assert.throws(() => new CoSigner({
            secretKey: daemonSk, publicKeys, tweaks: [], policy: { allowedActions: new Set(['SEND']) },
            allowedOutputs: [{ script: multisig, maxValue: 1 }], network: REGTEST(),
        }), /not a standard single-recipient payment script/);
    },

    async 'co-signer signs an allow-listed leg and refuses a drain'() {
        const bitcoin = rawLib();
        const crypto = require('crypto');
        const CoSigner = require(path.join(SRC, 'cosigner/coSigner.js'));
        const CoSignerClient = require(path.join(SRC, 'cosigner/client.js'));
        const { agentSk, daemonSk, publicKeys, account } = musigAccount();
        const addresses = standardAddresses(bitcoin);
        const store = windowStore('sign');
        try {
            const co = new CoSigner({
                secretKey: daemonSk, publicKeys, tweaks: [],
                policy: { allowedActions: new Set(['SEND']) },
                allowedOutputs: [{ address: addresses.P2WPKH, maxValue: 5000 }],
                windowStore: store, maxFeeSats: 50000, network: REGTEST(),
            });
            const client = new CoSignerClient({ transport: CoSignerClient.inProcessTransport(co), publicKeys, tweaks: [] });
            const build = (extraAddress, extraValue) => {
                const prevHash = crypto.randomBytes(32);
                const psbt = new bitcoin.Psbt({ network: REGTEST() });
                psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: account.output, value: 100000n } });
                psbt.addOutput({ script: obfuscatedCarrier(bitcoin, prevHash, 'SEND|0|MYTOKEN|10|1destX|m'), value: 0n });
                psbt.addOutput({ script: account.output, value: 90000n });
                psbt.addOutput({ address: extraAddress, value: extraValue });
                return psbt.toHex();
            };
            const ok = await client.signAll({ psbt: build(addresses.P2WPKH, 4000n), secretKey: agentSk,
                inputIndexes: [0], network: REGTEST() });
            assert.strictEqual(ok.signatures.length, 1);
            let refusal = null;
            try {
                await client.signAll({ psbt: build(addresses.P2TR, 4000n), secretKey: agentSk,
                    inputIndexes: [0], network: REGTEST() });
            } catch (e) { refusal = e; }
            assert(refusal && refusal.code === 'UNAUTHORIZED_OUTPUT', 'a leg to an unlisted address is refused: ' +
                (refusal && refusal.code));
        } finally { store.release(); }
    },

    'carrier binding checks a raw chunk lane instead of skipping it'() {
        const bitcoin = rawLib();
        const crypto = require('crypto');
        const { assertCarrierBinding } = require(path.join(SRC, 'carrier/bind_action_carrier.js'));
        const { verifyCarrierScripts } = require(path.join(SRC, 'carrier/verify_carrier_scripts.js'));
        const net = bitcoin.networks.bitcoin;
        const h160 = Buffer.alloc(20, 0xab);
        const own = bitcoin.payments.p2wpkh({ hash: h160, network: net }).output;
        const lane = (actionString, encoding) => {
            const data = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
            const redeems = [];
            for (let i = 0; i < data.length; i += 40) {
                redeems.push(bitcoin.script.compile([data.subarray(i, i + 40), bitcoin.opcodes.OP_DROP,
                    bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160, h160,
                    bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG]));
            }
            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: own, value: 100000n } });
            for (const r of redeems) {
                const pay = encoding === 'P2SH' ? bitcoin.payments.p2sh : bitcoin.payments.p2wsh;
                psbt.addOutput({ script: pay({ redeem: { output: r }, network: net }).output, value: 1000n });
            }
            psbt.addOutput({ script: own, value: 80000n });
            return { psbt, carrierScripts: redeems.map((r) => Buffer.from(r).toString('hex')) };
        };
        const A = 'SEND|0|TOK|1|1RecipientAAAAAAAAAAAAAAAAAAAAAAAA|m';
        const B = 'SEND|0|TOK|1000|1RecipientBBBBBBBBBBBBBBBBBBBBBBBB|m';
        for (const encoding of ['P2SH', 'P2WSH']) {
            const good = lane(A, encoding);
            const forged = lane(B, encoding);
            // First, because a raw chunk output once read as "no chunk output" and the binding was skipped.
            assert.throws(() => assertCarrierBinding({ psbt: good.psbt, carrierScripts: forged.carrierScripts,
                actionString: A, encoding }), /does not carry the action/, `${encoding}: a forged script is refused`);
            const verified = verifyCarrierScripts({ psbt: good.psbt, carrierScripts: good.carrierScripts,
                encoding, actionString: A, network: net });
            assert.deepStrictEqual(verified, { ok: true, reason: null, checked: good.carrierScripts.length },
                `${encoding}: raw chunk scripts verify`);
            assertCarrierBinding({ psbt: good.psbt, carrierScripts: good.carrierScripts, actionString: A, encoding });
        }
        const k = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
        const multisig = bitcoin.script.compile([bitcoin.opcodes.OP_1, Buffer.alloc(33, 2), Buffer.alloc(33, 3), k,
            bitcoin.opcodes.OP_3, bitcoin.opcodes.OP_CHECKMULTISIG]);
        const psbt = new bitcoin.Psbt({ network: net });
        psbt.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: own, value: 100000n } });
        psbt.addOutput({ script: multisig, value: 1000n });
        psbt.addOutput({ script: own, value: 90000n });
        assert.throws(() => assertCarrierBinding({ psbt, actionString: A, encoding: 'MULTISIGN' }),
            (e) => e.details && e.details.reason === 'MULTISIG_CARRIER_UNSUPPORTED',
            'a raw bare-multisig carrier is still refused');
    },

    'psbt action decode and the decoder parse read raw library bytes'() {
        const bitcoin = rawLib();
        const crypto = require('crypto');
        const { decodeActionFromPsbt } = require(path.join(SRC, 'cosigner/psbt_action_decode.js'));
        const { parse } = require(path.join(SRC, 'decoder/parse.js'));
        const action = 'SEND|0|MYTOKEN|10|1destX|m';
        const own = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 9) }).output;
        const prevHash = crypto.randomBytes(32);
        const psbt = new bitcoin.Psbt();
        psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: own, value: 100000n } });
        psbt.addOutput({ script: obfuscatedCarrier(bitcoin, prevHash, action), value: 0n });
        psbt.addOutput({ script: own, value: 90000n });
        const decoded = decodeActionFromPsbt(psbt.toHex());
        assert.strictEqual(decoded.ok, true, 'raw OP_RETURN carrier decodes: ' + decoded.reason);
        assert.strictEqual(decoded.actionString, action);
        const push = bitcoin.script.decompile(bitcoin.script.compile([Buffer.from(action, 'utf8')]))[0];
        assert(!Buffer.isBuffer(push));
        const fromBytes = parse(push);
        const fromString = parse(action);
        assert.strictEqual(fromBytes.ok, fromString.ok);
        assert.strictEqual(fromBytes.action, fromString.action);
        assert.deepStrictEqual(fromBytes.params, fromString.params);
    },

    'envelope commit derivation and role classification read raw library bytes'() {
        const bitcoin = rawLib();
        const crypto = require('crypto');
        const { deriveEnvelopeCommit, classifyEnvelopeRole, parseEnvelopeScript, envelopeLeafFromPsbtInput } =
            require(path.join(SRC, 'cosigner/envelope.js'));
        const { account } = musigAccount();
        const script = bitcoin.script.compile([bitcoin.opcodes.OP_0, bitcoin.opcodes.OP_IF, Buffer.from('XCHN'),
            Buffer.from([0]), bitcoin.script.compile([Buffer.from('FILE|0|a.txt|text/plain|m', 'utf8')]),
            bitcoin.opcodes.OP_ENDIF, account.aggregateXOnly, bitcoin.opcodes.OP_CHECKSIG]);
        assert(!Buffer.isBuffer(script));
        assert(parseEnvelopeScript(script), 'a raw compiled envelope script parses');
        const commit = deriveEnvelopeCommit({ internalXOnly: new Uint8Array(account.aggregateXOnly),
            envelopeScript: script, network: REGTEST() });
        const funding = new bitcoin.Psbt({ network: REGTEST() });
        funding.addInput({ hash: crypto.randomBytes(32), index: 0, witnessUtxo: { script: account.output, value: 100000n } });
        funding.addOutput({ script: commit.output, value: 5000n });
        assert.strictEqual(classifyEnvelopeRole(bitcoin.Psbt.fromHex(funding.toHex()), commit), 'commit');
        const reveal = new bitcoin.Psbt({ network: REGTEST() });
        reveal.addInput({ hash: crypto.randomBytes(32), index: 0,
            witnessUtxo: { script: commit.output, value: 5000n },
            tapLeafScript: [{ leafVersion: 0xc0, script, controlBlock: commit.controlBlock }] });
        reveal.addOutput({ script: account.output, value: 4000n });
        const parsed = bitcoin.Psbt.fromHex(reveal.toHex());
        assert(envelopeLeafFromPsbtInput(parsed.data.inputs[0]), 'a raw tapLeafScript is read as an envelope leaf');
        assert.strictEqual(classifyEnvelopeRole(parsed, commit), 'reveal', 'a raw reveal is not mistaken for a cancel');
    },
};

async function runChild(name) {
    await SCENARIOS[name]();
    process.stdout.write('SCENARIO OK\n');
}

if (require.main === module) {
    runChild(process.argv[2]).catch((e) => {
        process.stderr.write((e && e.stack) || String(e));
        process.exit(1);
    });
} else {
    describe('bitcoinjs-lib 7 raw Uint8Array values (no Buffer patch loaded)', function () {
        this.timeout(30000);
        for (const name of Object.keys(SCENARIOS)) {
            it(name, function () {
                let out;
                try {
                    out = execFileSync(process.execPath, [__filename, name], { encoding: 'utf8', stdio: 'pipe' });
                } catch (e) {
                    throw new Error(`scenario failed in a clean process:\n${e.stderr || e.message}`);
                }
                assert(out.includes('SCENARIO OK'), out);
            });
        }
    });
}
