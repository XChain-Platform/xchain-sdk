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
 * XChain Platform SDK - XChainSDK (Software Development Kit)
 *
 * This file handles parsing XChain Platform SDK requests
 *
 ********************************************************************/

// Load required libraries
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
const { SDKConfigError } = require('./errors.js');

class XChainSDK {

    // Handle constructing a class instance
    // Options are applied immediately for core + explicit URLs.
    // Hub discovery requires calling init() (async) after construction.
    constructor(options = {}) {

        // XChain Platform SDK Version
        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;

        // Store options
        this.options = options;

        // Initialize core (no network required)
        this.config    = config.getConfig();
        this.util      = new Utility();
        this.actions   = new Actions(this);
        this.contracts = new ContractUtils();

        // Wallet and auth modules (network-aware but don't require services)
        let network = options.network || process.env.NETWORK || null;
        this.wallet    = new WalletUtils(network);
        this.auth      = new AuthUtils(network);
        this.messaging = new MessagingUtils(network);

        // Service clients (initialized by _initClients or init)
        this.explorer = null;
        this.encoder  = null;
        this.hub      = null;
        this.ws       = null;

        // Initialize hub connector if hub URL provided
        if (options.hubUrl) {
            this.hub = new HubConnector(options);
        }

        // Initialize clients from explicit options / env vars
        this._initClients(options);
    }

    // Initialize explorer + encoder from resolved options
    // Config resolution: constructor options > env vars > defaults
    _initClients(resolved) {
        let network = resolved.network || process.env.NETWORK;
        let hooks   = this.options.hooks || {};
        let retry   = this.options.retry !== undefined ? this.options.retry : {};
        let pool    = this.options.pool || {};

        // Explorer
        let explorerUrl  = resolved.explorerUrl  || process.env.EXPLORER_URL;
        let explorerPort = resolved.explorerPort || process.env.EXPLORER_PORT;
        if (network && (explorerUrl || explorerPort)) {
            this.explorer = new ExplorerClient({
                network:      network,
                explorerUrl:  explorerUrl,
                explorerPort: explorerPort ? parseInt(explorerPort) : undefined,
                timeout:      resolved.timeout,
                hooks:        hooks,
                retry:        retry,
                pool:         pool
            });
        } else if (network) {
            this.explorer = new ExplorerClient({ network, timeout: resolved.timeout, hooks, retry, pool });
        }

        // Encoder
        let encoderUrl  = resolved.encoderUrl  || process.env.ENCODER_URL;
        let encoderPort = resolved.encoderPort || process.env.ENCODER_PORT;
        if (encoderUrl || encoderPort) {
            this.encoder = new EncoderClient({
                encoderUrl:  encoderUrl,
                encoderPort: encoderPort ? parseInt(encoderPort) : undefined,
                timeout:     resolved.timeout,
                hooks:       hooks,
                retry:       retry,
                pool:        pool
            });
        }

        // WebSocket (uses explorer URL/port by default unless explicit websocketUrl given)
        let websocketUrl  = resolved.websocketUrl  || this.options.websocketUrl  || process.env.WEBSOCKET_URL;
        let websocketPort = resolved.websocketPort || this.options.websocketPort || process.env.WEBSOCKET_PORT;
        if (network && (websocketUrl || websocketPort || explorerUrl || explorerPort)) {
            // Only create if not already created, or if URL changed
            let wsUrl  = websocketUrl  || explorerUrl;
            let wsPort = websocketPort ? parseInt(websocketPort) : (explorerPort ? parseInt(explorerPort) : undefined);
            if (!this.ws || this.ws.baseUrl !== wsUrl || this.ws.port !== wsPort) {
                // Disconnect old client if it exists
                if (this.ws) this.ws.disconnect();
                this.ws = new WebSocketClient({
                    network:       network,
                    websocketUrl:  wsUrl,
                    websocketPort: wsPort,
                    hooks:         hooks,
                    retry:         retry
                });
            }
        }
    }

