/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with the License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform SDK - TypeScript Type Definitions
 *
 ********************************************************************/


/*
 *  Retry configuration
 */

export interface RetryConfig {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Initial delay in milliseconds before the first retry (default: 1000) */
    baseDelay?: number;
    /** Maximum delay in milliseconds between retries (default: 30000) */
    maxDelay?: number;
    /** Exponential backoff multiplier (default: 2) */
    backoffFactor?: number;
}


/*
 *  Hook info types
 */

export interface RequestInfo {
    service: 'explorer' | 'encoder' | 'hub';
    method: string;
    url?: string;
    params?: Record<string, any>;
}

export interface ResponseInfo {
    service: 'explorer' | 'encoder' | 'hub';
    method: string;
    url?: string;
    status?: number;
    result?: any;
}

export interface ErrorInfo {
    service: 'explorer' | 'encoder' | 'hub';
    method: string;
    url?: string;
    error: string;
}

export interface RetryInfo {
    service: 'explorer' | 'encoder' | 'hub';
    method: string;
    url?: string;
    attempt: number;
    delay: number;
    error: string;
}


/*
 *  Lifecycle hooks
 */

export interface SDKHooks {
    /** Called before each outbound request */
    onRequest?: (info: RequestInfo) => void;
    /** Called after each successful response */
    onResponse?: (info: ResponseInfo) => void;
    /** Called on a non-retryable error */
    onError?: (info: ErrorInfo) => void;
    /** Called before each retry attempt */
    onRetry?: (info: RetryInfo) => void;
}


/*
 *  Connection pool configuration
 */

export interface PoolConfig {
    /** Enable HTTP keep-alive (default: true) */
    keepAlive?: boolean;
    /** Initial delay for keep-alive packets in milliseconds (default: 1000) */
    keepAliveMsecs?: number;
    /** Maximum number of concurrent sockets (default: 10) */
    maxSockets?: number;
    /** Maximum number of free sockets in the pool (default: 5) */
    maxFreeSockets?: number;
}


/*
 *  SDK constructor options
 */

export interface SDKOptions {
    /**
     * Target network string, e.g. `'bitcoin-mainnet'`, `'litecoin-regtest'`.
     * Valid values: `bitcoin-mainnet`, `bitcoin-testnet`, `bitcoin-regtest`,
     * `litecoin-mainnet`, `litecoin-testnet`, `litecoin-regtest`,
     * `dogecoin-mainnet`, `dogecoin-testnet`, `dogecoin-regtest`.
     */
    network?: string;
    /** Hostname or IP of the xchain-explorer service */
    explorerUrl?: string;
    /** Port of the xchain-explorer service (default: 8080) */
    explorerPort?: number;
    /** Hostname or IP of the xchain-encoder service */
    encoderUrl?: string;
    /** Port of the xchain-encoder service (default: 3000) */
    encoderPort?: number;
    /** Hostname or IP of the xchain-hub service */
    hubUrl?: string;
    /** Port of the xchain-hub service (default: 8001) */
    hubPort?: number;
    /** How often the hub is polled for config updates in milliseconds (default: 60000) */
    hubPollInterval?: number;
    /** HTTP request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Retry configuration, or `false` to disable retries entirely */
    retry?: RetryConfig | false;
    /** Lifecycle hooks for observability */
    hooks?: SDKHooks;
    /** HTTP connection-pool settings applied to explorer and encoder clients */
    pool?: PoolConfig;
}


/*
 *  Encoder options (passed as the second argument to convenience methods,
 *  or as `data.encoder` in createAction)
 */

export type EncodingType = 'OP_RETURN' | 'P2SH' | 'P2WSH' | 'MULTISIGN';

export interface UTXO {
    txid: string;
    vout: number;
    value: number;
    [key: string]: any;
}

export interface CustomOutput {
    address: string;
    value: number;
    [key: string]: any;
}

