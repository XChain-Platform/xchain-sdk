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
    /** Raw JavaScript source code (SDK base64-encodes it into CODE_ENCODING) */
    code?: string;
    /** Pre-encoded base64 of contract source (alternative to `code`) */
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
    /** Declared emission allowlist (programmable policy layer); null/absent = unrestricted */
    permissions?: string[] | null;
    /** Declared royalty cap in basis points (snake_case on the wire); null/absent = global cap */
    max_take_bps?: number | null;
    [key: string]: any;
}

/** Normalized permissions manifest (programmable policy layer). See sdk.getContractManifest. */
export interface ContractManifest {
    /** Declared emission allowlist; null = no allowlist (unrestricted, the default) */
    permissions: string[] | null;
    /** Declared royalty cap in basis points; null = the global cap applies */
    maxTakeBps: number | null;
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

/** A single contract-lint finding (from sdk.validateContract). */
export interface ContractLintFinding {
    /** Stable rule id, e.g. 'banned-math', 'crossCallable-not-array', 'unbounded-loop'. */
    rule: string;
    /** Human-readable message. */
    message: string;
    /** 1-based source line, or null when not line-specific. */
    line: number | null;
    /** 'error' fails the lint; 'warning' is advisory. */
    severity: 'error' | 'warning';
}

/**
 * Result of sdk.validateContract — advisory. The isolated-vm V8 syntax compile
 * runs only at deploy/CLI, so `authoritative` is always false; a clean result
 * means the contract passes every acorn-coverable deploy rule.
 */
export interface ContractValidationResult {
    /** True iff there are no error-severity findings. */
    valid: boolean;
    errors: ContractLintFinding[];
    warnings: ContractLintFinding[];
    authoritative: false;
}

/** The scaffoldable template and pattern names (from sdk.listTemplates). */
export interface ContractTemplateList {
    templates: string[];
    patterns: string[];
}

/** Pre-flight lint options for sdk.deploy(). */
export interface DeployLintOptions {
    /**
     * 'block' (default): throw before building the action if the contract has
     * lint errors. 'warn': log and proceed. 'off': skip the pre-flight lint.
     */
    lint?: 'block' | 'warn' | 'off';
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
    /** Base64-encode contract source code for DEPLOY payloads */
    encode(sourceCode: string): string;
    /** Base64-decode back to UTF-8 source */
    decode(b64String: string): string;
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
 *  NFT helpers — pure builders for the NFT pattern (ISSUE with DECIMALS=0 +
 *  LOCK_MAX_SUPPLY=1). No network. Spec: protocol/NFT_Standard.md
 */

export interface NftUniqueParams { tick: string; description?: string; transfer?: string; memo?: string; }
export interface NftEditionParams extends NftUniqueParams {
    supply: string | number;
    mint?: { maxMint: string | number; perAddress?: string | number; startBlock?: string | number; stopBlock?: string | number };
}
export interface NftCollectionItemParams { parent: string; name: string; description?: string; transfer?: string; memo?: string; }
export interface NftAttachContentParams {
    coin?: string;
    fileCoin?: string;
    issueCoin?: string;
    fileActionIndex: string | number;
    issueActionIndex: string | number;
    memo?: string;
}
// Shape for the sdk.attachContent() workflow (uploads the FILE, then LINKs it) — distinct
// from NftAttachContentParams (the LINK param builder, which takes an existing file index).
export interface NftAttachContentOpts {
    coin?: string;
    issueActionIndex: string | number;
    file: { name: string; type: string; title?: string; memo?: string; rawData?: string | Buffer };
    memo?: string;
}

export declare class NftHelpers {
    /** Build ISSUE params for a unique 1-of-1 (DECIMALS=0, LOCK_MAX_SUPPLY=1, supply 1, minted 1) */
    unique(params: NftUniqueParams): ActionParams;
    /** Build ISSUE params for an edition of N identical prints; pass `mint` for a fair-mint window */
    edition(params: NftEditionParams): ActionParams;
    /** Build ISSUE params for a child TICK `parent.name` as a 1-of-1 */
    collectionItem(params: NftCollectionItemParams): ActionParams;
    /** Build LINK params attaching a FILE to a token's ISSUE (owner-validated by the indexer) */
    attachContentParams(params: NftAttachContentParams): ActionParams;
    /** Canonical classifier: true when DECIMALS=0 AND LOCK_MAX_SUPPLY=1 (UPPER_SNAKE or camelCase keys) */
    isNft(token: Record<string, unknown> | null | undefined): boolean;
}


/*
 *  Project registry helpers — pure builders for owner-attested official-token
 *  rosters (TICK-type LIST + LINK to the project's ISSUE). No network.
 *  Spec: protocol/Project_Registry.md
 */

export interface ProjectRosterParams { ticks: string[] | string; }
export interface ProjectRosterEditParams {
    listActionIndex: string | number;
    add?: string[] | string;
    remove?: string[] | string;
}
export interface ProjectAttestRosterParams {
    coin: string;
    listActionIndex: string | number;
    issueActionIndex: string | number;
    memo?: string;
}
// Shape for the sdk.setRoster() workflow (publishes the LIST, then LINKs it).
export interface ProjectSetRosterOpts {
    coin: string;
    issueActionIndex: string | number;
    ticks?: string[] | string;
    edit?: ProjectRosterEditParams;
    memo?: string;
}

export declare class ProjectHelpers {
    /** Build LIST params for a new official-token roster (LIST v0, TYPE=TICK) */
    rosterParams(params: ProjectRosterParams): ActionParams;
    /** Build LIST params deriving a new roster from an existing one (LIST v1, add OR remove) */
    rosterEditParams(params: ProjectRosterEditParams): ActionParams;
    /** Build LINK params attesting a roster to the project's ISSUE (owner-validated by the indexer) */
    attestRosterParams(params: ProjectAttestRosterParams): ActionParams;
}


/*
 *  Controller (programmable-policy) helpers — pure builders for the bind/unbind
 *  wire actions (ISSUE v6 for a token, ADDRESS v1 for an account) that route a
 *  native action class to a guard contract. No network.
 *  Spec: protocol/Controller_Bound_Tokens.md
 */

/** A native action class a token/account may route to a guard contract */
export type ControllerActionClass = 'transfer' | 'trade' | 'burn' | 'mint' | 'stake';

export interface ControllerBindTokenParams {
    tick: string;
    controller: string | number;
    actionClass: ControllerActionClass | string;
    cooldownBlocks?: string | number;
    memo?: string;
}
export interface ControllerUnbindTokenParams {
    tick: string;
    actionClass: ControllerActionClass | string;
    memo?: string;
}
export interface ControllerBindAddressParams {
    controller: string | number;
    actionClass: ControllerActionClass | string;
    cooldownBlocks?: string | number;
    memo?: string;
}
export interface ControllerUnbindAddressParams {
    actionClass: ControllerActionClass | string;
    memo?: string;
}

export declare class ControllerHelpers {
    /** The canonical action-class list (for dropdowns / validation) */
    actionClasses(): ControllerActionClass[];
    /** Build ISSUE v6 params binding a token's action class to a guard contract (UNBIND=0) */
    bindToken(params: ControllerBindTokenParams): ActionParams;
    /** Build ISSUE v6 params dropping a token's controller binding (UNBIND=1) */
    unbindToken(params: ControllerUnbindTokenParams): ActionParams;
    /** Build ADDRESS v1 params binding the SOURCE account's action class to a guard contract (UNBIND=0) */
    bindAddress(params: ControllerBindAddressParams): ActionParams;
    /** Build ADDRESS v1 params dropping the SOURCE account's controller binding (UNBIND=1) */
    unbindAddress(params: ControllerUnbindAddressParams): ActionParams;
}


/*
 *  AttestationHelpers — pure builders for External Attestation Framework
 *  payloads (used inside contract source; not submitted by the SDK directly).
 *  Spec: protocol/External_Attestation_Framework.md
 */

export interface AttestationLlmOpts {
    /** Prompt text to send to the LLM provider (required) */
    prompt: string;
    /** Optional system message */
    system?: string;
    /** Maximum tokens in the response */
    maxTokens?: number;
    /** Response format: 'text' (default) or 'json_object' */
    format?: 'text' | 'json_object';
    /** Sampling temperature */
    temperature?: number;
    /** Envelope version (default: current) */
    envelopeVersion?: number;
}

export interface AttestationRequestOpts {
    /** Number of independent providers that must agree (default: 1) */
    redundancy?: number;
    /** Block deadline for the attestation response */
    deadlineBlocks?: number;
    /** Tick used to pay the attestation fee (must be 'XCHAIN' for v1 consensus) */
    feeTick?: string;
    /** Amount to pay the attestation provider (decimal string) */
    feeAmount?: string;
}

export declare const AttestationHelpers: {
    /** Build a JSON envelope string for an LLM attestation provider request */
    llm(opts: AttestationLlmOpts): string;
    /** Validate and return an https-only URL for an http_get attestation provider request (max 2048 bytes) */
    httpGet(opts: string | { url: string }): string;
    /** Build the options object that the VM gateway reads for a provider request */
    requestOptions(opts?: AttestationRequestOpts): AttestationRequestOpts;
};


/*
 *  GatedFileUtils — AES-256-GCM encryption / key-handoff (de)serialization
 *  for FILE v1 token-gated content.
 *  Spec: protocol/TOKEN_GATED_CONTENT.md
 */

export interface GenerateKeyResult {
    /** 32-byte symmetric key */
    key: Buffer;
    /** hex sha256(key) — matches the FILE v1 KEY_HASH field */
    keyHash: string;
}

export interface EncryptFileResult {
    /** Encrypted bytes: [iv(12)][authTag(16)][ciphertext] */
    ciphertext: Buffer;
    /** 32-byte symmetric key */
    key: Buffer;
    /** hex sha256(key) */
    keyHash: string;
}

export interface EncryptPackResult {
    /** One ciphertext per plaintext, all sharing the same key */
    ciphertexts: Buffer[];
    /** 32-byte symmetric key */
    key: Buffer;
    /** hex sha256(key) */
    keyHash: string;
}

// Internal: reached only via `sdk.gatedFile`; not re-exported from index.js, so declared (not exported) here.
declare class GatedFileUtils {
    /** Generate a fresh random 256-bit symmetric key */
    generateKey(): GenerateKeyResult;