    // Async initialization: fetch config from hub and resolve service endpoints
    // Call this after construction when using hub-based discovery.
    // Safe to call multiple times (re-fetches config).
    async init() {
        if (!this.hub) return;

        try {
            await this.hub.getAllConfig();
        } catch (err) {
            // Hub failure is non-fatal if explicit URLs were provided
            if (this.explorer && this.encoder) {
                console.warn('Hub unavailable, using explicit config:', err.message);
                return;
            }
            throw err;
        }

        // Extract service endpoints for our network
        let network   = this.options.network || process.env.NETWORK;
        let endpoints = this.hub.extractServiceEndpoints(network);

        // Apply hub-discovered endpoints where explicit options weren't provided
        // Resolution: constructor options > hub-discovered > env vars
        let resolved = {
            network:      network,
            explorerUrl:  this.options.explorerUrl  || endpoints.explorerUrl  || process.env.EXPLORER_URL,
            explorerPort: this.options.explorerPort || endpoints.explorerPort || process.env.EXPLORER_PORT,
            encoderUrl:   this.options.encoderUrl   || endpoints.encoderUrl   || process.env.ENCODER_URL,
            encoderPort:  this.options.encoderPort  || endpoints.encoderPort  || process.env.ENCODER_PORT,
            timeout:      this.options.timeout
        };

        // Re-initialize clients with resolved config
        this._initClients(resolved);

        // Start polling for config updates
        this.hub.startPolling((configs) => {
            let newEndpoints = this.hub.extractServiceEndpoints(network);
            let newResolved = {
                network:      network,
                explorerUrl:  this.options.explorerUrl  || newEndpoints.explorerUrl  || process.env.EXPLORER_URL,
                explorerPort: this.options.explorerPort || newEndpoints.explorerPort || process.env.EXPLORER_PORT,
                encoderUrl:   this.options.encoderUrl   || newEndpoints.encoderUrl   || process.env.ENCODER_URL,
                encoderPort:  this.options.encoderPort  || newEndpoints.encoderPort  || process.env.ENCODER_PORT,
                timeout:      this.options.timeout
            };
            this._initClients(newResolved);
        });
    }

    // Handle starting up the SDK (server mode with polling loop)
    async start() {
        console.log('Starting up ' + this.name + ' v' + this.version + '...');

        // Auto-init from hub if configured
        if (this.hub) await this.init();

        while (true) {
            if (this.stopFlag) break;
            await this.util.sleep(this.config['STOP_CHECK_INTERVAL']);
        }
    }

    // Stop the SDK (stop hub polling, disconnect WebSocket, set stop flag)
    stop() {
        this.stopFlag = true;
        if (this.hub) this.hub.stopPolling();
        if (this.ws) this.ws.disconnect();
    }

    // Ensure explorer is initialized before calling explorer methods
    _requireExplorer() {
        if (!this.explorer)
            throw new SDKConfigError('EXPLORER_NOT_CONFIGURED', 'Explorer not configured. Provide network + explorerUrl, or use hub discovery via init().');
        return this.explorer;
    }

    // Ensure encoder is initialized before calling encoder methods
    _requireEncoder() {
        if (!this.encoder)
            throw new SDKConfigError('ENCODER_NOT_CONFIGURED', 'Encoder not configured. Provide encoderUrl, or use hub discovery via init().');
        return this.encoder;
    }


    /*
     *  ACTION Methods (Phase 1)
     */

