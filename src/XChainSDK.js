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
const Actions        = require('./actions.js');
const Utility        = require('./utility.js');
const ExplorerClient = require('./explorer.js');
const EncoderClient  = require('./encoder.js');
const HubConnector   = require('./hub.js');
const BatchBuilder   = require('./batchBuilder.js');
const ContractUtils  = require('./contracts.js');
const ContractClient = require('./contractClient.js');
const WebSocketClient = require('./websocket.js');
const WalletUtils    = require('./wallet.js');
const AuthUtils      = require('./auth.js');
const MessagingUtils = require('./messaging.js');
const GatedFileUtils = require('./gatedFile.js');
const CompressionUtils = require('./compression.js');
const NftHelpers     = require('./nft.js');
const ProjectHelpers = require('./project.js');
const ControllerHelpers = require('./controller.js');
const VoteHelpers    = require('./vote.js');
const BettingHelpers = require('./betting.js');
const AttestationHelpers = require('./attestation.js');
const CheckpointVerifier = require('./checkpoint.js');
const LightClient        = require('./light.js');
const Decoder            = require('./decoder/index.js');
const Preflight          = require('./preflight/index.js');
const MuSig2            = require('./musig2.js');
const ActionWaiter      = require('./actionWaiter.js');
const LifecycleManager  = require('./lifecycleManager.js');
const WalletSession     = require('./walletSession.js');
const Workflows         = require('./workflows.js');
const TickResolver      = require('./tickResolver.js');
const AddressResolver   = require('./addressResolver.js');
const { publicDefaults } = require('./endpoints.js');
const { SDKConfigError, SDKExplorerError, SDKContractError } = require('./errors.js');
const { lintSource } = require('./contract/lint-core.js');
const CONTRACT_SOURCES = require('./contract/templates.js');
const chunkHelper = require('./chunkHelper.js');

class XChainSDK {

    // Options are applied immediately for core + explicit URLs.
    // Hub discovery requires calling init() (async) after construction.
    constructor(options = {}) {

        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;
        this.options = options;

        // Initialize core (no network required)
        this.config    = config.getConfig();
        this.util      = new Utility();
        this.actions   = new Actions(this);
        // Ticker compaction: rewrites a ticker name to its smaller `^<id>` wire
        // form before serialization (on by default; { compactTickers: false } to
        // opt out). See tickResolver.js.
        this.tickResolver = new TickResolver(this);
        // Address compaction: the address twin of tickResolver, rewrites an address
        // to its smaller `^<id>` wire form before serialization (on by default;
        // { compactAddresses: false } to opt out). See addressResolver.js.
        this.addressResolver = new AddressResolver(this);
        this.contracts = new ContractUtils();
        this.musig2    = new MuSig2();
        // Browser-safe MuSig2 co-signer toolkit (CoSigner, CoSignerClient, account
        // derivations, recovery spend). Lets the wallet's passive co-signer build on
        // the public API. The Node-only window store + express sidecar are not here.
        this.coSigner  = require('./cosigner/index.js');

        this.workflows = new Workflows(this);

        let network = options.network || process.env.NETWORK || null;
        this.wallet     = new WalletUtils(network);
        this.auth       = new AuthUtils(network);
        this.messaging  = new MessagingUtils(network);
        this.gatedFile  = new GatedFileUtils();
        // FILE payload compression ( Part B). Stateless, no network:
        // deflate-raw compress/inflate with the fail-closed, ratio-bounded
        // read path every serve layer shares.
        this.compression = new CompressionUtils();
        // NFT helpers: pure builders for the NFT pattern (ISSUE with DECIMALS=0 +
        // LOCK_MAX_SUPPLY=1), collection child params, content-attach (LINK) params,
        // and the canonical isNft() classifier. No network. Submit-flow recipes that
        // compose these into live actions live on sdk.workflows (issueNft, etc.).
        // Spec: protocol/NFT_Standard.md.
        this.nft        = new NftHelpers();
        // Project registry helpers: pure builders for owner-attested official-token
        // rosters (TICK-type LIST + LINK to the project's ISSUE). No network.
        // Submit-flow recipe lives on sdk.workflows (setRoster).
        // Spec: protocol/Project_Registry.md.
        this.project    = new ProjectHelpers();
        // Controller (programmable-policy) helpers: pure builders for the
        // bind/unbind wire actions (ISSUE v6 for a token, ADDRESS v1 for an
        // account) that route a native action class to a guard contract. No
        // network. Read the resulting manifest via sdk.getContractManifest().
        // Spec: protocol/Controller_Bound_Tokens.md.
        this.controller = new ControllerHelpers();
        // Voting (token-weighted governance) helpers: pure builders for VOTE v0
        // (create poll), v1 (cast ballot), and v3 (delegate), handling option /
        // ballot encoding and mode/binding-poll validation. No network.
        // Submit-flow recipes live on sdk.workflows (createPoll, castBallot,
        // delegateVote). Spec: protocol/actions/VOTE.md.
        this.voting     = new VoteHelpers();
        // Betting (parimutuel markets) helpers: pure builders for BET v0
        // (create market), v1 (cancel), v2 (place bet), v3 (resolve), plus the
        // DETAILS market-definition schema, its base64 builder/parser, and a
        // display-only payout projection. Composing OUTCOMES and DETAILS through
        // createMarketParams is what keeps the two from disagreeing, which is a
        // consensus rejection. No network. Submit-flow recipes live on
        // sdk.workflows (openMarket, placeBet, resolveMarket, cancelMarket).
        // Spec: protocol/actions/BET.md.
        this.betting    = new BettingHelpers();
        // Attestation request/payload builders (http_get URL validation, LLM
        // envelope, request options). Exposed on the instance for parity with
        // messaging/gatedFile so dapps can `sdk.attestation.httpGet(url)` before
        // passing a URL into an EXECUTE that emits xchain.attestation.request().
        this.attestation = AttestationHelpers;
        // State checkpoint verification (local Ed25519 over the XCHECKPOINT
        // canonical): `sdk.checkpoint.fetchAndVerifyCheckpoint(...)` lets a
        // client verify explorer state against the validator quorum without
        // trusting the server. Spec: protocol/actions/ANCHOR.md.
        this.checkpoint = CheckpointVerifier;
        // SPV light client (spec §8): `sdk.light.verifyBalance(...)` /
        // `sdk.light.verifyAction(...)` fetch a server proof and verify it LOCALLY
        // against a quorum-signed checkpoint's committed roots (merkle.js twin +
        // sdk.checkpoint). Nothing trusts the server's own verified/amount.
        this.light = LightClient;
        // First-class decode library (spec: confirm-decode-preflight §3):
        // `sdk.decoder.parse(actionString)` -> ParsedAction,
        // `sdk.decoder.describe(parsed, ctx)` -> plain-English intent,
        // `sdk.decoder.decodeActionFromPsbt(psbt)` -> fail-closed PSBT decode.
        // Pure module (no network, no vault), hardened for untrusted input.
        this.decoder = Decoder;

        // Pre-flight engine (spec: confirm-decode-preflight §4). Predicts
        // whether the indexer would reject an action BEFORE signing, via a
        // server dry-run (Tier 1) plus a certified client matrix (Tier 2).
        // `options.preflight` (default true -> 'enforce') sets the default
        // mode; `sdk.preflight(actionData, opts)` runs a check on demand.
        // Under 'enforce', a 'fail' verdict throws SDKPreflightError.
        Preflight.attach(this, options.preflight === undefined ? true : options.preflight);

        // Service clients (initialized by _initClients or init)
        this.explorer = null;
        this.encoder  = null;
        this.hub      = null;
        this.ws       = null;

        // Lazy hub-discovery state (see _ensureReady).
        this._readyPromise = null;
        this._polling      = false;

        // Hub URL precedence:
        // options > env (HUB_API_HOST/HUB_PORT) > public default. For
        // non-regtest networks this defaults to https://hub.xchain.io so a
        // network-only construction discovers endpoints with zero config;
        // regtest gets no hub unless one is explicitly supplied.
        let pub     = publicDefaults(network);
        let hubUrl  = options.hubUrl  || process.env.HUB_API_HOST || pub.hubUrl;
        let hubPort = options.hubPort || (process.env.HUB_PORT ? parseInt(process.env.HUB_PORT) : undefined);
        if (options.hubValidators || hubUrl) {
            this.hub = new HubConnector(Object.assign({}, options, { hubUrl, hubPort }));
        }

        this._initClients(options);
    }

