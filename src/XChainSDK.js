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
 * XChain Platform SDK - XChainSDK (Software Development Kit)
 *
 * This file handles parsing XChain Platform SDK requests
 *
 ********************************************************************/

const config         = require('./config.js');
const Actions        = require('./actions/index.js');
const Utility        = require('./utils/utility.js');
const HubConnector   = require('./clients/hub.js');
const ContractUtils  = require('./contract/utils.js');
const WalletUtils    = require('./utils/wallet.js');
const AuthUtils      = require('./utils/auth.js');
const MessagingUtils = require('./actions/messaging.js');
const GatedFileUtils = require('./actions/gated_file.js');
const CompressionUtils = require('./protocol/compression.js');
const NftHelpers     = require('./actions/nft.js');
const ProjectHelpers = require('./actions/project.js');
const ControllerHelpers = require('./actions/controller.js');
const VoteHelpers    = require('./actions/vote.js');
const BettingHelpers = require('./actions/betting.js');
const AttestationHelpers = require('./actions/attestation.js');
const CheckpointVerifier = require('./checkpoint.js');
const LightClient        = require('./protocol/light_client.js');
const Decoder            = require('./decoder/index.js');
const Preflight          = require('./preflight/index.js');
const MuSig2            = require('./cosigner/musig2.js');
const Workflows         = require('./actions/workflows.js');
const TickResolver      = require('./utils/tick_resolver.js');
const AddressResolver   = require('./utils/address_resolver.js');
const { publicDefaults } = require('./utils/endpoints.js');
const { installMethods } = require('./utils/install_methods.js');
const { ADDRESS_EVENT_TYPES, MEMPOOL_EVENT_TYPES } = require('./XChainSDK/event_frames.js');
const clientLifecycleMethods = require('./XChainSDK/client_lifecycle.js');
const actionShorthandMethods = require('./XChainSDK/action_shorthands.js');
const contractSessionMethods = require('./XChainSDK/contracts_and_sessions.js');
const workflowShorthandMethods = require('./XChainSDK/workflow_shorthands.js');
const feeServiceMethods = require('./XChainSDK/fees_and_services.js');
const walletMessageMethods = require('./XChainSDK/wallet_and_messages.js');
const ledgerQueryMethods = require('./XChainSDK/explorer_ledger_queries.js');
const networkQueryMethods = require('./XChainSDK/explorer_network_queries.js');
const entitySubscriptionMethods = require('./XChainSDK/entity_subscriptions.js');
const eventSubscriptionMethods = require('./XChainSDK/event_subscriptions.js');

// Initialize invariant SDK modules synchronously to keep constructor setup concise.
function initializeCoreModules(sdk) {
    // Initialize core (no network required)
    sdk.config    = config.getConfig();
    sdk.util      = new Utility();
    sdk.actions   = new Actions(sdk);
    // Ticker compaction: rewrites a ticker name to its smaller `^<id>` wire
    // form before serialization (on by default; { compactTickers: false } to
    // opt out). See tick_resolver.js.
    sdk.tickResolver = new TickResolver(sdk);
    // Address compaction: the address twin of tickResolver, rewrites an address
    // to its smaller `^<id>` wire form before serialization (on by default;
    // { compactAddresses: false } to opt out). See address_resolver.js.
    sdk.addressResolver = new AddressResolver(sdk);
    sdk.contracts = new ContractUtils();
    sdk.musig2    = new MuSig2();
    // Browser-safe MuSig2 co-signer toolkit (CoSigner, CoSignerClient, account
    // derivations, recovery spend). Lets the wallet's passive co-signer build on
    // the public API. The Node-only window store + express sidecar are not here.
    sdk.coSigner  = require('./cosigner/index.js');

    sdk.workflows = new Workflows(sdk);
}

// Initialize network utilities synchronously to preserve instance field order.
function initializeNetworkUtilities(sdk, network) {
    sdk.wallet     = new WalletUtils(network);
    sdk.auth       = new AuthUtils(network);
    sdk.messaging  = new MessagingUtils(network);
    sdk.gatedFile  = new GatedFileUtils();
    // FILE payload compression. Stateless, no network:
    // deflate-raw compress/inflate with the fail-closed, ratio-bounded
    // read path every serve layer shares.
    sdk.compression = new CompressionUtils();
}

// Attach action helper namespaces together so related builders initialize together.
function initializeActionHelpers(sdk) {
    // NFT helpers: pure builders for the NFT pattern (ISSUE with DECIMALS=0 +
    // LOCK_MAX_SUPPLY=1), collection child params, content-attach (LINK) params,
    // and the canonical isNft() classifier. No network. Submit-flow recipes that
    // compose these into live actions live on sdk.workflows (issueNft, etc.).
    // Spec: protocol/NFT_Standard.md.
    sdk.nft        = new NftHelpers();
    // Project registry helpers: pure builders for owner-attested official-token
    // rosters (TICK-type LIST + LINK to the project's ISSUE). No network.
    // Submit-flow recipe lives on sdk.workflows (setRoster).
    // Spec: protocol/Project_Registry.md.
    sdk.project    = new ProjectHelpers();
    // Controller (programmable-policy) helpers: pure builders for the
    // bind/unbind wire actions (ISSUE v6 for a token, ADDRESS v1 for an
    // account) that route a native action class to a guard contract. No
    // network. Read the resulting manifest via sdk.getContractManifest().
    // Spec: protocol/Controller_Bound_Tokens.md.
    sdk.controller = new ControllerHelpers();
    // Voting (token-weighted governance) helpers: pure builders for VOTE v0
    // (create poll), v1 (cast ballot), and v3 (delegate), handling option /
    // ballot encoding and mode/binding-poll validation. No network.
    // Submit-flow recipes live on sdk.workflows (createPoll, castBallot,
    // delegateVote). Spec: protocol/actions/VOTE.md.
    sdk.voting     = new VoteHelpers();
    // Betting (parimutuel markets) helpers: pure builders for BET v0
    // (create market), v1 (cancel), v2 (place bet), v3 (resolve), plus the
    // DETAILS market-definition schema, its base64 builder/parser, and a
    // display-only payout projection. Composing OUTCOMES and DETAILS through
    // createMarketParams is what keeps the two from disagreeing, which is a
    // consensus rejection. No network. Submit-flow recipes live on
    // sdk.workflows (openMarket, placeBet, resolveMarket, cancelMarket).
    // Spec: protocol/actions/BET.md.
    sdk.betting    = new BettingHelpers();
}