    /** Encrypt plaintext under an existing key (pack composition) */
    encryptWithKey(plaintext: Buffer | string, key: Buffer): Buffer;

    /** Single-file convenience: generate a key then encrypt in one call */
    encryptFileBytes(plaintext: Buffer | string): EncryptFileResult;

    /** Pack convenience: generate one key, encrypt N plaintexts under it */
    encryptPack(plaintexts: Array<Buffer | string>): EncryptPackResult;

    /**
     * Decrypt ciphertext produced by encryptWithKey / encryptFileBytes / encryptPack.
     * @throws SDKGatedFileError on GCM authentication failure.
     */
    decryptFileBytes(ciphertext: Buffer, key: Buffer): Buffer;

    /** Verify that a symmetric key matches a KEY_HASH (hex sha256) */
    verifyKey(key: Buffer, keyHash: string): boolean;

    /**
     * Serialize one or more keys into the binary handoff payload
     * (sent via MESSAGE v2 ECIES binary mode).
     * Wire: [0x01][32-byte K1][32-byte K2]...
     */
    serializeKeyPayload(keys: Buffer[] | Record<string, Buffer>): Buffer;

    /**
     * Parse a binary handoff payload after ECIES decryption.
     * Returns an array of 32-byte candidate keys.
     * @throws SDKGatedFileError if the payload is malformed.
     */
    parseKeyPayload(payload: Buffer | string): Buffer[];
}


/*
 *  MuSig2 — BIP327 key aggregation, nonce generation, and Schnorr
 *  multi-signature primitives.
 */

export interface MuSig2KeyGenContext {
    /** 33-byte compressed aggregated public key */
    aggPublicKey: Uint8Array;
    /** 32-byte x-only form, suitable for Taproot */
    xOnlyPubkey: Uint8Array;
    gacc: Uint8Array;
    tacc: Uint8Array;
}

export interface MuSig2GenerateNonceParams {
    /** Our 33-byte compressed public key */
    publicKey: Uint8Array;
    /** Optional secret key (32 bytes) — improves nonce randomness */
    secretKey?: Uint8Array;
    /** 32 bytes of session randomness; library uses secure random if omitted */
    sessionId?: Uint8Array;
    /** Aggregated x-only public key (binds nonce to the key-agg context) */
    xOnlyPublicKey?: Uint8Array;
    /** 32-byte message to be signed */
    msg?: Uint8Array;
    /** Additional entropy */
    extraInput?: Uint8Array;
}

export interface MuSig2PartialSignParams {
    /** 32-byte secret key */
    secretKey: Uint8Array;
    /** 66-byte public nonce from generateNonce (must be from this instance) */
    publicNonce: Uint8Array;
    /** Session key from startSession */
    sessionKey: object;
    /** Self-verify the partial signature (default: true) */
    verify?: boolean;
}

export interface MuSig2VerifyPartialParams {
    /** 32-byte partial signature */
    sig: Uint8Array;
    /** 33-byte compressed public key of the signer */
    publicKey: Uint8Array;
    /** 66-byte public nonce */
    publicNonce: Uint8Array;
    /** Session key from startSession */
    sessionKey: object;
}

export declare class MuSig2 {
    /**
     * Aggregate N public keys into a single MuSig2 key-gen context.
     * @param publicKeys  33-byte compressed pubkeys (hex string or Uint8Array).
     * @param tweaks      Optional post-aggregation tweaks.
     */
    aggregateKeys(publicKeys: Array<Uint8Array | string>, tweaks?: Uint8Array[]): MuSig2KeyGenContext;

