// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert  = require('assert');
const crypto  = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { reconcileEncoded } = require('../../../src/carrier/reconcile_encoded.js');
require('../../../src/utils/apply_bufferutils_patch.js');

bitcoin.initEccLib(ecc);

const NET = bitcoin.networks.regtest;

function payTo() {
    const pubkey = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
    const p = bitcoin.payments.p2wpkh({ pubkey, network: NET });
    return { script: p.output, address: p.address };
}

function psbtHex(funding, outputs) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({
        hash: 'aa'.repeat(32), index: 0,
        witnessUtxo: { script: funding.script, value: 100000 },
    });
    for (const out of outputs) psbt.addOutput(out);
    return psbt.toHex();
}

const carrier = (value) => ({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value });
const shapedP2wsh = () => bitcoin.payments.p2wsh({ hash: crypto.randomBytes(32), network: NET }).output;

// ---------------------------------------------------------------------------
// A cap that will not parse is not "no cap".
//
// Both enforcement sites carried `&& parsed !== null`, so a typo'd ceiling
// silently removed the bound the caller believed it had set. Every sibling
// exactU64 caller (co_signer.js, recovery.js) fails closed on the same null.
// ---------------------------------------------------------------------------

describe('reconcileEncoded malformed caps fail closed', function () {
    // An UNSAFE integer Number belongs on this list. It looks exact to
    // Number.isInteger, but JavaScript rounded it before exactU64 ever saw it, so
    // accepting it laundered a lossy value into a cap the fee is then compared
    // against exactly. A cap that large has to arrive as a bigint or digit string,
    // and the >2^53 fee-cap case above proves both of those forms still pass intact.
    const MALFORMED = [-1, 1.5, '5o00', '', 'abc', NaN, -1n, {},
                       Number.MAX_SAFE_INTEGER + 1, 9007199254740993];

    it('DENIES a malformed maxFeeSats instead of dropping the fee ceiling', function () {
        const funding = payTo();
        const hex = psbtHex(funding, [carrier(0), { script: funding.script, value: 90000 }]);
        for (const bad of MALFORMED)
            assert.throws(() => reconcileEncoded(hex, { network: NET, maxFeeSats: bad }),
                          (e) => e.code === 'MALFORMED_FEE_CAP', 'maxFeeSats=' + String(bad));
        // null/undefined still mean "no cap", which is a different answer from a typo.
        assert.strictEqual(reconcileEncoded(hex, { network: NET, maxFeeSats: null }).fee, 10000n);
        assert.strictEqual(reconcileEncoded(hex, { network: NET }).fee, 10000n);
        assert.strictEqual(reconcileEncoded(hex, { network: NET, maxFeeSats: 10000 }).fee, 10000n);
    });

    it('DENIES a malformed maxPhaseFundingSats instead of dropping the leg ceiling', function () {
        const funding = payTo();
        const hex = psbtHex(funding, [{ script: shapedP2wsh(), value: 90000 }]);
        const intent = { network: NET, phaseShapes: ['p2wsh'] };
        for (const bad of MALFORMED)
            assert.throws(() => reconcileEncoded(hex, Object.assign({ maxPhaseFundingSats: bad }, intent)),
                          (e) => e.code === 'MALFORMED_PHASE_FUNDING_CAP', 'maxPhaseFundingSats=' + String(bad));
        assert.doesNotThrow(() => reconcileEncoded(hex, Object.assign({ maxPhaseFundingSats: null }, intent)));
        assert.doesNotThrow(() => reconcileEncoded(hex, Object.assign({ maxPhaseFundingSats: 90000 }, intent)));
    });
});