    // Config resolution: constructor options > env vars > public defaults > localhost.
    _initClients(resolved) {
        let network = resolved.network || process.env.NETWORK;
        let hooks   = this.options.hooks || {};
        let retry   = this.options.retry !== undefined ? this.options.retry : {};
        let pool    = this.options.pool || {};
        // Empty for regtest, so those clients keep their localhost fallback.
        let pub       = publicDefaults(network);
        let readyHook = () => this._ensureReady();

        let explorerUrl  = resolved.explorerUrl  || process.env.EXPLORER_URL || pub.explorerUrl;
        let explorerPort = resolved.explorerPort || process.env.EXPLORER_PORT;
        if (network && (explorerUrl || explorerPort)) {
            this.explorer = new ExplorerClient({
                network:      network,
                explorerUrl:  explorerUrl,
                explorerPort: explorerPort ? parseInt(explorerPort) : undefined,
                timeout:      resolved.timeout,
                hooks:        hooks,
                retry:        retry,
                pool:         pool,
                readyHook:    readyHook
            });
        } else if (network) {
            this.explorer = new ExplorerClient({ network, timeout: resolved.timeout, hooks, retry, pool, readyHook });
        }

        let encoderUrl  = resolved.encoderUrl  || process.env.ENCODER_URL || pub.encoderUrl;
        let encoderPort = resolved.encoderPort || process.env.ENCODER_PORT;
        if (encoderUrl || encoderPort) {
            this.encoder = new EncoderClient({
                encoderUrl:  encoderUrl,
                encoderPort: encoderPort ? parseInt(encoderPort) : undefined,
                timeout:     resolved.timeout,
                hooks:       hooks,
                retry:       retry,
                pool:        pool,
                readyHook:   readyHook
            });
        }

        // WebSocket follows explorer URL/port unless an explicit websocketUrl is given.
        let websocketUrl  = resolved.websocketUrl  || this.options.websocketUrl  || process.env.WEBSOCKET_URL;
        let websocketPort = resolved.websocketPort || this.options.websocketPort || process.env.WEBSOCKET_PORT;
        if (network && (websocketUrl || websocketPort || explorerUrl || explorerPort)) {
            let wsUrl  = websocketUrl  || explorerUrl;
            let wsPort = websocketPort ? parseInt(websocketPort) : (explorerPort ? parseInt(explorerPort) : undefined);
            if (!this.ws || this.ws.baseUrl !== wsUrl || this.ws.port !== wsPort) {
                if (this.ws) this.ws.disconnect();
                this.ws = new WebSocketClient({
                    network:       network,
                    websocketUrl:  wsUrl,
                    websocketPort: wsPort,
                    hooks:         hooks,
                    retry:         retry,
                    readyHook:     readyHook
                });
            }
        }
    }

    // Async initialization: fetch config from hub and resolve service endpoints.
    // Optional: service clients are already usable after construction (explicit
    // URLs, env vars, or public defaults). Call this to force hub discovery up
    // front; otherwise it happens lazily on the first service call (_ensureReady).
    // Unlike the lazy path, init() surfaces a hub error when there is no fallback
    // explorer/encoder client to fall back to. Safe to call multiple times.
    async init() {
        if (!this.hub) return;
        // Satisfy the lazy gate with the same in-flight discovery.
        if (!this._readyPromise) this._readyPromise = this._discover().catch(() => {});
        try {
            await this._discover();
        } catch (err) {
            // Non-fatal when we already have usable clients (explicit/default).
            if (this.explorer && this.encoder) {
                console.warn('Hub unavailable, using explicit/default config:', err.message || err);
                return;
            }
            throw err;
        }
    }

    // Lazy-readiness gate. Awaited once (via each client's readyHook) before the
    // first request, so hub-discovered endpoints overlay the default clients.
    // Never throws: on hub failure the hardcoded/explicit config stands.
    _ensureReady() {
        if (!this.hub) return Promise.resolve();
        if (!this._readyPromise) this._readyPromise = this._discover().catch(() => {});
        return this._readyPromise;
    }

    // One-shot hub discovery + endpoint overlay (+ start polling). Guarded so
    // init() and the lazy gate share a single in-flight fetch. May throw (init()
    // inspects the error; _ensureReady() swallows it).
    _discover() {
        if (this._discovering) return this._discovering;
        this._discovering = (async () => {
            await this.hub.getAllConfig();
            this._applyEndpoints();
            this._startPollingOnce();
        })();
        return this._discovering;
    }

    // Overlay hub-discovered endpoints onto the live clients (mutating, not
    // rebuilding, so in-flight callers see the new target). Skips any endpoint
    // the caller pinned via constructor options. Creates a client if one does
    // not yet exist (e.g. hub-only configuration).
    _applyEndpoints() {
        if (!this.hub) return;
        let network   = this.options.network || process.env.NETWORK;
        let endpoints = this.hub.extractServiceEndpoints(network);
        let hooks     = this.options.hooks || {};
        let retry     = this.options.retry !== undefined ? this.options.retry : {};
        let pool      = this.options.pool || {};
        let readyHook = () => this._ensureReady();

        // Explorer
        if (!this.options.explorerUrl && endpoints.explorerUrl) {
            if (this.explorer) {
                if (!this._isDowngrade('explorer', this.explorer, endpoints.explorerUrl))
                    this.explorer.setBase(endpoints.explorerUrl, endpoints.explorerPort);
            } else if (network) {
                this.explorer = new ExplorerClient({ network, explorerUrl: endpoints.explorerUrl, explorerPort: endpoints.explorerPort, timeout: this.options.timeout, hooks, retry, pool, readyHook });
            }
        }

        // Encoder
        if (!this.options.encoderUrl && endpoints.encoderUrl) {
            if (this.encoder) {
                if (!this._isDowngrade('encoder', this.encoder, endpoints.encoderUrl))
                    this.encoder.setBase(endpoints.encoderUrl, endpoints.encoderPort);
            } else {
                this.encoder = new EncoderClient({ encoderUrl: endpoints.encoderUrl, encoderPort: endpoints.encoderPort, timeout: this.options.timeout, hooks, retry, pool, readyHook });
            }
        }

        // WebSocket follows the explorer endpoint unless a websocket/explorer URL was pinned
        if (!this.options.websocketUrl && !this.options.explorerUrl && endpoints.explorerUrl) {
            if (this.ws) {
                if (!this._isDowngrade('websocket', this.ws, endpoints.explorerUrl))
                    this.ws.setBase(endpoints.explorerUrl, endpoints.explorerPort);
            } else if (network) {
                this.ws = new WebSocketClient({ network, websocketUrl: endpoints.explorerUrl, websocketPort: endpoints.explorerPort, hooks, retry, readyHook });
            }
        }
    }

    // Guard against hub discovery downgrading a secure default. Hub service
    // config commonly stores a bare internal host + port; overlaying that onto
    // a client whose current base is https (the public default) would replace
    // https://explorer.xchain.io with a broken http://host:port. When the
    // current base is secure and the incoming endpoint is not, keep the secure
    // base and warn once. (No effect on http/localhost bases; dev is unchanged.
    // Set option `allowInsecureEndpoints: true` to opt out.)
    _isDowngrade(service, client, incomingUrl) {
        if (this.options.allowInsecureEndpoints) return false;
        let currentSecure  = String(client.baseUrl || '').startsWith('https://');
        let incomingSecure = String(incomingUrl || '').startsWith('https://');
        if (currentSecure && !incomingSecure) {
            if (!this._downgradeWarned) this._downgradeWarned = {};
            if (!this._downgradeWarned[service]) {
                this._downgradeWarned[service] = true;
                console.warn('Ignoring hub ' + service + ' endpoint (' + incomingUrl + '): would downgrade the https default to an insecure transport. Publish a full https:// URL in the hub config, or set allowInsecureEndpoints:true.');
            }
            return true;
        }
        return false;
    }

    // Start hub config polling exactly once; re-applies endpoints on each update.
    _startPollingOnce() {
        if (this._polling) return;
        this._polling = true;
        this.hub.startPolling(() => this._applyEndpoints());
    }

    async start() {
        console.log('Starting up ' + this.name + ' v' + this.version + '...');
        if (this.hub) await this.init();

        while (true) {
            if (this.stopFlag) break;
            await this.util.sleep(this.config['STOP_CHECK_INTERVAL']);
        }
    }

    stop() {
        this.stopFlag = true;
        if (this.hub) this.hub.stopPolling();
        if (this.ws) this.ws.disconnect();
    }

    _requireExplorer() {
        if (!this.explorer)
            throw new SDKConfigError('EXPLORER_NOT_CONFIGURED', 'Explorer not configured. Provide network + explorerUrl, or use hub discovery via init().');
        return this.explorer;
    }

    _requireEncoder() {
        if (!this.encoder)
            throw new SDKConfigError('ENCODER_NOT_CONFIGURED', 'Encoder not configured. Provide encoderUrl, or use hub discovery via init().');
        return this.encoder;
    }


    /*
     *  ACTION Methods
     */

