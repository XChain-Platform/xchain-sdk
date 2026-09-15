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
const fs = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
require('../../../../src/utils/apply_bufferutils_patch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2      = require('../../../../src/cosigner/musig2.js');
const CoSigner    = require('../../../../src/cosigner/co_signer.js');
const WindowStore = require('../../../../src/cosigner/window_store.js');
const { evaluatePolicy } = require('../../../../src/cosigner/policy_evaluator.js');
const { decodeActionFromPsbt } = require('../../../../src/cosigner/psbt_action_decode.js');
const { deriveMuSig2P2TR2of3 } = require('../../../../src/cosigner/account.js');
const valueDerivability = require('../../../../src/cosigner/value_derivability.js');

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

// A PSBT spending the account, carrying `actionString` in an obfuscated
// OP_RETURN built exactly as xchain-encoder builds it.
function buildSignablePsbt(acct, actionString) {
    const prevHash = crypto.randomBytes(32);
    const txid   = Buffer.from(prevHash).reverse().toString('hex');
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const tagged = Buffer.concat([Buffer.from('XCHN'), inner]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf    = Buffer.concat([cipher.update(tagged), cipher.final()]);

    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: 90000 });
    return psbt;
}

// A live agent nonce, so an APPROVED path actually reaches the signing step.
function agentNonce(acct) {
    return new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
}

function tmpStateFile(tag) {
    return path.join(os.tmpdir(), `cosigner-${tag}-${crypto.randomBytes(6).toString('hex')}.json`);
}

module.exports = {
    expect,
    fs,
    path,
    crypto,
    bitcoin,
    secp256k1,
    schnorr,
    MuSig2,
    CoSigner,
    WindowStore,
    evaluatePolicy,
    decodeActionFromPsbt,
    deriveMuSig2P2TR2of3,
    valueDerivability,
    makeAccount,
    buildSignablePsbt,
    agentNonce,
    tmpStateFile,
};
