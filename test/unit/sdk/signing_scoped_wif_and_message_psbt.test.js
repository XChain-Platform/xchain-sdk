/*
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 */

// submitAction limits commit signing to the supplied utxos, and message send
// reconciles the encoder PSBT before it is signed.

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const { XChainSDK } = require('../../../index.js');
const WalletUtils = require('../../../src/utils/wallet.js');
const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

const NETWORK = 'bitcoin-regtest';

function fixture(outputs) {
    const wallet = new WalletUtils(NETWORK);
    const net = getNetwork(NETWORK);
    const kp = wallet.generateKeyPair();
    const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
    const prev = new bitcoin.Transaction();
    prev.version = 2;
    prev.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prev.addOutput(script, 100000);
    prev.addOutput(script, 100000);
    const psbt = new bitcoin.Psbt({ network: net });
    for (const index of [0, 1])
        psbt.addInput({ hash: prev.getId(), index, sequence: 0xfffffffd, witnessUtxo: { script, value: 100000 } });
    for (const out of outputs(script)) psbt.addOutput(out);
    return { wallet, kp, script, psbt, txid: prev.getId() };
}

const carrier = () => bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('xc')]);

describe('scoped WIF signing on submitAction', function () {
    afterEach(() => sinon.restore());

    function capture(sdk, utxos, opts) {
        let seen;
        sinon.stub(LifecycleManager.prototype, 'submitAction').callsFake(function () { seen = this.sdk; return {}; });
        return sdk.submitAction({ action: 'SEND', params: {} }, utxos ? { utxos } : {}, opts).then(() => seen);
    }

    it('signs only the supplied utxos and finalizes', async function () {
        const f = fixture(s => [{ script: s, value: 90000 }, { script: carrier(), value: 0 }]);
        const sdk = new XChainSDK({ network: NETWORK });
        const view = await capture(sdk, [{ txid: f.txid, vout: 0 }, { txid: f.txid, vout: 1 }]);
        const signed = view.wallet.signPsbt(f.psbt.toHex(), f.kp.wif);
        expect(signed.txHex).to.be.a('string');
    });

    it('refuses an unsigned input the caller never named', async function () {
        const f = fixture(s => [{ script: s, value: 90000 }]);
        const sdk = new XChainSDK({ network: NETWORK });
        const view = await capture(sdk, [{ txid: f.txid, vout: 0 }]);
        expect(() => view.wallet.signPsbt(f.psbt.toHex(), f.kp.wif))
            .to.throw().with.property('code', 'UNAPPROVED_INPUT');
    });

    it('leaves the sdk unscoped when no utxos are supplied', async function () {
        const sdk = new XChainSDK({ network: NETWORK });
        expect(await capture(sdk, null)).to.equal(sdk);
    });

    it('leaves a custom signer path untouched', async function () {
        const sdk = new XChainSDK({ network: NETWORK });
        expect(await capture(sdk, [{ txid: 'aa', vout: 0 }], { signer: () => ({}) })).to.equal(sdk);
    });
});

describe('message send reconciles the encoder PSBT', function () {
    function build(psbtHex, wallet) {
        const sdk = {
            requireExplorer: () => ({}),
            requireEncoder: () => ({}),
            createAction: async () => ({ psbt: psbtHex, actionString: 'MESSAGE|x' }),
            wallet: {
                getBitcoinNetwork: () => wallet.getBitcoinNetwork(),
                signPsbt: sinon.stub().returns({ txHex: 'aa', txid: 'bb' }),
                broadcastTx: sinon.stub().resolves({})
            }
        };
        return sdk;
    }

    async function run(f, outputsOk) {
        const Messaging = require('../../../src/actions/messaging.js');
        const msg = new Messaging(NETWORK);
        const sdk = build(f.psbt.toHex(), f.wallet);
        const pub = f.kp.publicKey.toString('hex');
        const p = msg.send({
            wif: f.kp.wif, coin: 'BTC', destination: 'addr', message: 'hi', method: null,
            encoder: { pubkey: pub }
        }, sdk);
        return { sdk, p };
    }

    it('signs a PSBT whose outputs it can account for', async function () {
        const f = fixture(s => [{ script: s, value: 190000 }, { script: carrier(), value: 0 }]);
        const { sdk, p } = await run(f);
        await p;
        expect(sdk.wallet.signPsbt.calledOnce).to.be.true;
    });

    it('refuses before signing when an output goes to a stranger', async function () {
        const other = bitcoin.payments.p2wpkh({
            pubkey: new WalletUtils(NETWORK).generateKeyPair().publicKey, network: getNetwork(NETWORK)
        }).output;
        const f = fixture(() => [{ script: other, value: 190000 }, { script: carrier(), value: 0 }]);
        const { sdk, p } = await run(f);
        let err;
        try { await p; } catch (e) { err = e; }
        expect(err, 'send should reject').to.exist;
        expect(sdk.wallet.signPsbt.called).to.be.false;
    });
});
