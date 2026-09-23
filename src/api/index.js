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
 * XChain Platform SDK - API
 *
 * This file starts the JSON-RPC server exposing all SDK methods
 *
 ********************************************************************/

// Load required libraries
const dotenv     = require('dotenv');
const express    = require('express');
const bodyParser = require('body-parser');
const helmet     = require('helmet');
const cors       = require('cors');
const jsonRouter = require('express-json-rpc-router');
const XChainSDK  = require('../XChainSDK');
const { safeTokenEqual } = require('../utils/safe_compare.js');
const { parseCorsOrigin } = require('../utils/cors_origin.js');
const Config = require('../config.js');
// Request guards live in their own module so the shipped middleware has exactly
// one implementation: the guard tests mount src/utils/api_guards.js directly and
// pin, from the router stack of the app createApp builds, that it wires the same
// functions in order.
const {
    parseWholeNumber,
    resolveMaxBatch,
    resolveRateLimit,
    resolveRateWindowMs,
    batchCapMiddleware,
    rateLimitMiddleware,
    authGateMiddleware
} = require('../utils/api_guards.js');
const { getLogger } = require('../observability/logger.js');
const log = getLogger('xchain-sdk:api');

// Parse in .env config data
dotenv.config();

// Parse in the environmental variables
const SDK_API_PORT = Config.env.sdkApiPort() || 3005;
// Helper-API key. Always fails closed: action-creation methods can carry key
// material in their params, so without a configured key every method except
// ping is rejected (401) rather than left open.
const SDK_API_KEY  = Config.env.sdkApiKey() || '';
if(!SDK_API_KEY)
    log.warn('WARNING: SDK_API_KEY is not set. All helper-API methods except ping will return 401. Set SDK_API_KEY to use the API.');
// Batch-cap and rate-limit settings, parsed by the guard module (each one falls
// back to a safe default on a junk value; see src/utils/api_guards.js). With no
// argument, each resolver reads process.env through its own default parameter.
const SDK_API_MAX_BATCH      = resolveMaxBatch();
const SDK_API_RATE_LIMIT     = resolveRateLimit();
// Say so when the limiter setting was unusable. A silent substitution is what
// made the truncation bug expensive: the operator believed the value they typed
// was in force, and nothing in the log said otherwise.
if(Config.env.sdkApiRateLimit() !== undefined && parseWholeNumber(Config.env.sdkApiRateLimit()) === null)
    log.warn('WARNING: SDK_API_RATE_LIMIT is not a whole number; using the default of ' + SDK_API_RATE_LIMIT +
                 ' requests per window. Set it to exactly 0 to disable the limiter.');
const SDK_API_RATE_WINDOW_MS = resolveRateWindowMs();
const NETWORK      = Config.env.network();
const EXPLORER_URL = Config.env.explorerUrl();
const EXPLORER_PORT = Config.env.explorerPort();
const ENCODER_URL  = Config.env.encoderUrl();
const ENCODER_PORT = Config.env.encoderPort();
const HUB_API_HOST = Config.env.hubApiHost();
const HUB_PORT     = Config.env.hubPort();

// Installs immediate request parsing and batch guards in their required security order.
function configureBaseMiddleware(app) {
    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // CORS disabled by default. CORS_ORIGIN is a comma-separated ALLOWLIST, not a
    // single origin: handing `cors` the raw string echoes it back verbatim to every
    // caller, which is a multi-value header no browser accepts. See
    // src/utils/cors_origin.js.
    app.use(cors({ origin: parseCorsOrigin(Config.env.corsOrigin()) }));

    // Batch fan-out cap, BEFORE the auth gate and the router: capping ahead of
    // the auth gate bounds the unauthenticated ping path too, and ahead of the
    // router means nothing is dispatched before the count is known good. Why a
    // byte-size limit is not enough: src/utils/api_guards.js.
    app.use(batchCapMiddleware(SDK_API_MAX_BATCH));
}