    /**
     * Sort public keys into BIP327 canonical order.
     */
    sortKeys(publicKeys: Array<Uint8Array | string>): Uint8Array[];

    /**
     * Generate a MuSig2 nonce (round 1).
     * Returns a 66-byte public nonce; secret nonce is cached internally.
     */
    generateNonce(params: MuSig2GenerateNonceParams): Uint8Array;

    /**
     * Aggregate N 66-byte public nonces into a single 66-byte aggNonce.
     */
    aggregateNonces(publicNonces: Uint8Array[]): Uint8Array;

    /**
     * Start a MuSig2 signing session.
     * Returns a session key consumed by partialSign / verifyPartial / aggregateSignatures.
     */
    startSession(aggNonce: Uint8Array, msg: Uint8Array, publicKeys: Array<Uint8Array | string>, tweaks?: Uint8Array[]): object;

    /**
     * Produce a 32-byte partial signature using the secret nonce cached by generateNonce.
     */
    partialSign(params: MuSig2PartialSignParams): Uint8Array;

    /**
     * Verify a partial signature. Returns true if valid.
     */
    verifyPartial(params: MuSig2VerifyPartialParams): boolean;

    /**
     * Aggregate N 32-byte partial signatures into a single 64-byte Schnorr signature.
     */
    aggregateSignatures(sigs: Uint8Array[], sessionKey: object): Uint8Array;
}


/*
 *  chunkHelper — chunked DEPLOY utilities
 *
 *  planDeploy() decides single-shot vs chunked and produces deterministic
 *  base64 slices + SHA-256 hash for the DEPLOY v4 carrier / v2/v3 assembler flow.
 */

export interface DeployPlanSingle {
    codeHash: string;
    single: true;
    parts: null;
    totalChunks: 0;
}

export interface DeployPlanChunked {
    codeHash: string;
    single: false;
    /** Ordered base64 slices — submit each as a DEPLOY v4 carrier action */
    parts: string[];
    totalChunks: number;
}

export type DeployPlan = DeployPlanSingle | DeployPlanChunked;

export interface DeployPlanOpts {
    gasLimit?: number | string;
    constructorParams?: string | string[];
}

export declare const chunkHelper: {
    /** SHA-256 hex of the UTF-8 source (matches the indexer's codeHash) */
    codeHashOf(code: string): string;
    /** True when base64(code) fits a single inline DEPLOY action (< 8192-byte cap) */
    fitsSingleDeploy(code: string, opts?: DeployPlanOpts): boolean;
    /** Split base64(code) into ordered slices each ≤ 7800 bytes */
    splitCode(code: string): string[];
    /**
     * Plan a deploy: single-shot or chunked.
     * @throws Error if the code needs more than MAX_DEPLOY_CHUNKS (16) slices.
     */
    planDeploy(code: string, opts?: DeployPlanOpts): DeployPlan;
    /** Maximum total action-data length (8192 bytes) */
    readonly MAX_ACTION_DATA_LENGTH: number;
    /** Maximum bytes per DEPLOYCHUNK part (7800 bytes) */
    readonly MAX_DEPLOYCHUNK_PART_BYTES: number;
    /** Maximum number of chunk carrier actions (16) */
    readonly MAX_DEPLOY_CHUNKS: number;
};


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
    /** Get the contract's declared permissions manifest (programmable policy layer) */
    getManifest(): Promise<ContractManifest>;
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

    /**
     * Submit an action through the full lifecycle: create → encode → sign → broadcast → wait.
     * Handles P2SH two-phase encoding automatically.
     */
    submitAction(actionData: { action: string; params: ActionParams }, encoderOpts: Partial<EncoderOptions>, opts: SubmitActionOpts): Promise<SubmitActionResult>;

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

