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
 * XChain Platform SDK - Module Entry Point
 *
 * Usage:
 *   const { XChainSDK, BatchBuilder } = require('xchain-sdk');
 *   const sdk = new XChainSDK({ network: 'bitcoin-mainnet', ... });
 *
 ********************************************************************/

const XChainSDK        = require('./src/XChainSDK.js');
const BatchBuilder     = require('./src/carrier/batch_builder.js');
const ContractClient   = require('./src/contract/client.js');
const ContractUtils    = require('./src/contract/utils.js');
const WalletUtils      = require('./src/utils/wallet.js');
const WalletSession    = require('./src/utils/wallet_session.js');
const AgentSession     = require('./src/cosigner/agent_session.js');
const MuSig2AgentSession = require('./src/cosigner/musig2_agent_session.js');
const coSigner = require('./src/cosigner/index.js');
const decoder  = require('./src/decoder/index.js');
const { X402Gateway, X402Client, parseActionString: x402ParseActionString } = require('./src/utils/x402.js');
const AuthUtils        = require('./src/utils/auth.js');
const CrossChainHelper   = require('./src/actions/cross_chain.js');
const AttestationHelpers = require('./src/actions/attestation.js');
const NftHelpers         = require('./src/actions/nft.js');
const ProjectHelpers     = require('./src/actions/project.js');
const ControllerHelpers  = require('./src/actions/controller.js');
const VoteHelpers        = require('./src/actions/vote.js');
const UTXOCache        = require('./src/carrier/utxo_cache.js');
const MuSig2           = require('./src/cosigner/musig2.js');
const chunkHelper      = require('./src/contract/chunk_helper.js');
const CheckpointVerifier = require('./src/checkpoint.js');
const LightClient        = require('./src/protocol/light_client.js');
const PinnedCheckpoints  = require('./src/protocol/pinned_checkpoints.js');
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
    SDKMuSigError,
    SDKPolicyError,
    SDKX402Error,
    SDKPreflightError,
    SDKRateLimitedError
} = require('./src/utils/errors.js');

module.exports = {
    XChainSDK,
    BatchBuilder,
    ContractClient,
    ContractUtils,
    WalletUtils,
    WalletSession,
    AgentSession,
    MuSig2AgentSession,
    // First-class decode library (parse/describe/decodeActionFromPsbt):
    // also reachable as `sdk.decoder`.
    decoder,
    // Pre-flight finding-code registry + constants (schemaVersion, TTLs,
    // certified error list): the wallet imports these rather than
    // re-literaling any quantified value.
    preflightConstants: require('./src/preflight/constants.js'),
    // MuSig2 co-signer toolkit (browser-safe): also reachable as `sdk.coSigner`.
    coSigner,
    CoSigner: coSigner.CoSigner,
    CoSignerClient: coSigner.CoSignerClient,
    deriveMuSig2P2TR: coSigner.deriveMuSig2P2TR,
    deriveMuSig2P2TR2of3: coSigner.deriveMuSig2P2TR2of3,
    buildMuSig2Signer: coSigner.buildMuSig2Signer,
    buildRecoverySpend: coSigner.buildRecoverySpend,
    localPairSigner: coSigner.localPairSigner,
    X402Gateway,
    X402Client,
    x402ParseActionString,
    AuthUtils,
    CrossChainHelper,
    AttestationHelpers,
    NftHelpers,
    ProjectHelpers,
    ControllerHelpers,
    VoteHelpers,
    UTXOCache,
    MuSig2,
    chunkHelper,
    CheckpointVerifier,
    LightClient,
    PinnedCheckpoints,
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
    SDKPolicyError,
    SDKX402Error,
    SDKPreflightError,
    SDKRateLimitedError,
    // Default export for convenience
    default: XChainSDK
};
