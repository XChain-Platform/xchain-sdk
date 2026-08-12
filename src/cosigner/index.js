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
 * XChain Platform SDK - Co-Signer Toolkit (public surface)
 *
 * The browser-safe MuSig2 co-signer pieces, re-exported as one namespace so
 * consumers (the wallet's passive co-signer, custom daemons) build on the
 * SDK's public API instead of reaching into src/. Exposed as `sdk.coSigner`
 * and as named package exports.
 *
 * DELIBERATELY NOT re-exported here (Node-only; require them directly in a
 * Node daemon): `windowStore.js` (uses `fs` for the persisted budget) and
 * `server.js` (`createCoSignerApp`, uses `express`). Everything below is pure
 * bitcoinjs/@noble and runs in the browser bundle the wallet ships.
 *
 ********************************************************************/

'use strict';

const { deriveMuSig2P2TR, deriveMuSig2P2TR2of3 } = require('./account.js');
const CoSigner = require('./coSigner.js');
const CoSignerClient = require('./client.js');
const { buildMuSig2Signer } = require('./musig2Signer.js');
const { buildRecoverySpend, localPairSigner, tapleafHash } = require('./recovery.js');
const { evaluatePolicy } = require('./policyEvaluator.js');
const { decodeActionFromPsbt, decodeEnvelopeAction } = require('./psbtActionDecode.js');
const {
    parseEnvelopeScript, deriveEnvelopeCommit, envelopeScriptPathSighash,
    envelopeLeafFromPsbtInput, classifyEnvelopeRole, envelopeLeafHash,
    envelopeRoundTweaks,
} = require('./envelope.js');

module.exports = {
    // Service core: decode-from-PSBT -> policy -> partial sign (the daemon half).
    CoSigner,
    // Agent half: drives the round, aggregates to the final key-path signature.
    CoSignerClient,
    inProcessTransport: CoSignerClient.inProcessTransport,
    httpTransport:      CoSignerClient.httpTransport,
    // Account derivation: 2-of-2 key-path, and the 2-of-3 recovery tap tree.
    deriveMuSig2P2TR,
    deriveMuSig2P2TR2of3,
    // A signPsbt-shaped adapter that completes the spend through a CoSignerClient.
    buildMuSig2Signer,
    // Operator script-path recovery spend (when a party is lost).
    buildRecoverySpend,
    localPairSigner,
    tapleafHash,
    // Shared primitives (same policy brain + PSBT decoder both halves use).
    evaluatePolicy,
    decodeActionFromPsbt,
    // Taproot envelope (§3.9): the derivations both halves share, so a
    // caller building an envelope round never has to hand either side a tweak.
    parseEnvelopeScript,
    deriveEnvelopeCommit,
    envelopeScriptPathSighash,
    envelopeLeafFromPsbtInput,
    classifyEnvelopeRole,
    envelopeLeafHash,
    envelopeRoundTweaks,
    decodeEnvelopeAction,
};