export interface EncoderOptions {
    /** Sender's public key or address (required when encoding to a PSBT) */
    pubkey: string;
    /** Change address (defaults to pubkey on the encoder side) */
    change?: string;
    /** UTXOs to spend; omit to let the encoder auto-fetch from the UTXO tracker */
    utxos?: UTXO[];
    /** Force a specific encoding method */
    encoding?: EncodingType;
    /** Fixed fee in satoshis */
    fee?: number;
    /** Fee rate in satoshis per kilobyte for automatic fee calculation */
    feePerKb?: number;
    /** Enable Replace-By-Fee signalling */
    rbf?: boolean;
    /** Dust threshold override in satoshis */
    dust?: number;
    /** Include unconfirmed UTXOs (default: true on the encoder side) */
    unconfirmed?: boolean;
    /** Compressed public key — required for MULTISIGN encoding */
    compressedPubKey?: string;
    /** Additional transaction outputs beyond the protocol output */
    customOutputs?: CustomOutput[];
    /** Raw binary data appended after the ACTION string (used by the FILE action) */
    rawData?: string | Buffer;
}

/** Parameters for the P2SH spend phase (phase 2 of the two-transaction pattern) */
export interface SpendP2shParams {
    /** Sender's public key or address */
    pubkey: string;
    /** Hash of the P2SH output created in phase 1 */
    p2shHash: string;
    /** Full hex of the transaction that contains the P2SH output */
    p2shHex: string;
    change?: string;
    fee?: number;
    feePerKb?: number;
    rbf?: boolean;
    dust?: number;
    unconfirmed?: boolean;
}


/*
 *  Action result
 */

export interface ActionResult {
    /** ACTION name in upper-case, e.g. `'SEND'` */
    action: string;
    /** Protocol version number selected for the action */
    version: number;
    /** Serialized pipe-delimited ACTION string ready for embedding */
    actionString: string;
    /** Key/value map of the resolved field values */
    fields: Record<string, any>;
    /** Encoding type used, populated only when a PSBT was also produced */
    encoding?: EncodingType;
    /** Unsigned PSBT in hex, populated only when encoder options were provided */
    psbt?: string;
}

/** Response returned by the encoder for createTx / spendP2sh */
export interface EncoderResult {
    /** Unsigned PSBT in hex */
    psbt: string;
    /** Encoding type that was used */
    encoding: EncodingType;
}


/*
 *  Validation
 */

export interface ValidationResult {
    /** Whether the action + params combination is valid */
    valid: boolean;
    /** List of validation error messages; empty when valid */
    errors: string[];
}


/*
 *  Explorer query options
 */

export interface QueryOptions {
    /** Page number for paginated results (1-based) */
    page?: number;
    /** Number of results per page */
    limit?: number;
    /** Sort direction: `'asc'` or `'desc'` */
    sortorder?: 'asc' | 'desc';
    /** DataTables-style start offset */
    start?: number;
    /** DataTables-style page length */
    length?: number;
}


/*
 *  Action-specific parameter interfaces
 */

/** Base type — all action params are open records */
export type ActionParams = Record<string, any>;

export interface SendParams extends ActionParams {
    /** Destination address */
    destination: string;
    /** Token ticker symbol */
    tick: string;
    /** Amount to send */
    amount: number | string;
    /** Optional memo */
    memo?: string;
}

export interface IssueParams extends ActionParams {
    /** Token ticker symbol to issue */
    tick: string;
    /** Maximum supply */
    max?: number | string;
    /** Per-mint limit */
    lim?: number | string;
    /** Decimals (default: 8) */
    dec?: number;
    /** Token description */
    description?: string;
}

export interface MintParams extends ActionParams {
    /** Token ticker to mint */
    tick: string;
    /** Amount to mint */
    amount: number | string;
}

export interface DestroyParams extends ActionParams {
    /** Token ticker to destroy */
    tick: string;
    /** Amount to destroy */
    amount: number | string;
}

export interface OrderParams extends ActionParams {
    /** Token ticker being offered */
    give_tick: string;
    /** Amount being offered */
    give_amount: number | string;
    /** Token ticker being requested */
    get_tick: string;
    /** Amount being requested */
    get_amount: number | string;
    /** Optional expiry block height */
    expiration?: number;
}

export interface DispenserParams extends ActionParams {
    /** Token ticker to dispense */
    tick: string;
    /** Amount dispensed per fill */
    give_amount: number | string;
    /** Coin amount required to trigger a fill */
    escrow_amount: number | string;
    /** Main-chain satoshi threshold */
    mainchainrate: number | string;
    /** Dispenser status (0 = open, 10 = closed) */
    status?: number;
}

export interface DividendParams extends ActionParams {
    /** Dividend amount per unit held */
    quantity_per_unit: number | string;
    /** Dividend token ticker */
    dividend_tick: string;
    /** Token whose holders receive the dividend */
    of_tick: string;
}

