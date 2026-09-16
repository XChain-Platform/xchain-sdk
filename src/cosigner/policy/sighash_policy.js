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
 * XChain Platform SDK - which sighash types this co-signer will sign under
 *
 * ONE definition, because two message-derivation paths enforce it and a
 * duplicated fund-safety predicate drifts. `taprootKeyPathSighash` (ordinary
 * spends and envelope commit/cancel) and `envelopeScriptPathSighash` (the
 * envelope reveal) both derive a signing message from a PSBT, and both are
 * exported, so each must fail closed on its own rather than relying on
 * CoSigner.process()'s step-8 gate still running first.
 *
 * The rule: only a sighash type that commits to EVERY output. A partial
 * signature made under NONE/SINGLE/ANYONECANPAY can be reassembled by the
 * agent into a drain transaction that still verifies, which is exactly what
 * the output gate exists to prevent.
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');

// SIGHASH_DEFAULT (BIP341 0x00) is the only finalizable type here. `undefined`
// means "unspecified", which the derivations resolve to SIGHASH_DEFAULT.
const ALLOWED_SIGHASH = new Set([bitcoin.Transaction.SIGHASH_DEFAULT]);

function sighashAllowed(hashType) {
    return hashType === undefined || ALLOWED_SIGHASH.has(hashType);
}

// One wording for both derivation paths, so an operator reading either stack
// trace sees the same sentence.
function disallowedSighashError(hashType) {
    return new Error('disallowed sighashType 0x' +
        Number(hashType).toString(16).padStart(2, '0') +
        ' (only SIGHASH_DEFAULT is finalizable by this signer)');
}

module.exports = { ALLOWED_SIGHASH, sighashAllowed, disallowedSighashError };
