// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const crypto  = require('crypto');
require('../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1 } = require('@noble/curves/secp256k1');
const MuSig2      = require('../../../src/cosigner/musig2.js');
const CoSigner    = require('../../../src/cosigner/co_signer.js');
const { evaluatePolicy, UNRESOLVED_TICK_BUCKET, formatCarriesDestination } =
    require('../../../src/cosigner/policy_evaluator.js');
const valueDerivability = require('../../../src/cosigner/value_derivability.js');

function makeAccount() {
    const musig   = new MuSig2();
    const agentSk = crypto.randomBytes(32);
    const coSk    = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true);
    const coPk    = secp256k1.getPublicKey(coSk, true);
    const keys    = [agentPk, coPk];
    const bare    = musig.aggregateKeys(keys);
    const p2tr    = bitcoin.payments.p2tr({ pubkey: Buffer.from(bare.xOnlyPubkey) });
    return { musig, agentSk, coSk, agentPk, coPk, keys, p2trScript: p2tr.output };
}

function carrier(actionString, txidHex) {
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const tagged = Buffer.concat([Buffer.from('XCHN'), inner]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txidHex.substr(0, 16), txidHex.substr(16, 16));
    return Buffer.concat([cipher.update(tagged), cipher.final()]);
}

function buildSignablePsbt(acct, actionString, opts = {}) {
    const prevHash = crypto.randomBytes(32);
    const txid = Buffer.from(prevHash).reverse().toString('hex');
    const psbt = new bitcoin.Psbt();

    if (opts.foreignFirstInput) {
        psbt.addInput({
            hash: prevHash, index: 0,
            witnessUtxo: { script: opts.foreignScript, value: 50000 },
        });
        const ourHash = crypto.randomBytes(32);
        psbt.addInput({
            hash: ourHash, index: 0,
            witnessUtxo: { script: acct.p2trScript, value: 100000 },
        });
    } else {
        psbt.addInput({
            hash: prevHash, index: 0,
            witnessUtxo: { script: acct.p2trScript, value: 100000 },
        });
    }
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [carrier(actionString, txid)] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: opts.changeValue ?? 90000 });
    for (const extra of opts.extraOutputs || []) psbt.addOutput(extra);
    return psbt;
}

function nonce(acct) {
    return new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
}

function one(acct, index = 0) {
    return [{ index, agentPublicNonce: nonce(acct) }];
}

// G9: allowedDestinations must not be a silent no-op.

describe('G9: allowedDestinations enforceability', function () {

    it('denies an action whose format carries no DESTINATION field', function () {
        // Only 7 of the 63 decodable formats carry DESTINATION. For every other one
        // the destination list was EMPTY and the membership loop was vacuously
        // satisfied, so every trade, dispenser, staking and escrow action sailed
        // through a setting the operator reads as "can only pay these addresses".
        const acct = makeAccount();
        const co = new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['DESTROY']), allowedDestinations: ['1allowedAddr'] },
        });
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'DESTROY|0|TOK|5|m').toHex(),
            inputs: one(acct),
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_DESTINATION_UNENFORCEABLE');
    });

    it('pins the 7-of-68 figure the G9 rationale quotes, derived from the format table', function () {
        // The comment in policy_evaluator.js sizes how little of the policy
        // surface allowedDestinations binds, and a hand-counted figure drifts
        // the moment a format gains or loses a DESTINATION field. Derive both
        // halves from the shipped tables instead: decodableFormats() is the
        // daemon's own denominator (it already drops the multi-leg SEND v1-v3,
        // which the decoder refuses as MULTI_LEG_UNSUPPORTED), and
        // formatCarriesDestination is the predicate the gate itself calls.
        const decodable = valueDerivability.decodableFormats();
        const carriers = decodable
            .filter((f) => formatCarriesDestination(f.action, f.version))
            .map((f) => `${f.action} v${f.version}`)
            .sort();
        // 63 -> 68 once ISSUE v7 and XBRIDGE v0/v1/v3/v4 joined the action set.
        // The NUMERATOR did not move: an XBRIDGE names its counterparty in
        // DEST_ADDRESS / BTC_ADDRESS / ORIGIN_ADDRESS, none of which is the
        // DESTINATION field allowedDestinations reads, so the list still binds
        // exactly the seven formats below. Keep the figure in the rationale
        // comment at src/cosigner/policy_evaluator.js in step with this number.
        expect(decodable.length).to.equal(68);
        expect(carriers).to.deep.equal([
            'MESSAGE v0', 'MESSAGE v1', 'MESSAGE v2', 'MESSAGE v3',
            'MINT v0', 'SEND v0', 'SWEEP v0',
        ]);
    });

});
describe('G9: allowedDestinations enforceability', function () {

    it('still enforces the list for a format that does carry DESTINATION', function () {
        const acct = makeAccount();
        const co = new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']), allowedDestinations: ['1allowedAddr'] },
        });
        expect(co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|TOK|5|1allowedAddr|m').toHex(),
            inputs: one(acct),
        }).approved).to.equal(true);

        const denied = co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|TOK|5|1otherAddr|m').toHex(),
            inputs: one(acct),
        });
        expect(denied.approved).to.equal(false);
        expect(denied.reason).to.equal('POLICY_DESTINATION_DENIED');
    });

    it('leaves a policy with no destination list alone', function () {
        const acct = makeAccount();
        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['DESTROY']) } });
        expect(co.process({
            psbt: buildSignablePsbt(acct, 'DESTROY|0|TOK|5|m').toHex(),
            inputs: one(acct),
        }).approved).to.equal(true);
    });

});