export interface SweepParams extends ActionParams {
    /** Destination address */
    destination: string;
    /** Flags controlling what is swept */
    flags?: number;
    /** Optional memo */
    memo?: string;
}

export interface BroadcastParams extends ActionParams {
    /** Timestamp of the broadcast */
    timestamp: number | string;
    /** Value field */
    value?: number | string;
    /** Feed label */
    feed_name?: string;
    /** Broadcast text */
    text?: string;
}

export interface SwapParams extends ActionParams {
    /** Token ticker being offered */
    give_tick: string;
    /** Amount being offered */
    give_amount: number | string;
    /** Token ticker being requested */
    get_tick: string;
    /** Amount being requested */
    get_amount: number | string;
    /** Referenced order action index */
    order_action_index?: number | string;
}

export interface CallbackParams extends ActionParams {
    /** Block height at which the callback fires */
    block: number;
    /** Fraction to call back */
    fraction: number | string;
    /** Token ticker */
    tick: string;
}

export interface SleepParams extends ActionParams {
    /** Number of blocks to sleep */
    blocks: number;
}

export interface AirdropParams extends ActionParams {
    /** Token ticker to airdrop */
    tick: string;
    /** Amount per recipient */
    amount: number | string;
    /** Action index of a LIST that defines recipients */
    list_action_index: number | string;
}

export interface MessageParams extends ActionParams {
    /** Message content */
    message: string;
}

export interface ListParams extends ActionParams {
    /** Newline- or comma-separated list of addresses */
    values: string;
}

export interface LinkParams extends ActionParams {
    /** URL or reference to link */
    url: string;
    /** Optional description */
    description?: string;
}

export interface FileParams extends ActionParams {
    /** MIME type of the file */
    type: string;
    /** File name */
    name?: string;
}

export interface AddressParams extends ActionParams {
    /** New address to associate with the sender */
    address: string;
}

export interface DeployParams extends ActionParams {
    /** Raw JavaScript source code (SDK hex-encodes it into CODE_ENCODING) */
    code?: string;
    /** Pre-encoded hex of contract source (alternative to `code`) */
    codeEncoding?: string;
    /** Maximum gas units allowed for deployment */
    gasLimit: number;
    /** Optional constructor arguments passed to the contract */
    constructorParams?: string[];
}

export interface ExecuteParams extends ActionParams {
    /** ACTION_INDEX of the deployed contract */
    contractActionIndex: number | string;
    /** Method name to call on the contract */
    method: string;
    /** Method arguments (each element becomes a pipe-delimited segment) */
    params?: string[];
}

export interface DepositParams extends ActionParams {
    /** ACTION_INDEX of the target contract */
    contractActionIndex: number | string;
    /** Token ticker or ticker ID (^N) */
    tick: string;
    /** Amount to deposit */
    quantity: number | string;
}

export interface WithdrawParams extends ActionParams {
    /** ACTION_INDEX of the target contract */
    contractActionIndex: number | string;
    /** Token ticker or ticker ID (^N) */
    tick: string;
    /** Amount to withdraw */
    quantity: number | string;
}

export interface ContractInfo {
    actionIndex: number;
    address: string;
    owner: string;
    codeHash?: string;
    status?: string;
    deployBlock?: number;
    gasLimit?: number;
    [key: string]: any;
}

export interface ContractStateEntry {
    key: string;
    value: any;
}

export interface ContractBalanceEntry {
    tick: string;
    balance: string;
}

export interface ExecutionInfo {
    actionIndex: number;
    contractActionIndex: number;
    method: string;
    params?: string[];
    success: boolean;
    gasUsed: number;
    returnValue?: string;
    [key: string]: any;
}

export interface CodeSizeResult {
    bytes: number;
    withinLimit: boolean;
    limit: number;
}

export interface SyntaxValidationResult {
    valid: boolean;
    error?: string;
    warnings?: string[];
}

export interface GasEstimate {
    suggested: number;
    rationale: string;
}

/** Input shape for createAction */
export interface CreateActionData {
    /** ACTION name, e.g. `'SEND'` */
    action: string;
    /** Action-specific parameters */
    params: ActionParams;
    /** When present (and pubkey is set), the action is also encoded into a PSBT */
    encoder?: EncoderOptions;
}


/*
 *  Error classes
 */

