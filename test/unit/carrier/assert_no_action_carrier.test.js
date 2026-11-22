/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const { assertNoActionCarrier } = require('../../../src/carrier/assert_no_action_carrier.js');

const NET = bitcoin.networks.regtest;
const OWN = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 7), network: NET }).output;

function transaction(outputs) {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: '11'.repeat(32), index: 0,
        witnessUtxo: { script: OWN, value: 100000n } });
    outputs.forEach(output => psbt.addOutput(output));
    return psbt;
}

const refusedWith = (code, reason) => error => error.code === code
    && error.details && error.details.reason === reason;

describe('actionless transaction carrier guard', function () {
    it('accepts ordinary payment and change outputs', function () {
        const psbt = transaction([{ script: OWN, value: 40000n }, { script: OWN, value: 59000n }]);
        assert.doesNotThrow(() => assertNoActionCarrier({ psbt, network: NET }));
        assert.doesNotThrow(() => assertNoActionCarrier({ psbt: psbt.toHex(), network: NET }));
    });

    it('refuses every OP_RETURN shape without decoding its payload', function () {
        for (const script of [bitcoin.script.compile([bitcoin.opcodes.OP_RETURN]),
            bitcoin.payments.embed({ data: [Buffer.from('decoy')] }).output,
            bitcoin.payments.embed({ data: [Buffer.from('XCHNSEND|0|TOK|1|recipient|m')] }).output]) {
            const psbt = transaction([{ script, value: 0n }, { script: OWN, value: 99000n }]);
            assert.throws(() => assertNoActionCarrier({ psbt, network: NET }),
                refusedWith('UNEXPECTED_DATA_CARRIER', 'OP_RETURN'));
        }
    });

    it('refuses a bare multisig output', function () {
        const pubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 3)]);
        const script = bitcoin.payments.p2ms({ m: 1, pubkeys: [pubkey] }).output;
        const psbt = transaction([{ script, value: 1000n }, { script: OWN, value: 98000n }]);
        assert.throws(() => assertNoActionCarrier({ psbt, network: NET }),
            refusedWith('UNEXPECTED_DATA_CARRIER', 'MULTISIG_CARRIER'));
    });

    it('fails closed on an unreadable PSBT', function () {
        assert.throws(() => assertNoActionCarrier({ psbt: 'not-hex', network: NET }),
            refusedWith('CARRIER_UNREADABLE', 'PSBT_PARSE_FAILED'));
    });
});