    // Create an action string and optionally encode it into a PSBT.
    // If data.encoder contains pubkey, calls the encoder and returns the PSBT.
    async createAction(data) {
        // Compact ticker names and addresses to their `^<id>` wire form before
        // serializing (on by default; each falls back to the supplied value when an
        // id can't be resolved). The two resolvers touch disjoint fields and each
        // returns a fresh shallow copy, so chaining them never mutates the caller's
        // data object.
        if (data && data.params) {
            let params = await this.tickResolver.resolveActionParams(data.action, data.params);
            params = await this.addressResolver.resolveActionParams(data.action, params);
            data = Object.assign({}, data, { params });
        }
        let result = this.actions.createAction(data);

        if (data.encoder && data.encoder.pubkey) {
            let encoder = this._requireEncoder();
            let txResult = await encoder.createTx({
                data:             result.actionString,
                pubkey:           data.encoder.pubkey,
                change:           data.encoder.change,
                utxos:            data.encoder.utxos,
                rawData:          data.encoder.rawData,
                encoding:         data.encoder.encoding,
                fee:              data.encoder.fee,
                feePerKb:         data.encoder.feePerKb,
                rbf:              data.encoder.rbf,
                dust:             data.encoder.dust,
                unconfirmed:      data.encoder.unconfirmed,
                compressedPubKey: data.encoder.compressedPubKey,
                customOutputs:    data.encoder.customOutputs,
                attachPrevTx:     data.encoder.attachPrevTx
            });
            result.psbt     = txResult.psbt;
            result.encoding = txResult.encoding;
        }

        return result;
    }

    // Submit an action through the full lifecycle: create, encode, sign, broadcast, wait.
    // actionData = { action, params }; encoderOpts = { pubkey, change, utxos, encoding, fee, ... };
    // opts = { wif, waitForIndexer, timeout, pollInterval, requireValid, strictStatus, onProgress }.
    // With waitForIndexer (default), a chain-REJECTED action REJECTS this call with
    // SDKActionError ACTION_REJECTED carrying the indexer's reason; the resolved
    // result's `indexed.statusKnown` says whether the status was read or assumed
    // (strictStatus:true rejects rather than assume - see actionWaiter, ).
    async submitAction(actionData, encoderOpts, opts) {
        let mgr = new LifecycleManager(this);
        return mgr.submitAction(actionData, encoderOpts, opts);
    }

    validateAction(action, params) {
        return this.actions.validateAction(action, params);
    }

    getActions() {
        return this.actions.getActions();
    }

    getActionFormats(action) {
        return this.actions.getActionFormats(action);
    }

    getActionFields(action, version) {
        return this.actions.getActionFields(action, version);
    }


    /*
     *  Convenience Action Methods
     *  Each wraps createAction with a fixed action name.
     *  sdk.send(params, encoderOpts?) is shorthand for
     *  sdk.createAction({ action: 'SEND', params, encoder: encoderOpts })
     */

    async send(params, encoder)      { return this.createAction({ action: 'SEND', params, encoder }); }
    async issue(params, encoder)     { return this.createAction({ action: 'ISSUE', params, encoder }); }
    async mint(params, encoder)      { return this.createAction({ action: 'MINT', params, encoder }); }
    async destroy(params, encoder)   { return this.createAction({ action: 'DESTROY', params, encoder }); }
    async order(params, encoder)     { return this.createAction({ action: 'ORDER', params, encoder }); }
    async transfer(params, encoder)  { return this.createAction({ action: 'SEND', params, encoder }); }
    async broadcast(params, encoder) { return this.createAction({ action: 'BROADCAST', params, encoder }); }
    async dispenser(params, encoder) { return this.createAction({ action: 'DISPENSER', params, encoder }); }
    async dividend(params, encoder)  { return this.createAction({ action: 'DIVIDEND', params, encoder }); }
    async sweep(params, encoder)     { return this.createAction({ action: 'SWEEP', params, encoder }); }
    async swap(params, encoder)      { return this.createAction({ action: 'SWAP', params, encoder }); }
    async callback(params, encoder)  { return this.createAction({ action: 'CALLBACK', params, encoder }); }
    async coinpay(params, encoder)   { return this.createAction({ action: 'COINPAY', params, encoder }); }
    async sleep(params, encoder)     { return this.createAction({ action: 'SLEEP', params, encoder }); }
    async airdrop(params, encoder)   { return this.createAction({ action: 'AIRDROP', params, encoder }); }
    async message(params, encoder)   { return this.createAction({ action: 'MESSAGE', params, encoder }); }
    async list(params, encoder)      { return this.createAction({ action: 'LIST', params, encoder }); }
    async link(params, encoder)      { return this.createAction({ action: 'LINK', params, encoder }); }
    async file(params, encoder)      { return this.createAction({ action: 'FILE', params, encoder }); }
    async address(params, encoder)   { return this.createAction({ action: 'ADDRESS', params, encoder }); }
    // PRICE: only v1 (permissionless user-run TOKEN/FIAT oracle) is SDK-encodable;
    // formats.js has no v0, so the validator COIN/FIAT snapshot can never be built here.
    // Params: { coin, tick, fiat, value, fee, memo }. See protocol/actions/PRICE.md.
    async price(params, encoder)     { return this.createAction({ action: 'PRICE', params, encoder }); }

    // VOTE (token-weighted governance). Raw wrapper: the version is taken from
    // params.version (0 create / 1 ballot / 3 delegate). Build the params with
    // sdk.voting.* or hand-roll them. v2 (finalize) is system-only. For a
    // signed+broadcast round-trip use sdk.createPoll / castBallot / delegateVote.
    async vote(params, encoder)             { return this.createAction({ action: 'VOTE', params, encoder }); }

    // BET (parimutuel betting). Raw wrapper: the version is taken from
    // params.version (0 create / 1 cancel / 2 place / 3 resolve). Build the
    // params with sdk.betting.* so OUTCOMES and DETAILS are composed together
    // and the version is pinned; auto-selection would otherwise read a resolve
    // with no AMOUNT and a place-bet as neighbouring shapes. For a
    // signed+broadcast round-trip use sdk.workflows.openMarket / placeBet /
    // resolveMarket / cancelMarket.
    async bet(params, encoder)              { return this.createAction({ action: 'BET', params, encoder }); }

    async stake(params, encoder)            { return this.createAction({ action: 'STAKE', params, encoder }); }
    async unstake(params, encoder)          { return this.createAction({ action: 'UNSTAKE', params, encoder }); }
    async delegate(params, encoder)         { return this.createAction({ action: 'DELEGATE', params, encoder }); }
    async collect(params, encoder)          { return this.createAction({ action: 'COLLECT', params, encoder }); }

    // Pre-flight lint of raw contract source (plain JS, pre-base64). Advisory,
    // synchronous, no network, browser-safe; runs every acorn-coverable deploy
    // check via the vendored lint-core. The isolated-vm V8 syntax compile runs
    // only at deploy/CLI, so authoritative is always false; the CLI / on-chain
    // deploy has the final word.
    // @returns {{ valid:boolean, errors:Rule[], warnings:Rule[], authoritative:false }}
    validateContract(code) {
        const { errors, warnings } = lintSource(code);
        return { valid: errors.length === 0, errors, warnings, authoritative: false };
    }

    // Return the source of a contract template or pattern by name, ready to
    // customize and deploy (synchronous, no network, browser-safe). Sources are
    // the audited xchain-contracts library, embedded at build time. Templates:
    // 'escrow' | 'vesting' | 'crowdsale' | 'amm'. Patterns: 'access-control' |
    // 'pausable' | 'safe-transfer' | 'validation' | 'state-machine'.
    // Throws SDKContractError('TEMPLATE_NOT_FOUND') for an unknown name.
    scaffold(name) {
        const b64 = (CONTRACT_SOURCES.templates && CONTRACT_SOURCES.templates[name]) ||
                    (CONTRACT_SOURCES.patterns && CONTRACT_SOURCES.patterns[name]);
        if (!b64) {
            const avail = this.listTemplates();
            throw new SDKContractError('TEMPLATE_NOT_FOUND',
                'No template or pattern named "' + name + '". Available templates: ' +
                avail.templates.join(', ') + '; patterns: ' + avail.patterns.join(', '));
        }
        return Buffer.from(b64, 'base64').toString('utf8');
    }

    // List the available scaffold names: { templates: [...], patterns: [...] }.
    listTemplates() {
        return {
            templates: Object.keys(CONTRACT_SOURCES.templates || {}),
            patterns:  Object.keys(CONTRACT_SOURCES.patterns || {})
        };
    }

    // Plan a deploy WITHOUT signing: does this source fit one inline DEPLOY, or
    // does it need chunking? Returns { codeHash, single, parts, totalChunks }
    // (synchronous, no network, no key material, browser-safe).
    //
    // deployContract() is the batteries-included path, but it takes a WIF and
    // drives its own session, so a signer that does NOT hold raw keys - a
    // wallet signing through a vault, a hardware device, or an offline
    // co-signer - cannot use it. Those callers need the same consensus-exact
    // chunk math (MAX_ACTION_DATA_LENGTH / MAX_DEPLOYCHUNK_PART_BYTES /
    // MAX_DEPLOY_CHUNKS and the base64 + push-prefix overhead) to build the
    // carrier + assembling actions on their own signing path; re-deriving it
    // caller-side would drift from consensus at the cap. Throws when the source
    // needs more than MAX_DEPLOY_CHUNKS slices.
    planDeploy(code, opts) {
        return chunkHelper.planDeploy(String(code), opts || {});
    }

