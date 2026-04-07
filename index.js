/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
const CrossChainHelper = require('./src/crossChain.js');
const UTXOCache        = require('./src/utxoCache.js');
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
    SDKActionError
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
    UTXOCache,
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
    // Default export for convenience
    default: XChainSDK
};
