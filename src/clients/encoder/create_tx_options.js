/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Encoder Client
 *
 * The optional create_tx fields, shared by every request that builds one
 *
 ********************************************************************/

'use strict';

// The optional createTx fields, named ONCE. Both high-level entry points
// (sdk.createAction and LifecycleManager.submitAction) and the phase-2 reveal
// request (submitAction and spendP2sh) read this list instead of enumerating
// fields by hand, because a field one of them misses is dropped with no error: a
// missing feeQuote loses the protocol-fee output and mines a transaction protocol
// validation then rejects, burning the miner fee; a missing compress, options or
// sourceAddress loses the FILE compression policy, the Taproot signer capability
// or the source-address UTXO selection. Adding a field to createTx means adding
// it here, and every caller gets it.
const CREATE_TX_OPTION_FIELDS = [
    'change', 'utxos', 'rawData', 'encoding', 'fee', 'feePerKb', 'rbf', 'dust',
    'unconfirmed', 'compressedPubKey', 'customOutputs', 'attachPrevTx',
    'feeQuote', 'compress', 'options', 'sourceAddress'
];

// The fields a phase-2 reveal request leaves out. A reveal spends only the phase-1
// legs, so it takes no funding inputs (utxos, sourceAddress) and none of the per-call
// options, which steer funding selection (exactInputs, which the encoder refuses beside
// p2shHash) or pick the carrier (AUTO's signer capability).
const REVEAL_EXCLUDED_FIELDS = ['utxos', 'sourceAddress', 'options'];

// Copy the caller's SET createTx options onto `into` (a fresh object by default).
// Undefined stays absent: createTx's own mapper reads absent and explicit-false as
// different wire meanings (compress is tri-state), so copying undefined through
// would change what the encoder is asked for.
function pickCreateTxOptions(src, into) {
    const out = into || {};
    if (!src) return out;
    for (const key of CREATE_TX_OPTION_FIELDS)
        if (src[key] !== undefined) out[key] = src[key];
    return out;
}

// The same copy, onto a fresh object, for a phase-2 reveal request: every createTx
// option except REVEAL_EXCLUDED_FIELDS.
function pickRevealOptions(src) {
    const out = pickCreateTxOptions(src);
    for (const key of REVEAL_EXCLUDED_FIELDS) delete out[key];
    return out;
}

module.exports = { CREATE_TX_OPTION_FIELDS, REVEAL_EXCLUDED_FIELDS, pickCreateTxOptions, pickRevealOptions };
