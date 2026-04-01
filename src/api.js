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
 * XChain SDK - API
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

// Parse in .env config data
dotenv.config();

// Parse in the environmental variables
const SDK_API_PORT = process.env.SDK_API_PORT || 3005;
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
            console.warn('Hub init failed, continuing with explicit config:', err.message);
        }
    }

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS for development
    app.use(cors());

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

    // Allow JSON-RPC requests
    app.use(jsonRouter({ methods: controller }));

    // Start the server
    app.listen(SDK_API_PORT, () => {
        console.log('SDK API listening on port ' + SDK_API_PORT);
    });

}

startApi();