    // Create an action string and optionally encode it into a PSBT
    // If data.encoder contains pubkey, this calls the encoder and returns the PSBT
    async createAction(data) {
        let result = this.actions.createAction(data);

        // If encoder options with pubkey provided, encode the action into a PSBT
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
                customOutputs:    data.encoder.customOutputs
            });
            result.psbt     = txResult.psbt;
            result.encoding = txResult.encoding;
        }

        return result;
    }

    // Dry-run validation without building the string
    validateAction(action, params) {
        return this.actions.validateAction(action, params);
    }

    // Introspection: list all supported actions
    getActions() {
        return this.actions.getActions();
    }

    // Introspection: get format versions for an action
    getActionFormats(action) {
        return this.actions.getActionFormats(action);
    }

    // Introspection: get fields for an action + optional version
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

    // VM action convenience methods
    async deploy(params, encoder)    { return this.createAction({ action: 'DEPLOY', params, encoder }); }
    async execute(params, encoder)   { return this.createAction({ action: 'EXECUTE', params, encoder }); }
    async deposit(params, encoder)   { return this.createAction({ action: 'DEPOSIT', params, encoder }); }
    async withdraw(params, encoder)  { return this.createAction({ action: 'WITHDRAW', params, encoder }); }

    // Create a bound contract client for repeated interactions with a deployed contract
    contract(contractActionIndex) {
        return new ContractClient(this, contractActionIndex);
    }

    // Create a new BatchBuilder for fluent BATCH construction
    // Usage: sdk.batch().send({...}).mint({...}).build(encoderOpts?)
    batch() {
        return new BatchBuilder(this);
    }


    /*
     *  Encoder Methods (Phase 3)
     */

    // Direct access to encoder createTx (for advanced use / custom data)
    async encodeTx(params) {
        return this._requireEncoder().createTx(params);
    }

    // P2SH/P2WSH phase 2: spend a previously created P2SH/P2WSH output
    async spendP2sh(params) {
        return this._requireEncoder().spendP2sh(params);
    }

    // Ping the encoder
    async pingEncoder() {
        return this._requireEncoder().ping();
    }


    /*
     *  Hub Methods (Phase 4)
     */

    // Ping the hub
    async pingHub() {
        if (!this.hub) throw new SDKConfigError('HUB_NOT_CONFIGURED', 'Hub not configured. Provide hubUrl in SDK options.');
        return this.hub.ping();
    }

    // Get raw hub config (for debugging / advanced use)
    getHubConfig() {
        if (!this.hub) return null;
        return this.hub.configs;
    }


    /*
     *  Wallet Convenience Methods
     */

    signPsbt(psbtHex, wif)              { return this.wallet.signPsbt(psbtHex, wif); }
    async broadcastTx(txHex)            { return this.wallet.broadcastTx(txHex, this._requireEncoder()); }
    async getUTXOs(address)             { return this.wallet.getUTXOs(address, this._requireEncoder()); }
    validateAddress(address, network)   { return this.wallet.validateAddress(address, network); }
    importWIF(wif)                      { return this.wallet.importWIF(wif); }
    generateKeyPair(opts)               { return this.wallet.generateKeyPair(opts); }
    deriveAddress(publicKey, opts)      { return this.wallet.deriveAddress(publicKey, opts); }


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

    async getDispensers(query, type, opts) {
        return this._requireExplorer().getDispensers(query, type, opts);
    }

    async getDispenses(query, type, opts) {
        return this._requireExplorer().getDispenses(query, type, opts);
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

    async getSends(query, type, opts) {
        return this._requireExplorer().getSends(query, type, opts);
    }

    async getSleeps(query, type, opts) {
        return this._requireExplorer().getSleeps(query, type, opts);
    }

    async getSwaps(query, type, opts) {
        return this._requireExplorer().getSwaps(query, type, opts);
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

    async getContracts(query, type, opts) {
        return this._requireExplorer().getContracts(query, type, opts);
    }

    async getContractState(contractActionIndex, key) {
        return this._requireExplorer().getContractState(contractActionIndex, key);
    }

    async getContractBalance(contractActionIndex, tick) {
        return this._requireExplorer().getContractBalance(contractActionIndex, tick);
    }

    async getExecution(executionActionIndex) {
        return this._requireExplorer().getExecution(executionActionIndex);
    }

    async getExecutions(contractActionIndex, opts) {
        return this._requireExplorer().getExecutions(contractActionIndex, opts);
    }

    async getDeposits(query, type, opts) {
        return this._requireExplorer().getDeposits(query, type, opts);
    }

    async getWithdrawals(query, type, opts) {
        return this._requireExplorer().getWithdrawals(query, type, opts);
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


    /*
     *  Explorer: Utility Methods
     */

    async getStatus() {
        return this._requireExplorer().getStatus();
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

    // Listen for new blocks
    // Returns an unsubscribe function
    onBlock(callback) {
        const ws = this._requireWs();
        ws.on('NEW_BLOCK', callback);
        ws.subscribe(['blocks']);
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
        if (opts && opts.statuses) params.statuses = opts.statuses;
        if (opts && opts.ticks)    params.ticks    = opts.ticks;
        ws.subscribe(['actions'], Object.keys(params).length > 0 ? params : undefined);
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
        if (opts && opts.statuses) params.statuses = opts.statuses;
        if (opts && opts.snapshot) params.snapshot  = true;
        ws.subscribe(['address'], params);

        return () => {
            for (const t of types) ws.off(t, callback);
            ws.unsubscribe(['address'], { address });
        };
    }

    // Listen for token updates
    // Returns an unsubscribe function
    onToken(tick, callback) {
        const ws = this._requireWs();
        ws.on('TOKEN_UPDATE', callback);
        ws.subscribe(['token'], { tick, snapshot: true });
        return () => {
            ws.off('TOKEN_UPDATE', callback);
            ws.unsubscribe(['token'], { tick });
        };
    }

    // Listen for market updates
    // Returns an unsubscribe function
    onMarket(tick1, tick2, callback) {
        const ws = this._requireWs();
        ws.on('MARKET_UPDATE', callback);
        ws.subscribe(['market'], { tick1, tick2, snapshot: true });
        return () => {
            ws.off('MARKET_UPDATE', callback);
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
        ws.subscribe(['dispenser'], { action_index: actionIndex, snapshot: true });
        return () => {
            ws.off('DISPENSER_UPDATE', callback);
            ws.off('DISPENSE', callback);
            ws.off('DISPENSER_CLOSED', callback);
            ws.off('DISPENSER_EXPIRED', callback);
            ws.unsubscribe(['dispenser'], { action_index: actionIndex });
        };
    }

    // Shortcut: listen for COINPAY_REQUIRED events on an address
    // Returns an unsubscribe function
    onCoinpayRequired(address, callback) {
        const ws = this._requireWs();
        ws.on('COINPAY_REQUIRED', callback);
        ws.subscribe(['address'], { address, types: ['COINPAY_REQUIRED'] });
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
        if (opts && opts.statuses) params.statuses = opts.statuses;
        ws.subscribe(['address'], params);
        return () => {
            ws.off('ORDER_MATCH', callback);
            ws.unsubscribe(['address'], { address });
        };
    }

    // Listen for network stats updates
    // Returns an unsubscribe function
    onNetworkStats(callback) {
        const ws = this._requireWs();
        ws.on('NETWORK_STATS', callback);
        ws.subscribe(['network']);
        return () => {
            ws.off('NETWORK_STATS', callback);
            ws.unsubscribe(['network']);
        };
    }

}

module.exports = XChainSDK;

module.exports = XChainSDK;
