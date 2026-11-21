/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const { SDKActionError } = require('../utils/errors.js');

function unreadable(label, reason, details = {}) {
    throw new SDKActionError('CARRIER_UNREADABLE',
        `${label}: cannot prove the transaction carries no action`, { reason, ...details });
}

function asPsbt(psbt, network, label) {
    if (psbt && typeof psbt !== 'string' && Array.isArray(psbt.txOutputs)) return psbt;
    try { return bitcoin.Psbt.fromHex(psbt, { network }); }
    catch (error) { return unreadable(label, 'PSBT_PARSE_FAILED', { detail: error.message }); }
}

function carrierReason(script, label, index) {
    let decompiled;
    try { decompiled = bitcoin.script.decompile(script); }
    catch (error) {
        return unreadable(label, 'OUTPUT_SCRIPT_UNREADABLE', { index, detail: error.message });
    }
    if (!Array.isArray(decompiled)) return unreadable(label, 'OUTPUT_SCRIPT_UNREADABLE', { index });
    if (decompiled[0] === bitcoin.opcodes.OP_RETURN) return 'OP_RETURN';
    if (decompiled[decompiled.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG)
        return 'MULTISIG_CARRIER';
    return null;
}

// Actionless transactions must not contain any output the decoder can use as a carrier.
function assertNoActionCarrier({ psbt, network, label = 'transaction' }) {
    const parsed = asPsbt(psbt, network, label);
    for (let index = 0; index < parsed.txOutputs.length; index += 1) {
        const reason = carrierReason(parsed.txOutputs[index].script, label, index);
        if (reason) throw new SDKActionError('UNEXPECTED_DATA_CARRIER',
            `${label}: the encoder added a data-carrier output`, { reason, index });
    }
}

module.exports = { assertNoActionCarrier };