export declare class SDKError extends Error {
    /** Machine-readable error code, e.g. `'ENCODER_TIMEOUT'` */
    code: string;
    /** Structured diagnostic context */
    details: Record<string, any>;
    constructor(code: string, message: string, details?: Record<string, any>);
}

export declare class SDKValidationError extends SDKError {}
export declare class SDKFormatError extends SDKError {}
export declare class SDKEncoderError extends SDKError {}
export declare class SDKExplorerError extends SDKError {}
export declare class SDKHubError extends SDKError {}
export declare class SDKConfigError extends SDKError {}
export declare class SDKContractError extends SDKError {}


/*
 *  BatchBuilder class
 */

export declare class BatchBuilder {
    constructor(sdk: XChainSDK);

    /** Add an action by name and params */
    add(action: string, params?: ActionParams): this;

    // Convenience methods — mirror XChainSDK convenience methods minus FILE and BATCH
    send(params: SendParams | ActionParams): this;
    issue(params: IssueParams | ActionParams): this;
    mint(params: MintParams | ActionParams): this;
    destroy(params: DestroyParams | ActionParams): this;
    order(params: OrderParams | ActionParams): this;
    broadcast(params: BroadcastParams | ActionParams): this;
    dispenser(params: DispenserParams | ActionParams): this;
    dividend(params: DividendParams | ActionParams): this;
    sweep(params: SweepParams | ActionParams): this;
    swap(params: SwapParams | ActionParams): this;
    callback(params: CallbackParams | ActionParams): this;
    sleep(params: SleepParams | ActionParams): this;
    airdrop(params: AirdropParams | ActionParams): this;
    message(params: MessageParams | ActionParams): this;
    list(params: ListParams | ActionParams): this;
    link(params: LinkParams | ActionParams): this;
    address(params: AddressParams | ActionParams): this;

    // VM action convenience methods (DEPLOY excluded from BATCH)
    execute(params: ExecuteParams | ActionParams): this;
    deposit(params: DepositParams | ActionParams): this;
    withdraw(params: WithdrawParams | ActionParams): this;

    /**
     * Validate all queued actions, build the semicolon-joined BATCH command string,
     * and optionally encode it into a PSBT.
     *
     * Throws `SDKValidationError` if constraints are violated (empty batch, nested
     * BATCH, FILE action, more than one MINT, more than one ISSUE).
     */
    build(encoderOpts?: EncoderOptions): Promise<ActionResult>;

    /** Reset the builder so it can be reused */
    reset(): this;

    /** Number of actions currently queued */
    readonly length: number;
}


/*
 *  Contract utilities (sdk.contracts namespace)
 */

export declare class ContractUtils {
    /** Hex-encode contract source code for DEPLOY payloads */
    encode(sourceCode: string): string;
    /** Hex-decode back to UTF-8 source */
    decode(hexString: string): string;
    /** Lightweight syntax pre-validation (acorn-based, no V8 required) */
    validate(sourceCode: string): SyntaxValidationResult;
    /** Detect float literal usage in contract source */
    checkFloatUsage(sourceCode: string): string[];
    /** Check if contract source is within the 64KB size limit */
    checkCodeSize(sourceCode: string): CodeSizeResult;
    /** Heuristic gas limit suggestion based on code complexity */
    suggestGasLimit(sourceCode: string): GasEstimate;
}


/*
 *  Contract client (bound to a specific deployed contract)
 */

export declare class ContractClient {
    /** ACTION_INDEX of the bound contract */
    readonly contractActionIndex: number;

    constructor(sdk: XChainSDK, contractActionIndex: number);

    /** Execute a method on the contract (creates EXECUTE action) */
    call(method: string, params?: string[], encoder?: EncoderOptions): Promise<ActionResult>;
    /** Deposit tokens into the contract (creates DEPOSIT action) */
    deposit(tick: string, quantity: number | string, encoder?: EncoderOptions): Promise<ActionResult>;
    /** Withdraw tokens from the contract (creates WITHDRAW action) */
    withdraw(tick: string, quantity: number | string, encoder?: EncoderOptions): Promise<ActionResult>;

    /** Get contract metadata from explorer */
    getInfo(): Promise<ContractInfo>;
    /** Get contract state (all keys or a specific key) */
    getState(key?: string): Promise<ContractStateEntry | ContractStateEntry[]>;
    /** Get contract execution history */
    getExecutions(opts?: QueryOptions): Promise<ExecutionInfo[]>;
    /** Get contract token balances */
    getBalance(tick?: string): Promise<ContractBalanceEntry | ContractBalanceEntry[]>;
}


