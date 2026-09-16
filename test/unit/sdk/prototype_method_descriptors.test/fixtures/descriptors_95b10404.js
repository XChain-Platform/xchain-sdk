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
        ['resolveNet', false, true, true, 'function', 1],
        ['xchainRevealFinalizer', false, true, true, 'function', 1],
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
        ['extractChangeOutputs', false, true, true, 'function', 2],
        ['extractSpentInputs', false, true, true, 'function', 1],
        ['reconcileNetwork', false, true, true, 'function', 0],
        ['constructor', false, true, true, 'function', 1],
        ['submitAction', false, true, true, 'function', 1],
    ],
    Validator: [
        ['checkDelimiters', false, true, true, 'function', 2],
        ['buildError', false, true, true, 'function', 2],
        ['isEmpty', false, true, true, 'function', 1],
        ['isValidListAddress', false, true, true, 'function', 1],
        ['issueFormat', false, true, true, 'function', 1],
        ['legsOf', false, true, true, 'function', 1],
        ['scanDelimiters', false, true, true, 'function', 2],
        ['validateAction', false, true, true, 'function', 2],
        ['_validateBatch', false, true, true, 'function', 1],
        ['validateBatchCommand', false, true, true, 'function', 2],
        ['_validateBet', false, true, true, 'function', 1],
        ['_validateBetDetails', false, true, true, 'function', 3],
        ['validateBridgeOptIn', false, true, true, 'function', 1],
        ['validateBroadcast', false, true, true, 'function', 1],
        ['validateControllerBind', false, true, true, 'function', 1],
        ['validateDelegate', false, true, true, 'function', 1],
        ['validateDeploy', false, true, true, 'function', 1],
        ['validateDeployCarrier', false, true, true, 'function', 1],
        ['validateDispenser', false, true, true, 'function', 1],
        ['_validateField', false, true, true, 'function', 4],
        ['validateIssueTickRef', false, true, true, 'function', 2],
        ['validateLegsShape', false, true, true, 'function', 2],
        ['validateList', false, true, true, 'function', 1],
        ['validateListAddressItems', false, true, true, 'function', 1],
        ['validateOrder', false, true, true, 'function', 1],
        ['validateSwap', false, true, true, 'function', 1],
        ['validateTickName', false, true, true, 'function', 2],
        ['validateVote', false, true, true, 'function', 1],
        ['withLeg', false, true, true, 'function', 2],
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