// Builds System, Action Methods, Encoder Methods, Hub Methods, Explorer Balance and Address, Tokens, Transactions and History, ACTION-Specific Queries, Markets, and Utility groups synchronously so startup introduces no extra yield points.
function createController(sdk) {
    const controller = {
        async ping() { return { status: 'success' }; },
        async create_action(params) { return sdk.createAction(params); },
        async validate_action(params) { return sdk.validateAction(params.action, params.params); },
        async get_actions() { return sdk.getActions(); },
        async get_action_formats(params) { return sdk.getActionFormats(params.action); },
        async get_action_fields(params) { return sdk.getActionFields(params.action, params.version); },
        async encode_tx(params) { return sdk.encodeTx(params); },
        async spend_p2sh(params) { return sdk.spendP2sh(params); },
        async ping_encoder() { return sdk.pingEncoder(); },
        async ping_hub() { return sdk.pingHub(); },
        async get_hub_config() { return sdk.getHubConfig(); },
        async get_balances(params) { return sdk.getBalances(params.address, params.options); },
        async get_address(params) { return sdk.getAddress(params.address); },
        async get_holders(params) { return sdk.getHolders(params.tick, params.options); },
        async get_credits(params) { return sdk.getCredits(params.query, params.type, params.options); },
        async get_debits(params) { return sdk.getDebits(params.query, params.type, params.options); },
        async get_escrows(params) { return sdk.getEscrows(params.query, params.type, params.options); },
        async get_token(params) { return sdk.getToken(params.tick); },
        async get_tokens(params) { return sdk.getTokens(params.query, params.type, params.options); },
        async get_issues(params) { return sdk.getIssues(params.query, params.type, params.options); },
        async get_transaction(params) { return sdk.getTransaction(params.query, params.type); },
        async get_action(params) { return sdk.getAction(params.actionIndex); },
        async get_block(params) { return sdk.getBlock(params.blockIndex); },
        async get_history(params) { return sdk.getHistory(params.query, params.type, params.options); },
        async get_addresses(params) { return sdk.getAddresses(params.query, params.type, params.options); },
        async get_airdrops(params) { return sdk.getAirdrops(params.query, params.type, params.options); },
        async get_batches(params) { return sdk.getBatches(params.query, params.type, params.options); },
        async get_broadcasts(params) { return sdk.getBroadcasts(params.query, params.type, params.options); },
        async get_callbacks(params) { return sdk.getCallbacks(params.query, params.type, params.options); },
        async get_destroys(params) { return sdk.getDestroys(params.query, params.type, params.options); },
        async get_dispensers(params) { return sdk.getDispensers(params.query, params.type, params.options); },
        async get_dispenses(params) { return sdk.getDispenses(params.query, params.type, params.options); },
        async get_dividends(params) { return sdk.getDividends(params.query, params.type, params.options); },
        async get_fees(params) { return sdk.getFees(params.query, params.type, params.options); },
        async get_files(params) { return sdk.getFiles(params.query, params.type, params.options); },
        async get_links(params) { return sdk.getLinks(params.query, params.type, params.options); },
        async get_lists(params) { return sdk.getLists(params.query, params.type, params.options); },
        async get_messages(params) { return sdk.getMessages(params.query, params.type, params.options); },
        async get_mints(params) { return sdk.getMints(params.query, params.type, params.options); },
        async get_orders(params) { return sdk.getOrders(params.query, params.type, params.options); },
        async get_sends(params) { return sdk.getSends(params.query, params.type, params.options); },
        async get_sleeps(params) { return sdk.getSleeps(params.query, params.type, params.options); },
        async get_swaps(params) { return sdk.getSwaps(params.query, params.type, params.options); },
        async get_sweeps(params) { return sdk.getSweeps(params.query, params.type, params.options); },
        async get_markets(params) { return sdk.getMarkets(params ? params.tick : undefined); },
        async get_market(params) { return sdk.getMarket(params.tick1, params.tick2); },
        async get_market_history(params) { return sdk.getMarketHistory(params.tick1, params.tick2, params.address, params.options); },
        async get_market_orders(params) { return sdk.getMarketOrders(params.tick1, params.tick2, params.address, params.options); },
        async get_orderbook(params) { return sdk.getOrderbook(params.tick1, params.tick2); },
        async get_status() { return sdk.getStatus(); },
        async search(params) { return sdk.search(params.query, params.type); }
    };
    return controller;
}