    // Lint params.CODE (raw source) before a DEPLOY action is built.
    //   'block' (default): throw on any error (saves a guaranteed-to-fail on-chain tx)
    //   'warn'           : log errors + warnings, proceed
    //   'off'            : skip entirely
    // Chunked/hash-only deploys (no inline CODE) are skipped here; deployContract()
    // lints the assembled source before chunking instead.
    _preflightContractLint(params, mode) {
        mode = mode || 'block';
        if (mode === 'off') return;

        let code;
        if (params && typeof params.CODE === 'string') code = params.CODE;
        else if (params && typeof params.CODE_ENCODING === 'string') {
            try { code = this.contracts.decode(params.CODE_ENCODING); } catch (e) { return; }
        }
        if (typeof code !== 'string') return;

        const result = this.validateContract(code);
        for (const w of result.warnings)
            console.warn('DEPLOY lint warning: ' + w.message);

        // Constructor footgun: a contract that exports `initialize` (a constructor)
        // deployed with no CONSTRUCTOR_PARAMS runs no constructor, so it silently
        // deploys uninitialized. Nudge the caller (never blocks). An empty value is
        // still "provided" and runs a zero-arg initialize once DEPLOY_INIT_STRICT is
        // live, so only a genuinely-absent field warns. Best-effort: detection never
        // throws into the deploy path.
        try {
            const cp = params ? (params.CONSTRUCTOR_PARAMS !== undefined ? params.CONSTRUCTOR_PARAMS : params.constructorParams) : undefined;
            const ctorParamsAbsent = cp === undefined || cp === null || cp === '' || (Array.isArray(cp) && cp.length === 0);
            if (ctorParamsAbsent && this.contracts.getExportedMethodNames(code).includes('initialize'))
                console.warn('DEPLOY warning: contract exports initialize() but no CONSTRUCTOR_PARAMS were provided; ' +
                    'it will deploy uninitialized (and is rejected on-chain once the DEPLOY_INIT_STRICT flag-day activates). ' +
                    'Pass constructorParams (an empty value runs a zero-arg initialize).');
        } catch (e) { /* best-effort nudge; never block a deploy on it */ }

        if (result.valid) return;

        if (mode === 'warn') {
            for (const e of result.errors)
                console.warn('DEPLOY lint error: ' + e.message);
            return;
        }
        // 'block'
        const first = result.errors[0];
        const more = result.errors.length > 1 ? ' (+' + (result.errors.length - 1) + ' more)' : '';
        throw new SDKContractError('CONTRACT_LINT_FAILED',
            'Contract failed pre-flight validation: ' + first.message + more +
            ". Fix the contract or pass { lint: 'off' } to skip (it would still be rejected at deploy).");
    }

    async deploy(params, encoder, opts = {}) {
        this._preflightContractLint(params, opts.lint);
        return this.createAction({ action: 'DEPLOY', params, encoder });
    }
    async execute(params, encoder)   { return this.createAction({ action: 'EXECUTE', params, encoder }); }
    async deposit(params, encoder)   { return this.createAction({ action: 'DEPOSIT', params, encoder }); }
    async withdraw(params, encoder)  { return this.createAction({ action: 'WITHDRAW', params, encoder }); }

    contract(contractActionIndex) {
        return new ContractClient(this, contractActionIndex);
    }

    // Usage: let w = sdk.session(wif); await w.send({...}); await w.issue({...});
    session(wif, opts) {
        return new WalletSession(this, wif, opts);
    }

    // Create a policy-bounded session for an AUTOMATED AGENT: same surface as
    // session(), but every submit is checked against a declarative spending
    // policy (action allowlist, per-action and per-window caps, destination
    // allowlist, confirmation hook). Fail-closed. See src/agentSession.js.
    agentSession(wif, policy, opts) {
        const AgentSession = require('./agentSession.js');
        return new AgentSession(this, wif, policy, opts);
    }

    // Create a HARD-enforced agent session: the spending account is a 2-of-2
    // MuSig2 P2TR (agent key + policy co-signer key), so the WIF holder can't
    // bypass policy with raw SDK calls - the co-signer withholds its partial on
    // out-of-policy actions. opts.coSigner = { transport, publicKeys, network? };
    // the agent's own pubkey must be in publicKeys. See src/cosigner/musig2AgentSession.js.
    musig2AgentSession(wif, policy, opts) {
        const MuSig2AgentSession = require('./cosigner/musig2AgentSession.js');
        return new MuSig2AgentSession(this, wif, policy, opts);
    }

    async issueAndDistribute(wif, issueParams, distributions, opts) {
        return this.workflows.issueAndDistribute(wif, issueParams, distributions, opts);
    }
    async issueAndMint(wif, issueParams, mintParams, opts) {
        return this.workflows.issueAndMint(wif, issueParams, mintParams, opts);
    }
    async createDispenser(wif, dispenserParams, opts) {
        return this.workflows.createDispenser(wif, dispenserParams, opts);
    }
    async createOrder(wif, orderParams, opts) {
        return this.workflows.createOrder(wif, orderParams, opts);
    }
    async cancelOrder(wif, orderActionIndex, opts) {
        return this.workflows.cancelOrder(wif, orderActionIndex, opts);
    }
    async stakeAndDelegate(wif, stakeParams, delegateParams, opts) {
        return this.workflows.stakeAndDelegate(wif, stakeParams, delegateParams, opts);
    }
    async deployAndFund(wif, deployParams, deposits, opts) {
        return this.workflows.deployAndFund(wif, deployParams, deposits, opts);
    }
    // Deploy auto-selecting single-shot vs chunked (DEPLOY v4 carriers + DEPLOY v2/v3) by source
    // size, then optionally fund. Pass raw `code` so the planner can size it. See
    // workflows.deployContract / chunkHelper. Spec: protocol/actions/DEPLOY.md.
    async deployContract(wif, deployParams, deposits, opts) {
        return this.workflows.deployContract(wif, deployParams, deposits, opts);
    }
    async distributeDividend(wif, dividendParams, opts) {
        return this.workflows.distributeDividend(wif, dividendParams, opts);
    }
    async issueNft(wif, params, opts) {
        return this.workflows.issueNft(wif, params, opts);
    }
    async issueNftEdition(wif, params, opts) {
        return this.workflows.issueNftEdition(wif, params, opts);
    }
    async issueCollectionItem(wif, params, opts) {
        return this.workflows.issueCollectionItem(wif, params, opts);
    }
    async attachContent(wif, params, opts) {
        return this.workflows.attachContent(wif, params, opts);
    }
    async setRoster(wif, params, opts) {
        return this.workflows.setRoster(wif, params, opts);
    }
    // Governance submit recipes: build the VOTE params (via sdk.voting.*) then
    // sign + broadcast in one call. `params` is the same object the matching
    // sdk.voting builder takes. Set opts.waitForIndexer to get back the poll's
    // action_index (needed as pollRef for later ballots).
    async createPoll(wif, params, opts) {
        return this.workflows.createPoll(wif, params, opts);
    }
    async castBallot(wif, params, opts) {
        return this.workflows.castBallot(wif, params, opts);
    }
    async delegateVote(wif, params, opts) {
        return this.workflows.delegateVote(wif, params, opts);
    }
    async clearVoteDelegation(wif, params, opts) {
        return this.workflows.clearVoteDelegation(wif, params, opts);
    }

    // Usage: await sdk.batch().send({...}).mint({...}).build(encoderOpts?)
    // build() is async; passing the un-awaited Promise to submitAction will not work.
    batch() {
        return new BatchBuilder(this);
    }


    /*
     *  Encoder Methods
     */

    async encodeTx(params) {
        return this._requireEncoder().createTx(params);
    }

    async spendP2sh(params) {
        return this._requireEncoder().spendP2sh(params);
    }