    // Staking action convenience methods (BTC-only)
    stake(params: StakeParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    unstake(params: UnstakeParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    delegate(params: DelegateParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    revokeDelegation(params: RevokeDelegationParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    claimRewards(params?: ClaimRewardsParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;

    // VM action convenience methods
    deploy(params: DeployParams | ActionParams, encoder?: EncoderOptions, opts?: DeployLintOptions): Promise<ActionResult>;
    execute(params: ExecuteParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    deposit(params: DepositParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;
    withdraw(params: WithdrawParams | ActionParams, encoder?: EncoderOptions): Promise<ActionResult>;

    // Contract authoring (synchronous, browser-safe, no network)
    /**
     * Pre-flight lint of raw contract source. Advisory — runs every acorn-coverable
     * deploy rule; the isolated-vm V8 syntax compile runs only at deploy/CLI, so
     * `authoritative` is always false.
     */
    validateContract(code: string): ContractValidationResult;
    /** Return the source of a contract template or pattern by name (throws if unknown). */
    scaffold(name: string): string;
    /** List the scaffoldable template and pattern names. */
    listTemplates(): ContractTemplateList;

    /** Create a bound wallet session for repeated actions from one address */
    session(wif: string, opts?: WalletSessionOpts): WalletSession;

    /**
     * Create a policy-enforced agent session — a WalletSession with a
     * declarative spending policy (fail-closed). Ideal for handing a key
     * to an automated agent with a bounded blast radius.
     */
    agentSession(wif: string, policy: AgentSessionPolicy, opts?: WalletSessionOpts): AgentSession;

    /** Create a new `BatchBuilder` for fluent BATCH construction. */
    batch(): BatchBuilder;

    /** Contract authoring utilities (base64 encoding, validation, gas estimation) */
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

    /** Estimate fees for an action without signing or broadcasting */
    estimateFees(actionData: { action: string; params: ActionParams }, encoderOpts?: Partial<EncoderOptions>): Promise<EstimateFeeResult>;

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

    /** Get a project tick's current official-token roster (spec: protocol/Project_Registry.md). */
    getProject(tick: string): Promise<any>;

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
    getDispenserCancels(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDispenserCloses(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDispenserExpires(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDispenserEdits(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getDividends(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getFees(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getFiles(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getLinks(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getLists(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getMessages(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getMints(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getOrders(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getOrderCancels(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getOrderEdits(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getOrderExpires(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getOrderMatches(query?: string, type?: string, opts?: QueryOptions): Promise<any>;
    getSends(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSleeps(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSwaps(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSwapCancels(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSwapEdits(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSwapExpires(query: string, type: string, opts?: QueryOptions): Promise<any>;
    getSweeps(query: string, type: string, opts?: QueryOptions): Promise<any>;


    /*
     *  Explorer: Contract / VM methods
     */

    /** Get contract metadata by its deploy ACTION_INDEX */
    getContract(contractActionIndex: number | string): Promise<ContractInfo>;

    /** Read a contract's declared permissions manifest, normalized to camelCase (programmable policy layer) */
    getContractManifest(contractActionIndex: number | string): Promise<ContractManifest>;

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
     *  Explorer: Price methods
     */

    /** Get price records (PRICE v0 COIN/FIAT snapshots + v1 TOKEN/FIAT oracle). */
    getPrices(query?: string, type?: string, opts?: QueryOptions): Promise<any>;

    /** Get oracle price-snapshot rounds. */
    getPriceSnapshots(query?: string, type?: string, opts?: QueryOptions): Promise<any>;


    /*
     *  Explorer: Utility methods
     */

    /**
     * Get explorer service status and indexer sync position.
     *
     * Resolves to an object with `supported` and `available` coin maps plus
     * `last_block` and `last_block_time` — per-coin maps (keyed by ticker) of
     * the highest block index processed by the indexer and its block_time.
     *
     * Also includes `decoder_tip` and `decoder_lag_blocks` per-coin maps:
     * `decoder_tip` is the decoder's highest *processed* block and
     * `decoder_lag_blocks` is `decoder_tip - last_block` (>= 0), so a stalled
     * indexer is detectable from this single call. These measure the
     * indexer→decoder slice only — NOT the coin node's chain tip; the explorer
     * never talks to a coin node, so the chain→decoder gap is exposed by the
     * decoder's own `health()` RPC, not here. Both are `null` for a coin when the
     * decoder tip is unavailable.
     */
    getStatus(): Promise<any>;

    /** Get unconfirmed mempool actions filtered by query and type (address | token). */
    getMempool(query: string, type: string, opts?: QueryOptions): Promise<any>;

    /** Get a network-wide summary (chain heights, indexer status, peer counts). */
    getNetwork(opts?: QueryOptions): Promise<any>;

    /** Search the explorer for a query string of a given type. */
    search(query: string, type: string): Promise<any>;


    /*
     *  WebSocket: Wait-for-Action methods
     */

    /** Wait for a transaction to be indexed by the explorer */
    waitForAction(txid: string, opts?: WaitForActionOpts): Promise<any>;

    /** Wait for a specific action_index to appear in the explorer */
    waitForActionIndex(actionIndex: number | string, opts?: WaitForActionOpts): Promise<any>;


    /*
     *  WebSocket: Real-Time Subscription methods
     *
     *  Each on*() registers a handler and subscribes the relevant explorer
     *  channel, returning an unsubscribe function. The callback receives the
     *  raw WS message envelope `{ type, data, chain, network, timestamp,
     *  catch_up? }`. Requires the WS client to be configured (network +
     *  websocketUrl/explorerUrl, or hub discovery) and connected.
     */

    /** Connect the WebSocket client (auto-called by init() when configured). */
    connectWs(): Promise<any>;

    /** Disconnect the WebSocket client. */
    disconnectWs(): void;

    /** Subscribe to new blocks. Returns an unsubscribe function. */
    onBlock(callback: (msg: any) => void): () => void;

    /** Subscribe to new actions with optional type/status/tick filters. */
    onAction(callback: (msg: any) => void, opts?: { types?: string[]; statuses?: string[]; ticks?: string[] }): () => void;

    /** Subscribe to all events touching an address (NEW_ACTION, ADDRESS_UPDATE, ORDER_MATCH, COINPAY_*, SWAP_MATCH, DISPENSE). */
    onAddress(address: string, callback: (msg: any) => void, opts?: { types?: string[]; statuses?: string[]; snapshot?: boolean }): () => void;

    /** Subscribe to updates for a token. */
    onToken(tick: string, callback: (msg: any) => void): () => void;

    /** Subscribe to updates for a market pair. */
    onMarket(tick1: string, tick2: string, callback: (msg: any) => void): () => void;

    /** Subscribe to updates for a dispenser (by its action index). */
    onDispenser(actionIndex: number | string, callback: (msg: any) => void): () => void;

    /** Subscribe to COINPAY_REQUIRED events on an address. */
    onCoinpayRequired(address: string, callback: (msg: any) => void): () => void;

    /** Subscribe to ORDER_MATCH events on an address. */
    onOrderMatch(address: string, callback: (msg: any) => void, opts?: { statuses?: string[] }): () => void;

    /** Subscribe to network-statistics updates. */
    onNetworkStats(callback: (msg: any) => void): () => void;


    /*
     *  Workflow recipes
     */

    /** Issue a token and distribute to recipients in one flow */
    issueAndDistribute(wif: string, issueParams: IssueParams | ActionParams, distributions: Array<{ destination: string; amount: string | number; memo?: string }>, opts?: Partial<SubmitActionOpts>): Promise<{ issue: SubmitActionResult; sends: SubmitActionResult[] }>;

    /** Issue a token and mint initial supply */
    issueAndMint(wif: string, issueParams: IssueParams | ActionParams, mintParams: Partial<MintParams> | ActionParams, opts?: Partial<SubmitActionOpts>): Promise<{ issue: SubmitActionResult; mint: SubmitActionResult }>;

    /** Create a dispenser */
    createDispenser(wif: string, dispenserParams: DispenserParams | ActionParams, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Create a limit order on the DEX */
    createOrder(wif: string, orderParams: OrderParams | ActionParams, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Cancel an existing order */
    cancelOrder(wif: string, orderActionIndex: number, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Stake and optionally delegate a signing key */
    stakeAndDelegate(wif: string, stakeParams: StakeParams | ActionParams, delegateParams?: DelegateParams | ActionParams, opts?: Partial<SubmitActionOpts>): Promise<{ stake: SubmitActionResult; delegate: SubmitActionResult | null }>;

    /** Deploy a contract and optionally deposit initial tokens */
    deployAndFund(wif: string, deployParams: DeployParams | ActionParams, deposits?: Array<{ tick: string; quantity: string | number }>, opts?: Partial<SubmitActionOpts>): Promise<{ deploy: SubmitActionResult; deposits: SubmitActionResult[] }>;

    /** Distribute a dividend to all holders of a token */
    distributeDividend(wif: string, dividendParams: DividendParams | ActionParams, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Pure NFT param builders + classifier (no network). Spec: protocol/NFT_Standard.md */
    readonly nft: NftHelpers;

    /** Issue a unique 1-of-1 NFT, fully minted to the issuer */
    issueNft(wif: string, params: NftUniqueParams, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Issue an edition of N identical indivisible prints (pass `mint` for a fair-mint window) */
    issueNftEdition(wif: string, params: NftEditionParams, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Issue a distinct collection item — a child TICK `parent.name` as a 1-of-1 */
    issueCollectionItem(wif: string, params: NftCollectionItemParams, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Attach content to a token: upload a FILE then LINK it (owner-validated by the indexer) */
    attachContent(wif: string, params: NftAttachContentOpts, opts?: Partial<SubmitActionOpts>): Promise<{ file: SubmitActionResult; link: SubmitActionResult }>;

    /** Pure project-registry param builders (no network). Spec: protocol/Project_Registry.md */
    readonly project: ProjectHelpers;

    /** Publish (or replace) a project's official-token roster: LIST then owner-validated LINK */
    setRoster(wif: string, params: ProjectSetRosterOpts, opts?: Partial<SubmitActionOpts>): Promise<{ list: SubmitActionResult; link: SubmitActionResult }>;

    /** Pure controller (programmable-policy) param builders (no network). Spec: protocol/Controller_Bound_Tokens.md */
    readonly controller: ControllerHelpers;

    /**
     * AES-256-GCM encryption / key-handoff utilities for FILE v1 token-gated content.
     * Spec: protocol/TOKEN_GATED_CONTENT.md
     */
    readonly gatedFile: GatedFileUtils;


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
export declare class SDKMessagingError extends SDKError {}
export declare class SDKActionError extends SDKError {}
export declare class SDKMuSigError extends SDKError {}
// Internal: thrown by GatedFileUtils but not re-exported from index.js — declared (not exported) for @throws references.
declare class SDKGatedFileError extends SDKError {}
export declare class SDKPolicyError extends SDKError {}
export declare class SDKX402Error extends SDKError {}


/*
 *  Staking action parameter interfaces (BTC-only)
 */

export interface StakeParams extends ActionParams {
    /** Validation tier: 1 (oracle) or 2 (cross-chain) */
    tier: 1 | 2;
    /** Ed25519 signing public key (64 hex characters) */
    signingPubkey: string;
    /** Comma-separated chain identifiers (required for tier 2, empty for tier 1) */
    chains?: string;
}

export interface UnstakeParams extends ActionParams {
    /** Tier to unstake from: 1 (oracle) or 2 (cross-chain) */
    tier: 1 | 2;
}

export interface DelegateParams extends ActionParams {
    /** New Ed25519 signing public key (64 hex characters) */
    newSigningPubkey: string;
}

export interface RevokeDelegationParams extends ActionParams {
    /** Ed25519 signing public key to revoke (64 hex characters) */
    signingPubkey: string;
}

export interface ClaimRewardsParams extends ActionParams {}


/*
 *  Transaction Lifecycle types
 */

export interface SubmitActionOpts {
    /** WIF private key for signing (required) */
    wif: string;
    /** Wait for indexer confirmation (default: true) */
    waitForIndexer?: boolean;
    /** Timeout in ms for indexer confirmation (default: 120000) */
    timeout?: number;
    /** Polling interval in ms (default: 2000) */
    pollInterval?: number;
    /** Reject if action status is 'invalid' (default: true) */
    requireValid?: boolean;
    /** Progress callback: called at each lifecycle step */
    onProgress?: (step: string, data: any) => void;
}

export interface SubmitActionResult {
    /** Final transaction ID (phase 2 txid for P2SH) */
    txid: string;
    /** Serialized ACTION string */
    actionString: string;
    /** ACTION name */
    action: string;
    /** Protocol version used */
    version: number;
    /** Encoding type used */
    encoding: EncodingType;
    /** Signed transaction details */
    signed: SignPsbtResult;
    /** UTXOs consumed by this transaction */
    spentInputs: Array<{ txid: string; vout: number }>;
    /** Indexed action data (null if waitForIndexer was false) */
    indexed: any | null;
}

export interface WaitForActionOpts {
    /** Timeout in ms (default: 120000) */
    timeout?: number;
    /** Polling interval in ms (default: 2000) */
    pollInterval?: number;
    /** Reject if action status is 'invalid' (default: true) */
    requireValid?: boolean;
}

export interface EstimateFeeResult {
    /** Unsigned PSBT hex (can be signed directly to skip re-encoding) */
    psbt: string;
    /** Encoding type used */
    encoding: EncodingType;
    /** Transaction fee in satoshis */
    fee: number | null;
    /** Total input value in satoshis */
    inputTotal?: number;
    /** Total output value in satoshis */
    outputTotal?: number;
    /** Serialized ACTION string */
    actionString: string;
    /** ACTION name */
    action: string;
    /** Protocol version used */
    version: number;
}


/*
 *  WalletSession class
 */

export interface WalletSessionOpts {
    /** Address derivation type (default: 'p2pkh') */
    addressType?: AddressType;
    /** Default waitForIndexer setting (default: true) */
    waitForIndexer?: boolean;
    /** Default timeout in ms (default: 120000) */
    timeout?: number;
    /** Default poll interval in ms (default: 2000) */
    pollInterval?: number;
    /** Default requireValid setting (default: true) */
    requireValid?: boolean;
}

export declare class WalletSession {
    /** The SDK instance this session is bound to */
    readonly sdk: XChainSDK;
    /** WIF private key */
    readonly wif: string;
    /** Hex-encoded public key */
    readonly pubkey: string;
    /** Derived address */
    readonly address: string;

    constructor(sdk: XChainSDK, wif: string, opts?: WalletSessionOpts);

    /** Refresh UTXOs from the UTXO tracker */
    refreshUTXOs(): Promise<any[]>;

    /** Submit any action using this session's credentials and UTXO cache */
    submit(actionData: { action: string; params: ActionParams }, encoderOpts?: Partial<EncoderOptions>, submitOpts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    // Action convenience methods
    send(params: SendParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    issue(params: IssueParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    mint(params: MintParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    destroy(params: DestroyParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    order(params: OrderParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    swap(params: SwapParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    dispenser(params: DispenserParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    dividend(params: DividendParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    broadcast(params: BroadcastParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    message(params: MessageParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    airdrop(params: AirdropParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    sweep(params: SweepParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    file(params: FileParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    list(params: ListParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    link(params: LinkParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    callback(params: CallbackParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    sleep(params: SleepParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    address(params: AddressParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    coinpay(params: ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    stake(params: StakeParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    unstake(params: UnstakeParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    delegate(params: DelegateParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    revokeDelegation(params: RevokeDelegationParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    claimRewards(params?: ClaimRewardsParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    collect(params: ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    // Contract-targeted staking (VERSION forced to prevent accidental capability-staking)
    /** STAKE V3 — stake to a specific deployed contract (forces VERSION=3) */
    stakeToContract(params: ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    /** UNSTAKE V1 — unstake from a specific deployed contract (forces VERSION=1) */
    unstakeFromContract(params: ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    /** DELEGATE V1 — rotate signing key for a specific deployed contract (forces VERSION=1) */
    delegateForContract(params: ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    deploy(params: DeployParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    /** Submit a single base64 code slice as a DEPLOY v4 carrier (chunked-deploy phase 1) */
    deployChunk(params: ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    execute(params: ExecuteParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    deposit(params: DepositParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;
    withdraw(params: WithdrawParams | ActionParams, enc?: Partial<EncoderOptions>, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    // Explorer convenience methods (scoped to session address)
    getBalances(opts?: QueryOptions): Promise<any>;
    getHistory(opts?: QueryOptions): Promise<any>;
    getCredits(type?: string, opts?: QueryOptions): Promise<any>;
    getDebits(type?: string, opts?: QueryOptions): Promise<any>;
    getSends(opts?: QueryOptions): Promise<any>;
    getOrders(opts?: QueryOptions): Promise<any>;
    getSwaps(opts?: QueryOptions): Promise<any>;
    getDispensers(opts?: QueryOptions): Promise<any>;

    /** Estimate fees for an action using this session's credentials */
    estimateFees(actionData: { action: string; params: ActionParams }, encoderOpts?: Partial<EncoderOptions>): Promise<EstimateFeeResult>;
}


/*
 *  AgentSession class — WalletSession with a declarative spending policy
 *
 *  Wraps WalletSession with a policy enforced at submit(). Fail-closed:
 *  no allowedActions means nothing is allowed. State persists across
 *  restarts (stateFile) so a crash-loop cannot reset the spending window.
 */

export interface AgentSessionMaxPerWindow {
    /** Length of the rolling window in hours (required when maxPerWindow is set) */
    hours: number;
    /** Per-tick cumulative amount caps within the window; use '*' as a catch-all key */
    perTick?: Record<string, string>;
    /** Maximum number of actions in the window */
    maxActions?: number;
}

export interface AgentSessionConfirmAbove {
    /** Per-tick threshold above which the handler must approve; use '*' as catch-all */
    perTick?: Record<string, string>;
    /** Async approval callback — return true to allow, false to deny */
    handler: (ctx: {
        action: string;
        tick?: string;
        amount?: string;
        destinations: string[];
        address: string;
        windowUsage: { count: number; perTick: Record<string, string>; hours: number | null };
    }) => Promise<boolean> | boolean;
}

export interface AgentSessionPolicy {
    /** Allowlist of ACTION names this session may submit (required; nothing allowed by default) */
    allowedActions: string[];
    /** Allowlist of destination addresses; omit to allow any destination */
    allowedDestinations?: string[];
    /** Per-action per-tick amount caps; use '*' as a catch-all tick key */
    maxPerAction?: Record<string, Record<string, string>>;
    /** Rolling-window caps across all actions */
    maxPerWindow?: AgentSessionMaxPerWindow;
    /** Require async approval for amounts above a threshold */
    confirmAbove?: AgentSessionConfirmAbove;
    /** Observer called on every policy denial (must not throw) */
    onPolicyViolation?: (violation: { code: string; message: string; address: string; [key: string]: any }) => void;
    /** Path to the usage persistence file (default: ~/.xchain/agent-usage-<address>.json) */
    stateFile?: string;
}

export declare class AgentSession extends WalletSession {
    readonly policy: {
        allowedActions: Set<string>;
        allowedDestinations: Set<string> | null;
        maxPerAction: Record<string, Record<string, string>> | null;
        maxPerWindow: AgentSessionMaxPerWindow | null;
        confirmAbove: AgentSessionConfirmAbove | null;
        onPolicyViolation: ((violation: any) => void) | null;
    };

    constructor(sdk: XChainSDK, wif: string, policy: AgentSessionPolicy, opts?: WalletSessionOpts);

    /**
     * Submit an action through the policy chokepoint.
     * Resolves with the normal SubmitActionResult plus a `policy` summary.
     * @throws SDKPolicyError if the action is denied.
     */
    submit(
        actionData: { action: string; params: ActionParams },
        encoderOpts?: Partial<EncoderOptions>,
        submitOpts?: Partial<SubmitActionOpts>
    ): Promise<SubmitActionResult & {
        policy: {
            action: string;
            tick?: string;
            amount?: string;
            confirmed?: boolean;
            windowUsage: { count: number; perTick: Record<string, string>; hours: number | null };
        };
    }>;
}


/*
 *  X402 — HTTP 402 "Payment Required" flow settled in XChain tokens
 *
 *  Three payment schemes:
 *    xchain-send       pay-per-call SEND with MEMO = invoice nonce
 *    xchain-dispenser  hold-to-access (caller holds >= minBalance of holdTick)
 *    xchain-deposit    metered: confirmed deposits fund a local spend ledger
 */

export interface X402SendSchemeOpts {
    tick: string;
    amount: string | number;
    payTo: string;
    /** 0 accepts mempool visibility (provisional); 1+ requires indexed confirmation (default: 1) */
    minConfirmations?: number;
    /** Invoice TTL in milliseconds (default: 5 minutes) */
    ttlMs?: number;
}

export interface X402DispenserSchemeOpts {
    holdTick: string;
    /** Minimum token balance the payer must hold (default: '1') */
    minBalance?: string | number;
    dispenserIndex?: number | string;
    dispenserAddress?: string | null;
}

export interface X402DepositSchemeOpts {
    tick: string;
    depositAddress: string;
    pricePerCall: string | number;
    /** Directory for the per-payer spend ledger (default: stateDir/deposits/<coin>) */
    ledgerDir?: string;
}

export interface X402GatewayOptions {
    /** Coin this gateway operates on (BTC / LTC / DOGE) */
    coin: string;
    /** An SDK ExplorerClient (or compatible) for verifying on-chain payments */
    explorer: any;
    /** xchain-send pay-per-call scheme config */
    send?: X402SendSchemeOpts;
    /** xchain-dispenser hold-to-access scheme config */
    dispenser?: X402DispenserSchemeOpts;
    /** xchain-deposit metered-access scheme config */
    deposit?: X402DepositSchemeOpts;
    /** External invoice store (for multi-node deployments); omit for file-backed single-node */
    invoiceStore?: any;
    /** Root directory for the file-backed state (invoices + ledgers) (default: '.x402') */
    stateDir?: string;
    /** Window (ms) in which a 0-conf grant must reach a confirmed block (default: 10 min) */
    confirmWindowMs?: number;
    /** Grace period (ms) after invoice expiry for in-flight payments (default: 10s) */
    expiryGraceMs?: number;
    /** Called when a provisional 0-conf grant fails to confirm within confirmWindowMs */
    onProvisionalFailed?: ((invoice: any) => void) | null;
    /** Human-readable description for 402 challenge bodies (default: 'Payment required') */
    description?: string;
}

export interface X402VerifyResult {
    ok: boolean;
    /** Populated on success: confirmed | provisional_0conf | dispenser_verified | deposit_debited */
    status?: string;
    provisional?: boolean;
    txid?: string;
    blockIndex?: number;
    /** Remaining deposit balance (deposit scheme only) */
    remaining?: string;
    /** Populated on failure */
    code?: string;
}

export interface X402ChallengeBody {
    x402Version: number;
    error: string;
    resource: string | null;
    accepts: any[];
    reason?: string;
}

export declare class X402Gateway {
    readonly coin: string;
    readonly explorer: any;

    constructor(options: X402GatewayOptions);

    /** Build a 402 challenge body for the given resource URL */
    challengeBody(resource?: string): Promise<X402ChallengeBody>;

    /** Parse the base64url-encoded X-Payment header into a proof object (returns null if invalid) */
    static parseProofHeader(header: string): any | null;

    /** Verify a payment proof. Returns { ok, status, txid, ... } */
    verify(proof: any, resource?: string): Promise<X402VerifyResult>;

    /** Build the base64url-encoded X-Payment-Response header value */
    static buildResponseHeader(result: X402VerifyResult): string;

    /** Return an Express-style middleware that enforces payment before calling next() */
    middleware(): (req: any, res: any, next: () => void) => Promise<void>;

    /**
     * Low-level guard: verify payment on req, write 402 on failure.
     * Returns true if paid (req.x402 is set); false if the response was already sent.
     */
    guard(req: any, res: any): Promise<boolean>;

    /** Re-check provisional 0-conf grants; promote on confirmation or mark failed */
    sweep(): Promise<void>;

    /** Start the background sweeper on the given interval (default: 30s) */
    startSweeper(intervalMs?: number): void;

    /** Stop the background sweeper */
    stopSweeper(): void;
}

export interface X402ClientOptions {
    /** Paying WalletSession or AgentSession */
    session: WalletSession | AgentSession;
    /** Fetch implementation (default: global fetch) */
    fetch?: typeof fetch;
    /** Maximum token amount the client will auto-pay without throwing (decimal string) */
    maxAmount?: string | number | null;
    /** Delay between retry attempts in ms (default: 1500) */
    retryDelayMs?: number;
    /** Maximum number of payment-verification retry attempts (default: 40) */
    maxRetries?: number;
}

export declare class X402Client {
    readonly session: WalletSession | AgentSession;

    constructor(options: X402ClientOptions);

    /**
     * Fetch a URL, handling HTTP 402 automatically:
     * pays with the bound session and retries until the gateway accepts.
     * @throws SDKX402Error on no usable scheme, price too high, or max retries exceeded.
     */
    fetchUrl(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Parse a decoded XChain action string into structured fields.
 * Returns null for malformed input. For SEND, returns per-output tuples
 * with amount/destination/memo correctly paired (multi-output v1–v3 safe).
 */
export function x402ParseActionString(text: string): {
    action: string;
    version: string;
    outputs: Array<{ tick: string; amount: string; destination: string; memo: string }>;
} | null;


/*
 *  CrossChainHelper class
 */

export interface CrossChainSwapParams {
    giveCoin: string;
    giveTick: string;
    giveAmount: string | number;
    getCoin: string;
    getTick: string;
    getAmount: string | number;
    wif: string;
    getAddress?: string;
    expiration?: number;
    allowList?: number;
    blockList?: number;
    memo?: string;
}

export interface CrossChainLinkParams {
    coin1: string;
    coin1ActionIndex: number;
    coin2: string;
    coin2ActionIndex: number;
    wif: string;
    submitOn?: string;
    memo?: string;
}

export interface CrossChainAction {
    chain: string;
    wif: string;
    actionData: { action: string; params: ActionParams };
    encoderOpts?: Partial<EncoderOptions>;
    submitOpts?: Partial<SubmitActionOpts>;
}

export declare class CrossChainHelper {
    constructor(sdkMap: Record<string, XChainSDK>);

    /** Create a swap offer on the give chain */
    createSwap(params: CrossChainSwapParams, opts?: Partial<SubmitActionOpts>): Promise<{ swap: SubmitActionResult }>;

    /** Create a LINK between actions on two chains */
    link(params: CrossChainLinkParams, opts?: Partial<SubmitActionOpts>): Promise<SubmitActionResult>;

    /** Execute actions on multiple chains in parallel */
    parallel(actions: CrossChainAction[]): Promise<SubmitActionResult[]>;

    /** Wait for actions on multiple chains simultaneously */
    waitForAll(waits: Array<{ chain: string; txid: string }>, opts?: WaitForActionOpts): Promise<any[]>;

    /** Get balances across all configured chains */
    getAllBalances(address: string, opts?: QueryOptions): Promise<Record<string, any>>;
}


/*
 *  UTXOCache class
 */

export declare class UTXOCache {
    constructor();

    /** Load/refresh UTXOs from the encoder's UTXO tracker */
    refresh(address: string, encoder: any): Promise<any[]>;

    /** Get available UTXOs (confirmed + speculative, minus spent) */
    getAvailable(): UTXO[];

    /** Mark UTXOs as spent */
    markSpent(inputs: Array<{ txid: string; vout: number }>): void;

    /** Add a speculative change UTXO */
    addSpeculative(utxo: UTXO): void;

    /** Check if cache has been loaded */
    isLoaded(): boolean;

    /** Check if there are available UTXOs */
    hasAvailable(): boolean;

    /** Full invalidation */
    invalidate(): void;

    /** The address this cache is tracking */
    readonly address: string | null;
}


/*
 *  REPL
 */

/** Start an interactive REPL with a pre-configured SDK instance */
export function startREPL(options?: SDKOptions): Promise<any>;


/*
 *  Module exports (CommonJS interop)
 */

export {
    XChainSDK,
    BatchBuilder,
    ContractClient,
    ContractUtils,
    NftHelpers,
    ProjectHelpers,
    ControllerHelpers,
    AttestationHelpers,
    MuSig2,
    chunkHelper,
    WalletUtils,
    WalletSession,
    AgentSession,
    X402Gateway,
    X402Client,
    x402ParseActionString,
    AuthUtils,
    CrossChainHelper,
    UTXOCache,
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
};
export default XChainSDK;