// Loads documentation during startup so requests never perform filesystem access.
function loadOpenRpcSpec() {
    // Machine-readable API spec (OpenRPC 1.3.2). Regenerated by docs/openrpc.build.js;
    // test/unit/openrpc_coverage.test.js keeps it in lockstep with the controller.
    // GET requests carry no JSON-RPC method, so the auth middleware lets this through.
    // Read once at wiring time rather than lazily inside the handler, so serving
    // the spec never touches the filesystem on a request. A missing file leaves
    // the route answering 503 instead of failing startup, since the spec is
    // documentation and no query path depends on it.
    try {
        return require('fs').readFileSync(require('path').join(__dirname, '../../docs/openrpc.json'));
    } catch (e) {
        log.warn('SDK API: docs/openrpc.json is unreadable (%s); /openrpc.json will answer 503', e.code || e.message);
        return null;
    }
}

// Builds the express app around an initialised SDK: every guard, the controller
// and the routes, in the security order the guard tests pin. Synchronous and
// listener-free, so a consumer can mount the result under its own server.
function createApp(sdk) {
    const app = express();
    configureBaseMiddleware(app);

    // Apply a per-credential (falling back to per-IP) request-rate limit ahead of the auth gate so an anonymous ping flood is bounded. The API key stops ANONYMOUS use;
    // it does nothing about sustained traffic from a valid, shared or leaked credential, and the batch cap above bounds one request's fan-out rather than the request rate. The two are complementary and neither substitutes for the other.
    // Only the configured key earns its own bucket: an unvalidated token is counted against the source address, so a per-request rotating junk token cannot mint a fresh bucket each time.
    app.use(rateLimitMiddleware({
        limit: SDK_API_RATE_LIMIT,
        windowMs: SDK_API_RATE_WINDOW_MS,
        isCredential: (token) => !!SDK_API_KEY && safeTokenEqual(token, SDK_API_KEY)
    }));
    // Enforce the API key for all methods except ping and fail closed when unset: every non-ping method is rejected, never left open.
    // Keep batch-smuggling and non-string-method rules in the shared guard so tests exercise this exact middleware.
    app.use(authGateMiddleware({ apiKey: SDK_API_KEY }));
    const controller = createController(sdk);
    const openrpcSpec = loadOpenRpcSpec();
    app.get('/openrpc.json', (req, res) => {
        if (!openrpcSpec)
            return res.status(503).json({ error: 'OpenRPC spec unavailable' });
        res.set('Cache-Control', 'public, max-age=3600');
        res.type('application/json').send(openrpcSpec);
    });

    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    // Allow JSON-RPC requests
    app.use(jsonRouter({ methods: controller }));
    return app;
}

// Start up the API: build the SDK from the environment, run its hub discovery,
// then listen on `port` (SDK_API_PORT unless a consumer passes its own). Resolves
// to the http.Server as listen() is issued, so the caller can await 'listening' and close it.
async function startApi({ port = SDK_API_PORT } = {}) {
    // Initialize the SDK
    const sdk = new XChainSDK({
        network:      NETWORK,
        explorerUrl:  EXPLORER_URL,
        explorerPort: EXPLORER_PORT ? parseInt(EXPLORER_PORT) : undefined,
        encoderUrl:   ENCODER_URL,
        encoderPort:  ENCODER_PORT ? parseInt(ENCODER_PORT) : undefined,
        hubUrl:       HUB_API_HOST,
        hubPort:      HUB_PORT ? parseInt(HUB_PORT) : undefined
    });
    // Run async init (hub discovery) if hub is configured
    if (sdk.hub) {
        try {
            await sdk.init();
            log.log('Hub config loaded successfully');
        } catch (err) {
            log.warn('Hub init failed, continuing with explicit config:', err);
        }
    }
    // Create and configure the app synchronously before registering deferred handlers.
    const app = createApp(sdk);

    // Start the server
    return app.listen(port, () => {
        log.log('SDK API listening on port ' + port);
    });
}

module.exports = { createApp, startApi };

// Only the CLI entry (`npm run api`, `node ./src/api/index.js`) opens the
// listener at load. A require() of this module gets the exports and no socket.
if (require.main === module)
    startApi();