/*
 *  XChainSDK class
 */

export declare class XChainSDK {

    /** Package version string */
    readonly version: string | undefined;
    /** Package name string */
    readonly name: string | undefined;
    /** Raw options passed to the constructor */
    readonly options: SDKOptions;

    constructor(options?: SDKOptions);

    /**
     * Fetch configuration from the hub and (re-)initialize service clients.
     * Must be called after construction when using hub-based service discovery.
     * Safe to call multiple times.
     */
    init(): Promise<void>;

    /**
     * Start the SDK in server mode: calls `init()` if hub is configured, then
     * enters a polling loop. Returns only after `stop()` is called.
     */
    start(): Promise<void>;

    /** Stop the polling loop and hub config updates. */
    stop(): void;


    /*
     *  Action methods
     */

    /**
     * Create an XChain action string and, when `data.encoder.pubkey` is set,
     * encode it into an unsigned PSBT via the encoder service.
     */
    createAction(data: CreateActionData): Promise<ActionResult>;

    /** Validate action params without building the string. */
    validateAction(action: string, params: ActionParams): ValidationResult;

    /** Return the list of all supported ACTION names. */
    getActions(): string[];

    /** Return all version format descriptors for the given action. */
    getActionFormats(action: string): object;

    /** Return the ordered field names for an action, optionally for a specific version. */
    getActionFields(action: string, version?: number | string): string[];


    /*
     *  Convenience action methods
     */