    // Estimate fees for an action without signing or broadcasting.
    // Returns { fee, inputTotal, outputTotal, encoding, psbt, actionString }
    // The returned PSBT can be signed directly to skip a second encode call.
    //
    // Native-coin protocol fee (opt-in via encoderOpts.payFeeInNativeCoin): pay the XCHAIN
    // protocol fee in BTC/LTC/DOGE at the USD-equivalent by adding a FEE_DESTINATION output.
    // This runs the indexer pre-flight (quoteNativeFee) to size that output exactly and REFUSES
    // to build a doomed tx (unsupported action / stale-or-missing oracle price). A failed
    // native-fee action forfeits the fee on-chain, so we never produce one that can't be priced.
    // The quote is attached as feeResult.nativeFeeQuote.
    async estimateFees(actionData, encoderOpts = {}) {
        let result = this.actions.createAction(actionData);
        let encoder = this._requireEncoder();

        let customOutputs  = Array.isArray(encoderOpts.customOutputs) ? encoderOpts.customOutputs.slice() : [];
        let nativeFeeQuote = null;
        if (encoderOpts.payFeeInNativeCoin) {
            nativeFeeQuote = await this.quoteNativeFee(actionData, { source: encoderOpts.source || encoderOpts.change });
            if (!nativeFeeQuote || nativeFeeQuote.supported === false)
                throw new SDKConfigError('NATIVE_FEE_UNSUPPORTED', 'Native-coin fee not available for this action: ' + ((nativeFeeQuote && nativeFeeQuote.error) || 'unsupported'), { quote: nativeFeeQuote });
            if (nativeFeeQuote.valid === false)
                throw new SDKConfigError('NATIVE_FEE_INVALID', 'Native-coin fee cannot be priced: ' + (nativeFeeQuote.error || 'invalid'), { quote: nativeFeeQuote });
            if (Number(nativeFeeQuote.requiredFeeSats) > 0)
                customOutputs.push({ address: nativeFeeQuote.feeDestination, value: Number(nativeFeeQuote.requiredFeeSats) });
        }

        let feeResult = await encoder.estimateFee({
            data:             result.actionString,
            pubkey:           encoderOpts.pubkey,
            change:           encoderOpts.change,
            utxos:            encoderOpts.utxos,
            encoding:         encoderOpts.encoding,
            fee:              encoderOpts.fee,
            feePerKb:         encoderOpts.feePerKb,
            rbf:              encoderOpts.rbf,
            dust:             encoderOpts.dust,
            unconfirmed:      encoderOpts.unconfirmed,
            compressedPubKey: encoderOpts.compressedPubKey,
            customOutputs:    customOutputs
        });
        feeResult.actionString = result.actionString;
        feeResult.action       = result.action;
        feeResult.version      = result.version;
        if (nativeFeeQuote) feeResult.nativeFeeQuote = nativeFeeQuote;
        return feeResult;
    }

    // Native-coin fee pre-flight for an action (without signing/broadcasting). Builds the action
    // string, splits off the ACTION + wire params, and asks the indexer (via the explorer proxy)
    // for the authoritative native fee + accept/reject verdict. A client should size the
    // FEE_DESTINATION output to `requiredFeeSats` and refuse to broadcast when
    // `supported === false` or `valid === false`.
    //
    // `valid === null` is a third answer, not a failure: the VM actions (DEPLOY/EXECUTE) are
    // priced from the indexer's gas schedule without a dry-run (`staticQuote:true`,
    // `validated:false`), so the fee is authoritative but on-chain validity was never judged.
    // Size the output and broadcast, but surface that the action itself is unverified: those two
    // are otherwise unpayable on LTC/DOGE, which have no XCHAIN fee lane to fall back to.
    // A `busy:true, retryable:true` quote (indexer
    // admission cap) is retried once after a short delay (opts.busyRetryDelayMs, default 1s)
    // before being returned. See xchain-documentation/concepts/GAS.md.
    //
    // : `actionData` may also be an ALREADY-FORMATTED action string. A caller re-quoting a
    // fee it composed earlier (the wallet's Approve-time re-check) holds the exact bytes it is
    // about to broadcast, and re-deriving them from the form params it started with would price a
    // second, independently built action: the same mirror-drift class as the VOTE params mirror.
    // Same request either way, since the only thing this method ever wanted from `actionData` was
    // the action string.
    async quoteNativeFee(actionData, opts = {}) {
        let actionString = (typeof actionData === 'string')
                         ? actionData
                         : this.actions.createAction(actionData).actionString;
        let parts   = String(actionString).split('|');
        let action  = parts.shift();
        let request = {
            action:        action,
            params:        parts,
            source:        opts.source,
            feeOutputSats: opts.feeOutputSats
        };
        let quote = await this._fetchFeeQuote(request);
        // The indexer's admission cap answers `busy:true, retryable:true` under transient
        // load; one short-delay retry rides that out before callers turn the (valid:false)
        // busy quote into a hard NATIVE_FEE_INVALID refusal.
        if (quote.busy === true && quote.retryable === true) {
            let delayMs = opts.busyRetryDelayMs != null ? Number(opts.busyRetryDelayMs) : 1000;
            await new Promise(resolve => setTimeout(resolve, delayMs));
            quote = await this._fetchFeeQuote(request);
        }
        quote.actionString = actionString;
        return quote;
    }

    async _fetchFeeQuote(request) {
        let quote = await this._requireExplorer().getFeeQuote(request);
        // An explorer that doesn't serve this coin can answer 200 with an HTML page or an
        // unrelated JSON body; treating that as a quote builds a doomed fee-forfeiting tx.
        if (!quote || typeof quote !== 'object' || Array.isArray(quote) || typeof quote.supported !== 'boolean') {
            let detail = (quote && typeof quote === 'object' && quote.error) ? String(quote.error) : 'not a quote object';
            throw new SDKExplorerError('EXPLORER_BAD_FEEQUOTE', 'Explorer returned a malformed native-fee quote (' + detail + '): refusing to size the fee output', { quote: typeof quote === 'string' ? quote.slice(0, 200) : quote });
        }
        return quote;
    }

    async getFeeSchedule() {
        return this._requireExplorer().getFeeSchedule();
    }

    async pingEncoder() {
        return this._requireEncoder().ping();
    }

    // Check encoder hard-dependency health (UTXO tracker reachability + sync state).
    // Returns { tracker_reachable, tracker_synced, tracker_lag }. A passing pingEncoder
    // does not guarantee create_tx will succeed; this call does.
    async healthEncoder() {
        return this._requireEncoder().health();
    }

    // Suggested network fee tiers (base-unit/vByte) at low/medium/high confirmation
    // targets from the coin node's estimatesmartfee. Multiply a tier value by 1000 to
    // pass as feePerKb to submitAction or encodeTx.
    async getFeeTiers() {
        return this._requireEncoder().getFeeTiers();
    }


    /*
     *  Hub Methods
     */

    async pingHub() {
        if (!this.hub) throw new SDKConfigError('HUB_NOT_CONFIGURED', 'Hub not configured. Provide hubUrl in SDK options.');
        return this.hub.ping();
    }

    getHubConfig() {
        if (!this.hub) return null;
        return this.hub.configs;
    }

    // Per-capability MIN_STAKE thresholds for capability staking, read live
    // from the hub. Returns an array of { capability, min_stake, disabled }
    // rows, or null when no hub is configured (e.g. regtest) or unreachable.
    // Capabilities are global governance config, so this is not chain-scoped.
    async getCapabilityThresholds() {
        if (!this.hub) return null;
        return this.hub.getCapabilityThresholds();
    }


    /*
     *  Wallet Convenience Methods
     */

    signPsbt(psbtHex, wif)              { return this.wallet.signPsbt(psbtHex, wif); }
    decomposePsbt(psbtHex)              { return this.wallet.decomposePsbt(psbtHex); }
    txidOf(txHex)                       { return this.wallet.txidOf(txHex); }
    async broadcastTx(txHex)            { return this.wallet.broadcastTx(txHex, this._requireEncoder()); }
    async getUTXOs(address)             { return this.wallet.getUTXOs(address, this._requireEncoder()); }
    validateAddress(address, network)   { return this.wallet.validateAddress(address, network); }
    importWIF(wif)                      { return this.wallet.importWIF(wif); }
    generateKeyPair(opts)               { return this.wallet.generateKeyPair(opts); }
    deriveAddress(publicKey, opts)      { return this.wallet.deriveAddress(publicKey, opts); }
    deriveMultisigAddress(params)       { return this.wallet.deriveMultisigAddress(params); }


    /*
     *  Auth Convenience Methods
     */

    generateChallenge(address, opts)                      { return this.auth.generateChallenge(address, opts); }
    signMessage(message, wif, opts)                       { return this.auth.signMessage(message, wif, opts); }
    verifyOwnership(address, message, signature, network) { return this.auth.verifyOwnership(address, message, signature, network); }
    verifyMessage(address, message, signature, network)   { return this.auth.verifyMessage(address, message, signature, network); }


    /*
     *  Messaging Convenience Methods
     */

    async sendMessage(params) { return this.messaging.send(params, this); }
    async getPublicKey(address) { return this.messaging.getPublicKey(address, this._requireExplorer()); }
    async getMessagesForAddress(address, opts) { return this.messaging.getMessages(address, opts, this._requireExplorer()); }

    /*
     *  Token-gated content (FILE with GATE_TICKER set).
     *  See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
     */

