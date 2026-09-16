// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// Each prototype at sdk 95b10404, before the splits.
// Rows are [key, enumerable, writable, configurable, typeof value, function length].

module.exports = {
    WalletUtils: [
        ['_maxFeeRate', false, true, true, 'function', 1],
        ['_resolveNet', false, true, true, 'function', 1],
        ['_xchainRevealFinalizer', false, true, true, 'function', 1],
        ['broadcastTx', false, true, true, 'function', 2],
        ['constructor', false, true, true, 'function', 1],
        ['decomposePsbt', false, true, true, 'function', 1],
        ['deriveAddress', false, true, true, 'function', 1],
        ['deriveMultisigAddress', false, true, true, 'function', 1],
        ['finalizeMultisigPsbt', false, true, true, 'function', 2],
        ['generateKeyPair', false, true, true, 'function', 0],
        ['getBitcoinNetwork', false, true, true, 'function', 1],
        ['getUTXOs', false, true, true, 'function', 2],
        ['importWIF', false, true, true, 'function', 1],
        ['signEcdsa', false, true, true, 'function', 2],
        ['signEnvelopeRevealPsbt', false, true, true, 'function', 3],
        ['signMultisigPsbt', false, true, true, 'function', 2],
        ['signPsbt', false, true, true, 'function', 3],
        ['signRevealPsbt', false, true, true, 'function', 3],
        ['txidOf', false, true, true, 'function', 1],
        ['validateAddress', false, true, true, 'function', 2],
    ],
    LifecycleManager: [
        ['_awaitContract', false, true, true, 'function', 5],
        ['_extractChangeOutputs', false, true, true, 'function', 2],
        ['_extractSpentInputs', false, true, true, 'function', 1],
        ['_reconcileNetwork', false, true, true, 'function', 0],
        ['constructor', false, true, true, 'function', 1],
        ['submitAction', false, true, true, 'function', 1],
    ],
    Validator: [
        ['_checkDelimiters', false, true, true, 'function', 2],
        ['_error', false, true, true, 'function', 2],
        ['_isEmpty', false, true, true, 'function', 1],
        ['_isValidListAddress', false, true, true, 'function', 1],
        ['_issueFormat', false, true, true, 'function', 1],
        ['_legsOf', false, true, true, 'function', 1],
        ['_scanDelimiters', false, true, true, 'function', 2],
        ['_validateAction', false, true, true, 'function', 2],
        ['_validateBatch', false, true, true, 'function', 1],
        ['_validateBatchCommand', false, true, true, 'function', 2],
        ['_validateBet', false, true, true, 'function', 1],
        ['_validateBetDetails', false, true, true, 'function', 3],
        ['_validateBridgeOptIn', false, true, true, 'function', 1],
        ['_validateBroadcast', false, true, true, 'function', 1],
        ['_validateControllerBind', false, true, true, 'function', 1],
        ['_validateDelegate', false, true, true, 'function', 1],
        ['_validateDeploy', false, true, true, 'function', 1],
        ['_validateDeployCarrier', false, true, true, 'function', 1],
        ['_validateDispenser', false, true, true, 'function', 1],
        ['_validateField', false, true, true, 'function', 4],
        ['_validateIssueTickRef', false, true, true, 'function', 2],
        ['_validateLegsShape', false, true, true, 'function', 2],
        ['_validateList', false, true, true, 'function', 1],
        ['_validateListAddressItems', false, true, true, 'function', 1],
        ['_validateOrder', false, true, true, 'function', 1],
        ['_validateSwap', false, true, true, 'function', 1],
        ['_validateTickName', false, true, true, 'function', 2],
        ['_validateVote', false, true, true, 'function', 1],
        ['_withLeg', false, true, true, 'function', 2],
        ['constructor', false, true, true, 'function', 2],
        ['validate', false, true, true, 'function', 2],
        ['validateOrThrow', false, true, true, 'function', 2],
    ],
    CoSigner: [
        ['checkFee', false, true, true, 'function', 1],
        ['checkOutputs', false, true, true, 'function', 3],
        ['checkPrevouts', false, true, true, 'function', 3],
        ['checkSource', false, true, true, 'function', 3],
        ['deny', false, true, true, 'function', 2],
        ['normalizeAllowedOutputs', false, true, true, 'function', 1],
        ['recordBudget', false, true, true, 'function', 2],
        ['toU64', false, true, true, 'function', 1],
        ['constructor', false, true, true, 'function', 0],
        ['process', false, true, true, 'function', 0],
    ],
};