    send(params: SendParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    issue(params: IssueParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    mint(params: MintParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    destroy(params: DestroyParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    order(params: OrderParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    /** Alias for `send()` */
    transfer(params: SendParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    broadcast(params: BroadcastParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    dispenser(params: DispenserParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    dividend(params: DividendParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    sweep(params: SweepParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    swap(params: SwapParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    callback(params: CallbackParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    sleep(params: SleepParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    airdrop(params: AirdropParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    message(params: MessageParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    list(params: ListParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    link(params: LinkParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    file(params: FileParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    address(params: AddressParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;

    // VM action convenience methods
    deploy(params: DeployParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    execute(params: ExecuteParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    deposit(params: DepositParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    withdraw(params: WithdrawParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;

    /** Create a new `BatchBuilder` for fluent BATCH construction. */
    batch(): BatchBuilder;

    /** Contract authoring utilities (hex encoding, validation, gas estimation) */
    readonly contracts: ContractUtils;

    /** Create a bound contract client for repeated interactions with a deployed contract */
    contract(contractActionIndex: number): ContractClient;


    /*
     *  Encoder methods
     */

    /**
     * Direct access to the encoder's `create_tx` RPC method.
     * Useful for advanced or custom-data encoding outside the standard action pipeline.
     */
    encodeTx(params: EncoderOptions & { data: string }): Promise<EncoderResult>;

    /**
     * Execute phase 2 of the P2SH/P2WSH two-transaction pattern: spend a
     * previously funded P2SH/P2WSH output to reveal the embedded data.
     */
    spendP2sh(params: SpendP2shParams): Promise<EncoderResult>;

    /** Ping the encoder service. Returns the RPC result. */
    pingEncoder(): Promise<any>;


    /*
     *  Hub methods
     */

    /** Ping the hub. Returns `true` if the hub is reachable, `false` otherwise. */
    pingHub(): Promise<boolean>;

    /**
     * Return the raw config object last fetched from the hub, or `null` if the
     * hub has not been contacted yet or is not configured.
     */
    getHubConfig(): object | null;


    /*
     *  Explorer: Balance & Address methods
     */

    /** Get all token balances for an address. */
    getBalances(address: string, opts?: QueryOptions): Promise<any>;

    /** Get address summary information. */
    getAddress(address: string): Promise<any>;

    /** Get holders of a token. */
    getHolders(tick: string, opts?: QueryOptions): Promise<any>;

    /** Get credit records filtered by query and type. */
    getCredits(query: string, type: string, opts?: QueryOptions): Promise<any>;

    /** Get debit records filtered by query and type. */
    getDebits(query: string, type: string, opts?: QueryOptions): Promise<any>;

    /** Get escrow records filtered by query and type. */
    getEscrows(query: string, type: string, opts?: QueryOptions): Promise<any>;


    /*
     *  Explorer: Token methods
     */

    /** Get a single token by ticker. */
    getToken(tick: string): Promise<any>;

    /** Get tokens filtered by query and type. */
    getTokens(query: string, type: string, opts?: QueryOptions): Promise<any>;

    /** Get issue records filtered by query and type. */
    getIssues(query: string, type: string, opts?: QueryOptions): Promise<any>;


    /*
     *  Explorer: Transaction & History methods
     */

    /** Get a transaction by txid or other query identifier and type. */
    getTransaction(query: string, type: string): Promise<any>;

    /** Get a single indexed action by its ACTION_INDEX. */
    getAction(actionIndex: number | string): Promise<any>;

    /** Get a block record by block index or height. */
    getBlock(blockIndex: number | string): Promise<any>;

    /** Get history records filtered by query and type. */
    getHistory(query: string, type: string, opts?: QueryOptions): Promise<any>;


    /*
     *  Explorer: ACTION-specific query methods
     */

    getAddresses(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getAirdrops(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getBatches(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getBroadcasts(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getCallbacks(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDestroys(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDispensers(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDispenses(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDividends(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getFees(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getFiles(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getLinks(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getLists(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getMessages(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getMints(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getOrders(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSends(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSleeps(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSwaps(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSweeps(query: string, type: string, opts?: QueryOptions): Promise<any>;


    /*
     *  Explorer: Contract / VM methods
     */

    /** Get contract metadata by its deploy ACTION_INDEX */
    getContract(contractActionIndex: number | string): Promise<ContractInfo>;

    /** Get a list of contracts, optionally filtered by owner address */
    getContracts(query?: string, type?: string, opts?: QueryOptions): Promise<ContractInfo[]>;

    /** Get contract state entries (all keys or a specific key) */
    getContractState(contractActionIndex: number | string, key?: string): Promise<ContractStateEntry | ContractStateEntry[]>;

    /** Get contract token balances */
    getContractBalance(contractActionIndex: number | string, tick?: string): Promise<ContractBalanceEntry | ContractBalanceEntry[]>;

    /** Get a single execution result by its ACTION_INDEX */
    getExecution(executionActionIndex: number | string): Promise<ExecutionInfo>;

    /** Get execution history for a contract */
    getExecutions(contractActionIndex?: number | string, opts?: QueryOptions): Promise<ExecutionInfo[]>;

    /** Get deposits for a contract */
    getDeposits(query: string, type: string, opts?: QueryOptions): Promise<any>;

    /** Get withdrawals for a contract */
    getWithdrawals(query: string, type: string, opts?: QueryOptions): Promise<any>;


    /*
     *  Explorer: Market methods
     */

    /** Get all markets, or markets for a specific token ticker. */
    getMarkets(tick?: string): Promise<any>;

    /** Get the market between two token tickers. */
    getMarket(tick1: string, tick2: string): Promise<any>;

    /** Get trade history for a market, optionally filtered to a single address. */
    getMarketHistory(tick1: string, tick2: string, address?: string, opts?: QueryOptions): Promise<any>;

    /** Get open orders for a market, optionally filtered to a single address. */
    getMarketOrders(tick1: string, tick2: string, address?: string, opts?: QueryOptions): Promise<any>;

    /** Get the current order book for a market. */
    getOrderbook(tick1: string, tick2: string): Promise<any>;


    /*
     *  Explorer: Utility methods
     */

    /** Get explorer service status. */
    getStatus(): Promise<any>;

    /** Search the explorer for a query string of a given type. */
    search(query: string, type: string): Promise<any>;


    /*
     *  Wallet convenience methods
     */

    /** Sign an unsigned PSBT hex with a WIF private key */
    signPsbt(psbtHex: string, wif: string): SignPsbtResult;

    /** Broadcast a signed transaction hex via the encoder */
    broadcastTx(txHex: string): Promise<BroadcastResult>;

    /** Fetch UTXOs for an address via the encoder */
    getUTXOs(address: string): Promise<UTXOEntry[]>;

    /** Validate a coin address */
    validateAddress(address: string, network?: XChainNetwork): AddressValidationResult;

    /** Import a WIF-encoded private key */
    importWIF(wif: string): KeyPairResult;

    /** Generate a new random keypair */
    generateKeyPair(opts?: { compressed?: boolean }): KeyPairResult;

    /** Derive an address from a public key */
    deriveAddress(publicKey: Buffer | string, opts?: { type?: AddressType }): string;


    /*
     *  Auth convenience methods
     */

    /** Generate a challenge for wallet ownership verification */
    generateChallenge(address: string, opts?: ChallengeOptions): ChallengeResult;

    /** Sign a message with a WIF private key */
    signMessage(message: string, wif: string, opts?: SignMessageOptions): SignMessageResult;

    /** Verify wallet ownership via a signed message */
    verifyOwnership(address: string, message: string, signature: string, network?: XChainNetwork): VerifyResult;

    /** Verify any signed message */
    verifyMessage(address: string, message: string, signature: string, network?: XChainNetwork): VerifyResult;
}


/*
 *  Network types
 */

export type XChainNetwork =
    | 'bitcoin-mainnet' | 'bitcoin-testnet' | 'bitcoin-regtest'
    | 'litecoin-mainnet' | 'litecoin-testnet' | 'litecoin-regtest'
    | 'dogecoin-mainnet' | 'dogecoin-testnet' | 'dogecoin-regtest';

export type AddressType = 'p2pkh' | 'p2wpkh' | 'p2sh-p2wpkh' | 'p2sh' | 'p2wsh' | 'bech32';


/*
 *  Wallet types
 */

export interface KeyPairResult {
    wif: string;
    privateKey: Buffer;
    publicKey: Buffer;
    publicKeyHex: string;
    compressed: boolean;
}

export interface AddressValidationResult {
    valid: boolean;
    type: AddressType | null;
    network: XChainNetwork | null;
    error: string | null;
}

export interface SignPsbtResult {
    txHex: string;
    txid: string;
    psbtHex: string;
}

export interface BroadcastResult {
    txid: string;
}

export interface UTXOEntry {
    txid: string;
    vout: number;
    value: number;
}


/*
 *  Auth types
 */

export interface ChallengeOptions {
    appId?: string;
    nonce?: string;
    message?: string;
    expiresInMs?: number;
}

export interface ChallengeResult {
    challenge: string;
    nonce: string;
    timestamp: string;
    expiresAt: string;
}

export interface SignMessageOptions {
    segwitRedeemScript?: boolean;
    segwitNative?: boolean;
    network?: XChainNetwork;
}

export interface SignMessageResult {
    signature: string;
    address: string;
}

export interface VerifyResult {
    valid: boolean;
    address?: string;
    error: string | null;
}


/*
 *  WalletUtils class
 */

export declare class WalletUtils {
    readonly network: XChainNetwork | null;
    constructor(network?: XChainNetwork | null);

    importWIF(wif: string): KeyPairResult;
    generateKeyPair(opts?: { compressed?: boolean }): KeyPairResult;
    deriveAddress(publicKey: Buffer | string, opts?: { type?: AddressType }): string;
    validateAddress(address: string, network?: XChainNetwork): AddressValidationResult;
    signPsbt(psbtHex: string, wif: string): SignPsbtResult;
    broadcastTx(txHex: string, encoder: any): Promise<BroadcastResult>;
    getUTXOs(address: string, encoder: any): Promise<UTXOEntry[]>;
}


/*
 *  AuthUtils class
 */

export declare class AuthUtils {
    readonly network: XChainNetwork | null;
    constructor(network?: XChainNetwork | null);

    generateChallenge(address: string, opts?: ChallengeOptions): ChallengeResult;
    signMessage(message: string, wif: string, opts?: SignMessageOptions): SignMessageResult;
    verifyOwnership(address: string, message: string, signature: string, network?: XChainNetwork): VerifyResult;
    verifyMessage(address: string, message: string, signature: string, network?: XChainNetwork): VerifyResult;
}


/*
 *  Wallet / Auth error classes
 */

export declare class SDKWalletError extends SDKError {}
export declare class SDKAuthError extends SDKError {}


/*
 *  Module exports (CommonJS interop)
 */

export { XChainSDK, BatchBuilder, ContractClient, ContractUtils, WalletUtils, AuthUtils, SDKError, SDKValidationError, SDKFormatError, SDKEncoderError, SDKExplorerError, SDKHubError, SDKConfigError, SDKContractError, SDKWalletError, SDKAuthError };
export default XChainSDK;