    // Fetch the raw ciphertext bytes for a gated FILE by ACTION_INDEX.
    async getGatedFileRaw(actionIndex, coin = null) { return this._requireExplorer().getGatedFileRaw(actionIndex, coin); }

    // Absolute URL of a FILE action's raw bytes on the configured explorer:
    // the resolution target for TIS data_ref entries and on-chain TIS docs.
    fileRawUrl(actionIndex, coin = null) { return this._requireExplorer().fileRawUrl(actionIndex, coin); }

    /**
     * Fetch messages for an address across all chains (BTC, LTC, DOGE).
     * Creates explorer clients for each chain using the same server URL
     * and queries them in parallel.
     */
    async getAllMessagesForAddress(address, opts) {
        let explorer = this._requireExplorer();
        let network = this.options.network || process.env.NETWORK;
        if (!network) throw new SDKConfigError('NETWORK_NOT_CONFIGURED', 'Network is required for cross-chain message queries.');

        // Determine network tier (mainnet/testnet/regtest)
        let tier = network.split('-')[1]; // 'mainnet', 'testnet', or 'regtest'
        let chains = [
            { network: 'bitcoin-' + tier,  chain: 'BTC' },
            { network: 'litecoin-' + tier,  chain: 'LTC' },
            { network: 'dogecoin-' + tier,  chain: 'DOGE' }
        ];

        // Create explorer clients for each chain reusing the same server
        let explorers = chains.map(({ network: net, chain }) => {
            let client = new ExplorerClient({
                network:      net,
                explorerUrl:  explorer.baseUrl,
                explorerPort: explorer.port,
                timeout:      explorer.timeout,
                retry:        explorer.retry,
                hooks:        explorer.hooks
            });
            return { explorer: client, chain };
        });

        return this.messaging.getAllMessages(address, opts, explorers);
    }


    /*
     *  Explorer: Balance & Address Methods
     */

    async getBalances(address, opts) {
        return this._requireExplorer().getBalances(address, opts);
    }

    async getAddress(address) {
        return this._requireExplorer().getAddress(address);
    }

    async getHolders(tick, opts) {
        return this._requireExplorer().getHolders(tick, opts);
    }

    async getCredits(query, type, opts) {
        return this._requireExplorer().getCredits(query, type, opts);
    }

    async getDebits(query, type, opts) {
        return this._requireExplorer().getDebits(query, type, opts);
    }

    async getEscrows(query, type, opts) {
        return this._requireExplorer().getEscrows(query, type, opts);
    }


    /*
     *  Explorer: Token Methods
     */

    async getToken(tick) {
        return this._requireExplorer().getToken(tick);
    }

    // Current official-token roster of a project tick (protocol/Project_Registry.md)
    async getProject(tick) {
        return this._requireExplorer().getProject(tick);
    }

    async getTokens(query, type, opts) {
        return this._requireExplorer().getTokens(query, type, opts);
    }

    async getIssues(query, type, opts) {
        return this._requireExplorer().getIssues(query, type, opts);
    }


    /*
     *  Explorer: Transaction & History Methods
     */

    async getTransaction(query, type) {
        return this._requireExplorer().getTransaction(query, type);
    }

    async getAction(actionIndex) {
        return this._requireExplorer().getAction(actionIndex);
    }

    async getBlock(blockIndex) {
        return this._requireExplorer().getBlock(blockIndex);
    }

    async getHistory(query, type, opts) {
        return this._requireExplorer().getHistory(query, type, opts);
    }


    /*
     *  Explorer: ACTION-Specific Query Methods
     */

    async getAddresses(query, type, opts) {
        return this._requireExplorer().getAddresses(query, type, opts);
    }

    async getAirdrops(query, type, opts) {
        return this._requireExplorer().getAirdrops(query, type, opts);
    }

    async getBatches(query, type, opts) {
        return this._requireExplorer().getBatches(query, type, opts);
    }

    async getBroadcasts(query, type, opts) {
        return this._requireExplorer().getBroadcasts(query, type, opts);
    }

    async getCallbacks(query, type, opts) {
        return this._requireExplorer().getCallbacks(query, type, opts);
    }

    async getDestroys(query, type, opts) {
        return this._requireExplorer().getDestroys(query, type, opts);
    }

    async getCoinpays(query, type, opts) {
        return this._requireExplorer().getCoinpays(query, type, opts);
    }

    async getCoinpayExpires(query, type, opts) {
        return this._requireExplorer().getCoinpayExpires(query, type, opts);
    }

    async getCoinpayObligations(query, type, opts) {
        return this._requireExplorer().getCoinpayObligations(query, type, opts);
    }

    async getDispensers(query, type, opts) {
        return this._requireExplorer().getDispensers(query, type, opts);
    }

    async getDispenses(query, type, opts) {
        return this._requireExplorer().getDispenses(query, type, opts);
    }

    // Dispenser lifecycle events (cancellations), type ∈ {block, address}.
    async getDispenserCancels(query, type, opts) {
        return this._requireExplorer().getDispenserCancels(query, type, opts);
    }

    async getDispenserCloses(query, type, opts) {
        return this._requireExplorer().getDispenserCloses(query, type, opts);
    }

    async getDispenserExpires(query, type, opts) {
        return this._requireExplorer().getDispenserExpires(query, type, opts);
    }

    async getDispenserEdits(query, type, opts) {
        return this._requireExplorer().getDispenserEdits(query, type, opts);
    }

    async getDividends(query, type, opts) {
        return this._requireExplorer().getDividends(query, type, opts);
    }

    async getFees(query, type, opts) {
        return this._requireExplorer().getFees(query, type, opts);
    }

    async getFiles(query, type, opts) {
        return this._requireExplorer().getFiles(query, type, opts);
    }

    async getLinks(query, type, opts) {
        return this._requireExplorer().getLinks(query, type, opts);
    }

    async getLists(query, type, opts) {
        return this._requireExplorer().getLists(query, type, opts);
    }

    async getMessages(query, type, opts) {
        return this._requireExplorer().getMessages(query, type, opts);
    }

    async getMints(query, type, opts) {
        return this._requireExplorer().getMints(query, type, opts);
    }

    async getOrders(query, type, opts) {
        return this._requireExplorer().getOrders(query, type, opts);
    }

    // Order lifecycle events (cancellations), type ∈ {block, address}.
    async getOrderCancels(query, type, opts) {
        return this._requireExplorer().getOrderCancels(query, type, opts);
    }

    async getOrderEdits(query, type, opts) {
        return this._requireExplorer().getOrderEdits(query, type, opts);
    }

    async getOrderExpires(query, type, opts) {
        return this._requireExplorer().getOrderExpires(query, type, opts);
    }

    // Completed order matches (auto-matched counter-orders; type 'block').
    async getOrderMatches(query, type, opts) {
        return this._requireExplorer().getOrderMatches(query, type, opts);
    }

    async getSends(query, type, opts) {
        return this._requireExplorer().getSends(query, type, opts);
    }

    async getSleeps(query, type, opts) {
        return this._requireExplorer().getSleeps(query, type, opts);
    }

    async getSwaps(query, type, opts) {
        return this._requireExplorer().getSwaps(query, type, opts);
    }

    // Swap lifecycle events (cancellations), type ∈ {block, address}.
    async getSwapCancels(query, type, opts) {
        return this._requireExplorer().getSwapCancels(query, type, opts);
    }

    async getSwapEdits(query, type, opts) {
        return this._requireExplorer().getSwapEdits(query, type, opts);
    }

    async getSwapExpires(query, type, opts) {
        return this._requireExplorer().getSwapExpires(query, type, opts);
    }

    // Completed swap matches (type 'block'; the explorer keys matches by block).
    async getSwapMatches(query, type, opts) {
        return this._requireExplorer().getSwapMatches(query, type, opts);
    }

    async getSweeps(query, type, opts) {
        return this._requireExplorer().getSweeps(query, type, opts);
    }


    /*
     *  Explorer: Contract / VM Methods
     */

    async getContract(contractActionIndex) {
        return this._requireExplorer().getContract(contractActionIndex);
    }

    // Read a contract's declared permissions manifest (programmable policy layer),
    // normalized to { permissions: string[]|null, maxTakeBps: number|null }.
    // permissions=null → unrestricted (no declared allowlist); maxTakeBps=null →
    // the global fee cap applies. Backs the wallet consent disclosure.
    async getContractManifest(contractActionIndex) {
        return this._requireExplorer().getContractManifest(contractActionIndex);
    }

    async getContracts(query, type, opts) {
        return this._requireExplorer().getContracts(query, type, opts);
    }

    async getContractState(contractActionIndex, key) {
        return this._requireExplorer().getContractState(contractActionIndex, key);
    }

    async getContractBalance(contractActionIndex, tick) {
        return this._requireExplorer().getContractBalance(contractActionIndex, tick);
    }

