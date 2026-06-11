/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Module Entry Point
 *
 * Usage:
 *   const { XChainSDK, BatchBuilder } = require('xchain-sdk');
 *   const sdk = new XChainSDK({ network: 'bitcoin-mainnet', ... });
 *
 ********************************************************************/

const XChainSDK        = require('./src/XChainSDK.js');
const BatchBuilder     = require('./src/batchBuilder.js');
const ContractClient   = require('./src/contractClient.js');
const ContractUtils    = require('./src/contracts.js');
const WalletUtils      = require('./src/wallet.js');
const WalletSession    = require('./src/walletSession.js');
const AuthUtils        = require('./src/auth.js');
const CrossChainHelper   = require('./src/crossChain.js');
const AttestationHelpers = require('./src/attestation.js');
const NftHelpers         = require('./src/nft.js');
const ProjectHelpers     = require('./src/project.js');
const UTXOCache        = require('./src/utxoCache.js');
const MuSig2           = require('./src/musig2.js');
const { startREPL }   = require('./src/repl.js');
const {
    SDKError,
    SDKValidationError,
    SDKFormatError,
    SDKEncoderError,
    SDKExplorerError,
    SDKHubError,
    SDKConfigError,
    SDKContractError,
    SDKWalletError,
    SDKAuthError,
    SDKMessagingError,
    SDKActionError,
    SDKMuSigError
} = require('./src/errors.js');

module.exports = {
    XChainSDK,
    BatchBuilder,
    ContractClient,
    ContractUtils,
    WalletUtils,
    WalletSession,
    AuthUtils,
    CrossChainHelper,
    AttestationHelpers,
    NftHelpers,
    ProjectHelpers,
    UTXOCache,
    MuSig2,
    startREPL,
    SDKError,
    SDKValidationError,
    SDKFormatError,
    SDKEncoderError,
    SDKExplorerError,
    SDKHubError,
    SDKConfigError,
    SDKContractError,
    SDKWalletError,
    SDKAuthError,
    SDKMessagingError,
    SDKActionError,
    SDKMuSigError,
    // Default export for convenience
    default: XChainSDK
};