// Attach verification namespaces together so local trust checks initialize together.
function initializeVerificationHelpers(sdk) {
    // Attestation request/payload builders (http_get URL validation, LLM
    // envelope, request options). Exposed on the instance for parity with
    // messaging/gatedFile so dapps can `sdk.attestation.httpGet(url)` before
    // passing a URL into an EXECUTE that emits xchain.attestation.request().
    sdk.attestation = AttestationHelpers;
    // State checkpoint verification (local Ed25519 over the XCHECKPOINT
    // canonical): `sdk.checkpoint.fetchAndVerifyCheckpoint(...)` lets a
    // client verify explorer state against the validator quorum without
    // trusting the server. Spec: protocol/actions/ANCHOR.md.
    sdk.checkpoint = CheckpointVerifier;
    // SPV light client (spec §8): `sdk.light.verifyBalance(...)` /
    // `sdk.light.verifyAction(...)` fetch a server proof and verify it LOCALLY
    // against a quorum-signed checkpoint's committed roots (merkle.js twin +
    // sdk.checkpoint). Nothing trusts the server's own verified/amount.
    sdk.light = LightClient;
    // First-class decode library (spec: confirm-decode-preflight §3):
    // `sdk.decoder.parse(actionString)` -> ParsedAction,
    // `sdk.decoder.describe(parsed, ctx)` -> plain-English intent,
    // `sdk.decoder.decodeActionFromPsbt(psbt)` -> fail-closed PSBT decode.
    // Pure module (no network, no vault), hardened for untrusted input.
    sdk.decoder = Decoder;
}

class XChainSDK {

    // Options are applied immediately for core + explicit URLs.
    // Hub discovery requires calling init() (async) after construction.
    constructor(options = {}) {

        this.version = config.env.packageVersion();
        this.name    = config.env.packageName();
        this.options = options;

        initializeCoreModules(this);

        let network = options.network || config.env.network() || null;
        initializeNetworkUtilities(this, network);
        initializeActionHelpers(this);
        initializeVerificationHelpers(this);

        // Pre-flight engine (spec: confirm-decode-preflight §4). Predicts
        // whether the indexer would reject an action BEFORE signing, via a
        // server dry-run (Tier 1) plus a certified client matrix (Tier 2).
        // `options.preflight` (default true -> 'enforce') sets the default
        // mode; `sdk.preflight(actionData, opts)` runs a check on demand.
        // Under 'enforce', a 'fail' verdict throws SDKPreflightError.
        Preflight.attach(this, options.preflight === undefined ? true : options.preflight);

        // Service clients (initialized by initClients or init)
        this.explorer = null;
        this.encoder  = null;
        this.hub      = null;
        this.ws       = null;

        // Lazy hub-discovery state (see ensureReady).
        this._readyPromise = null;
        this._polling      = false;

        // Hub URL precedence:
        // options > env (HUB_API_HOST/HUB_PORT) > public default. For
        // non-regtest networks this defaults to https://hub.xchain.io so a
        // network-only construction discovers endpoints with zero config;
        // regtest gets no hub unless one is explicitly supplied.
        let pub     = publicDefaults(network);
        let hubUrl  = options.hubUrl  || config.env.hubApiHost() || pub.hubUrl;
        let hubPort = options.hubPort || (config.env.hubPort() ? parseInt(config.env.hubPort()) : undefined);
        if (options.hubValidators || hubUrl) {
            this.hub = new HubConnector(Object.assign({}, options, { hubUrl, hubPort }));
        }

        this.initClients(options);
    }

}

installMethods(
    XChainSDK.prototype,
    clientLifecycleMethods,
    actionShorthandMethods,
    contractSessionMethods,
    workflowShorthandMethods,
    feeServiceMethods,
    walletMessageMethods,
    ledgerQueryMethods,
    networkQueryMethods,
    entitySubscriptionMethods,
    eventSubscriptionMethods,
);

module.exports = Object.assign(XChainSDK, {
    // Exposed for the address-channel coverage guard: the roster onAddress registers
    // has to be reconcilable against the explorer's producer constants without a
    // second copy of it living in the test.
    ADDRESS_EVENT_TYPES,
    // The unconfirmed subset onMempoolAction registers, exported for the same
    // reason: a consumer (or a test) checking which frames the mempool surface
    // delivers should read the list the code registers from, not a copy of it.
    MEMPOOL_EVENT_TYPES,
});