    // Read External Attestation Framework rows (ATTEST v0 requests + v1/v2
    // responses from the `attests` table). type ∈ {block, address, contract}.
    // A dapp polls this to learn its attestation request's status/result.
    async getAttestations(query, type, opts) {
        return this._requireExplorer().getAttestations(query, type, opts);
    }

    // Read XCALL cross-chain calls (VM-emitted, read-only; no submit path). List the
    // source-chain requests (type ∈ {block, contract, status}); a dapp polls getXcall(callId)
    // for one call's full lifecycle (request + target execution + source callback).
    async getXcalls(query, type, opts) {
        return this._requireExplorer().getXcalls(query, type, opts);
    }

    async getXcall(callId) {
        return this._requireExplorer().getXcall(callId);
    }

    async getExecution(executionActionIndex) {
        return this._requireExplorer().getExecution(executionActionIndex);
    }

    async getExecutions(query, type = 'contract', opts = {}) {
        return this._requireExplorer().getExecutions(query, type, opts);
    }

    async getDeposits(query, type, opts) {
        return this._requireExplorer().getDeposits(query, type, opts);
    }

    async getWithdrawals(query, type, opts) {
        return this._requireExplorer().getWithdrawals(query, type, opts);
    }


    /*
     *  Explorer: Staking Methods
     */

    async getStakes(query, type, opts) {
        return this._requireExplorer().getStakes(query, type, opts);
    }

    async getUnstakes(query, type, opts) {
        return this._requireExplorer().getUnstakes(query, type, opts);
    }

    async getStakeKeyRevocations(query, type, opts) {
        return this._requireExplorer().getStakeKeyRevocations(query, type, opts);
    }

    async getCollects(query, type, opts) {
        return this._requireExplorer().getCollects(query, type, opts);
    }

    async getDelegations(query, type, opts) {
        return this._requireExplorer().getDelegations(query, type, opts);
    }

    async getValidators(opts) {
        return this._requireExplorer().getValidators(opts);
    }

    async getValidatorRewards(query, type, opts) {
        return this._requireExplorer().getValidatorRewards(query, type, opts);
    }

    async getContractStakes(query, type, opts) {
        return this._requireExplorer().getContractStakes(query, type, opts);
    }

    async getContractUnstakes(query, type, opts) {
        return this._requireExplorer().getContractUnstakes(query, type, opts);
    }

    async getContractDelegations(query, type, opts) {
        return this._requireExplorer().getContractDelegations(query, type, opts);
    }

    async getSlashEvents(query, type, opts) {
        return this._requireExplorer().getSlashEvents(query, type, opts);
    }

    async getCapabilitySlashEvents(query, type, opts) {
        return this._requireExplorer().getCapabilitySlashEvents(query, type, opts);
    }

    async getControllers(opts) {
        return this._requireExplorer().getControllers(opts);
    }

    async getDeployChunks(opts) {
        return this._requireExplorer().getDeployChunks(opts);
    }

    async getFullNodeVerifications(query, type, opts) {
        return this._requireExplorer().getFullNodeVerifications(query, type, opts);
    }

    async getCrossChainMatches(query, type, opts) {
        return this._requireExplorer().getCrossChainMatches(query, type, opts);
    }

    async getCrossChainSettlements(query, type, opts) {
        return this._requireExplorer().getCrossChainSettlements(query, type, opts);
    }

    async getAnchors(query, type, opts) {
        return this._requireExplorer().getAnchors(query, type, opts);
    }

    async getOraclePrices(query, type, opts) {
        return this._requireExplorer().getOraclePrices(query, type, opts);
    }

    async getValidatorCapabilities(query, type, opts) {
        return this._requireExplorer().getValidatorCapabilities(query, type, opts);
    }

    async getGovernanceProposals(query, type, opts) {
        return this._requireExplorer().getGovernanceProposals(query, type, opts);
    }

    async getGovernanceVotes(query, type, opts) {
        return this._requireExplorer().getGovernanceVotes(query, type, opts);
    }

    async getPolls(query, type, opts) {
        return this._requireExplorer().getPolls(query, type, opts);
    }

    // BET reads (§11.1). These proxies were missing while explorer.js already
    // carried all four methods, and the gap was invisible to both sides' unit
    // tests: the SDK suite exercises the ExplorerClient directly, and consumers
    // mock the SDK, so a mock always has whatever the test defines. The result was
    // that every betting read in the wallet threw "sdk.getBetFeeds is unavailable"
    // at runtime, which only surfaced when the market browser was driven against a
    // real stack.
    async getBetFeeds(query, type, opts) {
        return this._requireExplorer().getBetFeeds(query, type, opts);
    }

    async getBetFeed(feedIndex, opts) {
        return this._requireExplorer().getBetFeed(feedIndex, opts);
    }

    async getBets(query, type, opts) {
        return this._requireExplorer().getBets(query, type, opts);
    }

    async getOracleStats(address, opts) {
        return this._requireExplorer().getOracleStats(address, opts);
    }

    async getPoll(pollIndex, opts) {
        return this._requireExplorer().getPoll(pollIndex, opts);
    }

    async getPollResults(pollIndex, opts) {
        return this._requireExplorer().getPollResults(pollIndex, opts);
    }

    async getVotes(query, type, opts) {
        return this._requireExplorer().getVotes(query, type, opts);
    }

    /*
     *  Explorer: Light-client (SPV) checkpoint + proof methods
     */

    async getCheckpoints(opts) {
        return this._requireExplorer().getCheckpoints(opts);
    }

    async getCheckpointRange(from, to, opts) {
        return this._requireExplorer().getCheckpointRange(from, to, opts);
    }

    async getCheckpointVerify(blockIndex) {
        return this._requireExplorer().getCheckpointVerify(blockIndex);
    }

    async getBalanceProof(address, tick, opts) {
        return this._requireExplorer().getBalanceProof(address, tick, opts);
    }

    async getActionProof(actionIndex) {
        return this._requireExplorer().getActionProof(actionIndex);
    }

    async getValidatorSetProof(opts) {
        return this._requireExplorer().getValidatorSetProof(opts);
    }

    async getContractStateProof(contractIndex, key) {
        return this._requireExplorer().getContractStateProof(contractIndex, key);
    }

    // Fetch the checkpoint at blockIndex through the pooled, retry-aware
    // ExplorerClient (vs sdk.checkpoint.fetchAndVerifyCheckpoint's bare fetch),
    // then re-verify it LOCALLY with Ed25519. The server's `verified` flag is
    // ignored; only local crypto decides.
    async verifyCheckpoint(blockIndex) {
        let body = await this._requireExplorer().getCheckpointVerify(blockIndex);
        if (!body || !body.checkpoint) throw new Error('verifyCheckpoint: no checkpoint in response');
        let result = CheckpointVerifier.verifyCheckpoint(body.checkpoint, body.validators || []);
        return Object.assign({ checkpoint: body.checkpoint, snapshotAvailable: !!body.snapshot_available }, result);
    }


    /*
     *  Explorer: Market Methods
     */

    async getMarkets(tick) {
        return this._requireExplorer().getMarkets(tick);
    }

    async getMarket(tick1, tick2) {
        return this._requireExplorer().getMarket(tick1, tick2);
    }

    async getMarketHistory(tick1, tick2, address, opts) {
        return this._requireExplorer().getMarketHistory(tick1, tick2, address, opts);
    }

    async getMarketOrders(tick1, tick2, address, opts) {
        return this._requireExplorer().getMarketOrders(tick1, tick2, address, opts);
    }

    async getOrderbook(tick1, tick2) {
        return this._requireExplorer().getOrderbook(tick1, tick2);
    }

    async getPrices(query, type, opts) {
        return this._requireExplorer().getPrices(query, type, opts);
    }

    async getPriceSnapshots(query, type, opts) {
        return this._requireExplorer().getPriceSnapshots(query, type, opts);
    }


    /*
     *  Explorer: Utility Methods
     */

    // Indexer status: per-coin last_block / last_block_time (indexer position),
    // plus decoder_tip (the decoder's highest *processed* block) and
    // decoder_lag_blocks (decoder_tip - last_block, >= 0) so a stalled indexer is
    // detectable from this single call. This covers the indexer->decoder slice only,
    // NOT whole-pipeline lag: the coin node's chain tip is not exposed here (use the
    // decoder's health() RPC for the chain->decoder gap). decoder_tip /
    // decoder_lag_blocks are null for a coin when the decoder tip is unavailable. See
    // ExplorerClient.getStatus for the full field list.
    async getStatus() {
        return this._requireExplorer().getStatus();
    }

    // Unconfirmed mempool actions, type ∈ {address, token}.
    async getMempool(query, type, opts) {
        return this._requireExplorer().getMempool(query, type, opts);
    }

    // Network-wide summary (chain heights, indexer status, peer counts,
    // recommended finality confirmations). See ExplorerClient.getNetwork.
    async getNetwork(opts) {
        return this._requireExplorer().getNetwork(opts);
    }

