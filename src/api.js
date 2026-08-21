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
const XChainSDK  = require('./XChainSDK');
const { safeTokenEqual } = require('./utils/safeCompare.js');
const { parseCorsOrigin } = require('./corsOrigin.js');
// Request guards live in their own module so the shipped middleware has exactly
// one implementation: this file starts listening at require time, so a unit test
// can only reach the guards through src/apiGuards.js.
const {
    resolveMaxBatch,
    resolveRateLimit,
    resolveRateWindowMs,
    batchCapMiddleware,
    rateLimitMiddleware
} = require('./apiGuards.js');

// Parse in .env config data
dotenv.config();

// Parse in the environmental variables
const SDK_API_PORT = process.env.SDK_API_PORT || 3005;
// Helper-API key. Always fails closed: action-creation methods can carry key
// material in their params, so without a configured key every method except
// ping is rejected (401) rather than left open.
const SDK_API_KEY  = process.env.SDK_API_KEY || '';
if(!SDK_API_KEY)
    console.warn('WARNING: SDK_API_KEY is not set. All helper-API methods except ping will return 401. Set SDK_API_KEY to use the API.');
// Batch-cap and rate-limit settings, parsed by the guard module (each one falls
// back to a safe default on a junk value; see src/apiGuards.js).
const SDK_API_MAX_BATCH      = resolveMaxBatch(process.env);
const SDK_API_RATE_LIMIT     = resolveRateLimit(process.env);
const SDK_API_RATE_WINDOW_MS = resolveRateWindowMs(process.env);
const NETWORK      = process.env.NETWORK;
const EXPLORER_URL = process.env.EXPLORER_URL;
const EXPLORER_PORT = process.env.EXPLORER_PORT;
const ENCODER_URL  = process.env.ENCODER_URL;
const ENCODER_PORT = process.env.ENCODER_PORT;
const HUB_API_HOST = process.env.HUB_API_HOST;
const HUB_PORT     = process.env.HUB_PORT;

// Start up the API
async function startApi() {

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
            console.log('Hub config loaded successfully');
        } catch (err) {
            console.warn('Hub init failed, continuing with explicit config:', err);
        }
    }

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // CORS disabled by default. CORS_ORIGIN is a comma-separated ALLOWLIST, not a
    // single origin: handing `cors` the raw string echoes it back verbatim to every
    // caller, which is a multi-value header no browser accepts. See
    // src/corsOrigin.js.
    app.use(cors({ origin: parseCorsOrigin(process.env.CORS_ORIGIN) }));

    // Batch fan-out cap, BEFORE the auth gate and the router: capping ahead of
    // the auth gate bounds the unauthenticated ping path too, and ahead of the
    // router means nothing is dispatched before the count is known good. Why a
    // byte-size limit is not enough: src/apiGuards.js.
    app.use(batchCapMiddleware(SDK_API_MAX_BATCH));

    // Per-credential (falling back to per-IP) request-rate limit, also ahead of
    // the auth gate so an anonymous ping flood is bounded. The API key stops
    // ANONYMOUS use; it does nothing about sustained traffic from a valid,
    // shared or leaked credential, and the batch cap above bounds one request's
    // fan-out rather than the request rate. The two are complementary and
    // neither substitutes for the other. Only the configured key earns its own
    // bucket: an unvalidated token is counted against the source address, so a
    // per-request rotating junk token cannot mint a fresh bucket each time.
    app.use(rateLimitMiddleware({
        limit: SDK_API_RATE_LIMIT,
        windowMs: SDK_API_RATE_WINDOW_MS,
        isCredential: (token) => !!SDK_API_KEY && safeTokenEqual(token, SDK_API_KEY)
    }));

    // API key enforcement for all methods except ping. Fails closed: without
    // a configured key, every non-ping method is rejected, never left open.
    app.use((req, res, next) => {
        // A JSON-RPC batch arrives as an array of call objects; a single call as
        // one object. express-json-rpc-router dispatches every element of an
        // array body, so the gate must inspect ALL of them: require the key if
        // ANY element is a non-ping method. Reading req.body.method off an array
        // leaves it undefined, which would let a batch smuggle non-ping methods
        // past this fail-closed check unauthenticated.
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
        let needsAuth = calls.some(call => {
            let method = call && call.method;
            return method && method.toLowerCase() !== 'ping';
        });
        if (needsAuth) {
            let header = req.headers['authorization'];
            let got = (typeof header === 'string' && header.startsWith('Bearer ')) ? header.slice(7) : null;
            if (!SDK_API_KEY || !safeTokenEqual(got, SDK_API_KEY)) {
                return res.status(401).json({
                    jsonrpc: '2.0', id,
                    error: { code: -32001, message: 'Unauthorized' }
                });
            }
        }
        next();
    });

    // Define JSON-RPC controller with all SDK methods
    const controller = {

        /*
         *  System
         */

        async ping() {
            return { status: 'success' };
        },


        /*
         *  Action Methods
         */

        async create_action(params) {
            return sdk.createAction(params);
        },

        async validate_action(params) {
            return sdk.validateAction(params.action, params.params);
        },

        async get_actions() {
            return sdk.getActions();
        },

        async get_action_formats(params) {
            return sdk.getActionFormats(params.action);
        },

        async get_action_fields(params) {
            return sdk.getActionFields(params.action, params.version);
        },


        /*
         *  Encoder Methods
         */

        async encode_tx(params) {
            return sdk.encodeTx(params);
        },

        async spend_p2sh(params) {
            return sdk.spendP2sh(params);
        },

        async ping_encoder() {
            return sdk.pingEncoder();
        },


        /*
         *  Hub Methods
         */

        async ping_hub() {
            return sdk.pingHub();
        },

        async get_hub_config() {
            return sdk.getHubConfig();
        },


        /*
         *  Explorer: Balance & Address
         */

        async get_balances(params) {
            return sdk.getBalances(params.address, params.options);
        },

        async get_address(params) {
            return sdk.getAddress(params.address);
        },

        async get_holders(params) {
            return sdk.getHolders(params.tick, params.options);
        },

        async get_credits(params) {
            return sdk.getCredits(params.query, params.type, params.options);
        },

        async get_debits(params) {
            return sdk.getDebits(params.query, params.type, params.options);
        },

        async get_escrows(params) {
            return sdk.getEscrows(params.query, params.type, params.options);
        },


        /*
         *  Explorer: Tokens
         */

        async get_token(params) {
            return sdk.getToken(params.tick);
        },

        async get_tokens(params) {
            return sdk.getTokens(params.query, params.type, params.options);
        },

        async get_issues(params) {
            return sdk.getIssues(params.query, params.type, params.options);
        },


        /*
         *  Explorer: Transactions & History
         */

        async get_transaction(params) {
            return sdk.getTransaction(params.query, params.type);
        },

        async get_action(params) {
            return sdk.getAction(params.actionIndex);
        },

        async get_block(params) {
            return sdk.getBlock(params.blockIndex);
        },

        async get_history(params) {
            return sdk.getHistory(params.query, params.type, params.options);
        },


        /*
         *  Explorer: ACTION-Specific Queries
         */

        async get_addresses(params) {
            return sdk.getAddresses(params.query, params.type, params.options);
        },

        async get_airdrops(params) {
            return sdk.getAirdrops(params.query, params.type, params.options);
        },

        async get_batches(params) {
            return sdk.getBatches(params.query, params.type, params.options);
        },

        async get_broadcasts(params) {
            return sdk.getBroadcasts(params.query, params.type, params.options);
        },

        async get_callbacks(params) {
            return sdk.getCallbacks(params.query, params.type, params.options);
        },

        async get_destroys(params) {
            return sdk.getDestroys(params.query, params.type, params.options);
        },

        async get_dispensers(params) {
            return sdk.getDispensers(params.query, params.type, params.options);
        },

        async get_dispenses(params) {
            return sdk.getDispenses(params.query, params.type, params.options);
        },

        async get_dividends(params) {
            return sdk.getDividends(params.query, params.type, params.options);
        },

        async get_fees(params) {
            return sdk.getFees(params.query, params.type, params.options);
        },

        async get_files(params) {
            return sdk.getFiles(params.query, params.type, params.options);
        },

        async get_links(params) {
            return sdk.getLinks(params.query, params.type, params.options);
        },

        async get_lists(params) {
            return sdk.getLists(params.query, params.type, params.options);
        },

        async get_messages(params) {
            return sdk.getMessages(params.query, params.type, params.options);
        },

        async get_mints(params) {
            return sdk.getMints(params.query, params.type, params.options);
        },

        async get_orders(params) {
            return sdk.getOrders(params.query, params.type, params.options);
        },

        async get_sends(params) {
            return sdk.getSends(params.query, params.type, params.options);
        },

        async get_sleeps(params) {
            return sdk.getSleeps(params.query, params.type, params.options);
        },

        async get_swaps(params) {
            return sdk.getSwaps(params.query, params.type, params.options);
        },

        async get_sweeps(params) {
            return sdk.getSweeps(params.query, params.type, params.options);
        },


        /*
         *  Explorer: Markets
         */

        async get_markets(params) {
            return sdk.getMarkets(params ? params.tick : undefined);
        },

        async get_market(params) {
            return sdk.getMarket(params.tick1, params.tick2);
        },

        async get_market_history(params) {
            return sdk.getMarketHistory(params.tick1, params.tick2, params.address, params.options);
        },

        async get_market_orders(params) {
            return sdk.getMarketOrders(params.tick1, params.tick2, params.address, params.options);
        },

        async get_orderbook(params) {
            return sdk.getOrderbook(params.tick1, params.tick2);
        },


        /*
         *  Explorer: Utility
         */

        async get_status() {
            return sdk.getStatus();
        },

        async search(params) {
            return sdk.search(params.query, params.type);
        }

    };

    // Machine-readable API spec (OpenRPC 1.3.2). Regenerated by docs/openrpc.build.js;
    // test/unit/openrpc-coverage.test.js keeps it in lockstep with the controller.
    // GET requests carry no JSON-RPC method, so the auth middleware lets this through.
    // Read once at wiring time rather than lazily inside the handler, so serving
    // the spec never touches the filesystem on a request. A missing file leaves
    // the route answering 503 instead of failing startup, since the spec is
    // documentation and no query path depends on it.
    let openrpcSpec = null;
    try {
        openrpcSpec = require('fs').readFileSync(require('path').join(__dirname, '../docs/openrpc.json'));
    } catch (e) {
        console.warn('SDK API: docs/openrpc.json is unreadable (%s); /openrpc.json will answer 503', e.code || e.message);
    }
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

    // Start the server
    app.listen(SDK_API_PORT, () => {
        console.log('SDK API listening on port ' + SDK_API_PORT);
    });

}

startApi();