    async search(query, type) {
        return this._requireExplorer().search(query, type);
    }


    /*
     *  WebSocket: Real-Time Event Methods
     */

    // Ensure WebSocket client is initialized
    _requireWs() {
        if (!this.ws)
            throw new SDKConfigError('WEBSOCKET_NOT_CONFIGURED', 'WebSocket not configured. Provide network + websocketUrl or explorerUrl, or use hub discovery via init().');
        return this.ws;
    }

    // Connect the WebSocket client (auto-called by init() if configured)
    async connectWs() {
        return this._requireWs().connect();
    }

    // Disconnect the WebSocket client
    disconnectWs() {
        if (this.ws) this.ws.disconnect();
    }

    // Fire-and-forget subscribe for the onX() helpers below.
    //
    // Those helpers are synchronous: they return an unsubscribe function, not a
    // promise, so NOTHING is awaiting the SUBSCRIBED confirmation. But
    // ws.subscribe() returns a promise that rejects with WS_TIMEOUT ten seconds
    // later if the explorer never confirms (it is down, returning 503, or the
    // socket dropped mid-handshake). With no consumer attached, that rejection
    // is unhandled -- and an unhandled rejection terminates the host process on
    // Node, which is how a transient explorer outage could take down a wallet's
    // Electron main process or kill a test run outright.
    //
    // The caller genuinely cannot act on this: it holds an unsubscribe fn, not a
    // promise. Losing the subscription is also self-healing, because the WS
    // client replays its tracked subscriptions on reconnect (_resubscribe). So
    // warn and carry on. Callers who DO want to await confirmation still can:
    // ws.subscribe() keeps rejecting for them.
    _subscribeDetached(ws, channels, params) {
        try {
            const pending = ws.subscribe(channels, params);
            if (pending && typeof pending.catch === 'function') {
                pending.catch((err) => {
                    console.warn(
                        'Subscription to [' + channels.join(', ') + '] was not confirmed: '
                        + (err && err.message ? err.message : err)
                        + ' (it will be replayed on reconnect)',
                    );
                });
            }
        } catch (err) {
            console.warn(
                'Subscription to [' + channels.join(', ') + '] failed: '
                + (err && err.message ? err.message : err),
            );
        }
    }

    // Listen for new blocks
    // Returns an unsubscribe function
    onBlock(callback) {
        const ws = this._requireWs();
        ws.on('NEW_BLOCK', callback);
        this._subscribeDetached(ws, ['blocks']);
        return () => {
            ws.off('NEW_BLOCK', callback);
            ws.unsubscribe(['blocks']);
        };
    }

    // Listen for new actions with optional type/status filters
    // Returns an unsubscribe function
    onAction(callback, opts) {
        const ws = this._requireWs();
        ws.on('NEW_ACTION', callback);
        let params = {};
        if (opts && opts.types)    params.types    = opts.types;
        // `statuses` is deliberately NOT forwarded (). No explorer channel
        // populates a per-event status: db.getActionsSince selects `NULL as status`,
        // and every outbound frame (NEW_ACTION, lifecycle events incl. ORDER_MATCH,
        // catch-up replay) derives its status from that row. Broadcaster._passesFilter
        // only rejects when status is truthy, so the filter could never reject anything.
        // The server matches this: it omits `statuses` from WELCOME features and from
        // the SUBSCRIBED active_filters. Forwarding it let a caller rely on a silent
        // no-op and believe it was receiving a filtered stream.
        if (opts && opts.ticks)    params.ticks    = opts.ticks;
        this._subscribeDetached(ws, ['actions'], Object.keys(params).length > 0 ? params : undefined);
        return () => {
            ws.off('NEW_ACTION', callback);
            ws.unsubscribe(['actions']);
        };
    }

    // Listen for events on a specific address
    // Returns an unsubscribe function
    onAddress(address, callback, opts) {
        const ws = this._requireWs();
        // Register handlers for all address-relevant event types
        const types = [
            'NEW_ACTION', 'ADDRESS_UPDATE',
            'ORDER_MATCH', 'COINPAY_REQUIRED', 'COINPAY_FULFILLED', 'COINPAY_EXPIRED',
            'SWAP_MATCH', 'DISPENSE'
        ];
        for (const t of types) ws.on(t, callback);

        let params = { address };
        if (opts && opts.types)    params.types    = opts.types;
        if (opts && opts.snapshot) params.snapshot  = true;

        // The explorer sends the requested initial-state frame as a
        // top-level 'SNAPSHOT' type (not one of the `types` above), so it
        // needs its own filtered handler or the frame is silently dropped.
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'address' && msg.data.address === address){
                callback(msg);
            }
        };
        if (opts && opts.snapshot) ws.on('SNAPSHOT', onSnapshot);

        this._subscribeDetached(ws, ['address'], params);

        return () => {
            for (const t of types) ws.off(t, callback);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['address'], { address });
        };
    }

    // Listen for token updates
    // Returns an unsubscribe function
    onToken(tick, callback) {
        const ws = this._requireWs();
        ws.on('TOKEN_UPDATE', callback);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'token' && msg.data.tick === tick){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        this._subscribeDetached(ws, ['token'], { tick, snapshot: true });
        return () => {
            ws.off('TOKEN_UPDATE', callback);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['token'], { tick });
        };
    }

    // Listen for market updates
    // Returns an unsubscribe function
    onMarket(tick1, tick2, callback) {
        const ws = this._requireWs();
        ws.on('MARKET_UPDATE', callback);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'market' &&
                msg.data.tick1 === tick1 && msg.data.tick2 === tick2){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        this._subscribeDetached(ws, ['market'], { tick1, tick2, snapshot: true });
        return () => {
            ws.off('MARKET_UPDATE', callback);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['market'], { tick1, tick2 });
        };
    }

    // Listen for dispenser updates
    // Returns an unsubscribe function
    onDispenser(actionIndex, callback) {
        const ws = this._requireWs();
        ws.on('DISPENSER_UPDATE', callback);
        ws.on('DISPENSE', callback);
        ws.on('DISPENSER_CLOSED', callback);
        ws.on('DISPENSER_EXPIRED', callback);
        const onSnapshot = (msg) => {
            if (msg && msg.data && msg.data.channel === 'dispenser' &&
                String(msg.data.action_index) === String(actionIndex)){
                callback(msg);
            }
        };
        ws.on('SNAPSHOT', onSnapshot);
        this._subscribeDetached(ws, ['dispenser'], { action_index: actionIndex, snapshot: true });
        return () => {
            ws.off('DISPENSER_UPDATE', callback);
            ws.off('DISPENSE', callback);
            ws.off('DISPENSER_CLOSED', callback);
            ws.off('DISPENSER_EXPIRED', callback);
            ws.off('SNAPSHOT', onSnapshot);
            ws.unsubscribe(['dispenser'], { action_index: actionIndex });
        };
    }

    // Shortcut: listen for COINPAY_REQUIRED events on an address
    // Returns an unsubscribe function
    onCoinpayRequired(address, callback) {
        const ws = this._requireWs();
        ws.on('COINPAY_REQUIRED', callback);
        this._subscribeDetached(ws, ['address'], { address, types: ['COINPAY_REQUIRED'] });
        return () => {
            ws.off('COINPAY_REQUIRED', callback);
            ws.unsubscribe(['address'], { address });
        };
    }

    // Shortcut: listen for ORDER_MATCH events on an address
    // Returns an unsubscribe function
    onOrderMatch(address, callback, opts) {
        const ws = this._requireWs();
        ws.on('ORDER_MATCH', callback);
        let params = { address, types: ['ORDER_MATCH'] };
        this._subscribeDetached(ws, ['address'], params);
        return () => {
            ws.off('ORDER_MATCH', callback);
            ws.unsubscribe(['address'], { address });
        };
    }

    // Wait for a transaction to be indexed by the explorer
    // Returns the action object when found, or rejects on timeout
    // opts: { timeout, pollInterval, requireValid, explorer | explorerUrl+explorerPort }
    // The explorer override targets a stack other than the one this SDK
    // discovered, for isolated venues with no colocated explorer .
    async waitForAction(txid, opts) {
        let waiter = new ActionWaiter(this);
        return waiter.waitForTxid(txid, opts);
    }

    // Wait for a specific action_index to appear in the explorer.
    // Same explorer override as waitForAction.
    async waitForActionIndex(actionIndex, opts) {
        let waiter = new ActionWaiter(this);
        return waiter.waitForActionIndex(actionIndex, opts);
    }

    // Listen for network stats updates
    // Returns an unsubscribe function
    onNetworkStats(callback) {
        const ws = this._requireWs();
        ws.on('NETWORK_STATS', callback);
        this._subscribeDetached(ws, ['network']);
        return () => {
            ws.off('NETWORK_STATS', callback);
            ws.unsubscribe(['network']);
        };
    }

}

module.exports = XChainSDK;
