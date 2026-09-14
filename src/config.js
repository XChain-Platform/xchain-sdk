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
 * XChain Platform SDK - Configuration
 *
 ********************************************************************/

// Parse a non-negative integer from an env var, falling back to defaultVal when
// the value is absent, empty, or non-numeric. Preserves 0 as a valid value.
const parseIntMin0 = (val, defaultVal) => {
    if(val === undefined || val === null || val === '') return defaultVal;
    let parsed = parseInt(val, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultVal;
};

var Config = {

    // Handle returning the current sdk configuration
    getConfig: function(){

        // Define SDK config object
        let config = {};

        // Define list of NUMBER fields
        config['NUMBER_FIELDS'] = [
            'ALLOW_LIST',
            'AMOUNT',
            'BALANCES',
            'BLOCK_LIST',
            'BROADCAST_ACTION_INDEX',
            'CALLBACK_AMOUNT',
            'CALLBACK_BLOCK',
            'COIN1_ACTION_INDEX',
            'CONTRACT_ACTION_INDEX',
            'CONTROLLER',
            'COIN2_ACTION_INDEX',
            'COOLDOWN_BLOCKS',
            'DECIMALS',
            // DEPOSIT / GAS_ESCROW are the VOTE v0 poll-creator XCHAIN escrow
            // amounts; without canonicalization String(0.00000001) puts "1e-8"
            // on the wire.
            'DEPOSIT',
            'DISPENSER_ACTION_INDEX',
            'EDIT',
            'ENCRYPTION_METHOD',
            'EXPIRATION',
            'FEE',
            // FIAT_AMOUNT is deliberately NOT a NUMBER_FIELD: it is a fixed-
            // display fiat price, and setNumberFormats' bignumber round-trip
            // (notation 'fixed', no precision) strips trailing zeros
            // ("10.00" -> "10", "1.50" -> "1.5"), destroying the X.XX display
            // form the merchant supplied. The validator enforces the indexer-
            // parity rule (<= 2 decimals) on the untouched value instead.
            'GET_AMOUNT',
            'GAS_ESCROW',
            'GAS_LIMIT',
            'GIVE_AMOUNT',
            'GIVE_ESCROW',
            'LIST_ACTION_INDEX',
            'MAX_SUPPLY',
            'MAX_MINT',
            // BET MIN_AMOUNT is an amount-class field at the wager tick's
            // DECIMALS, so it falls under the wire-canonicalization contract in
            // test/unit/wire_number_canonical.test.js: without it a market with a
            // 0.00000001 minimum would put "1e-8" on the chain. The other BET
            // numerics (FEED_ACTION_INDEX, OUTCOME, DEADLINE, REFUND_WINDOW) are
            // small integers that String() never renders scientifically, so they
            // are deliberately left out rather than added for symmetry.
            // LOCKSTEP: xchain-indexer src/config.js NUMBER_FIELDS needs the same
            // entry when P4 lands, or a non-SDK client's "1e-8" is stored verbatim.
            'MIN_AMOUNT',
            'MINT_ADDRESS_MAX',
            'MINT_START_BLOCK',
            'MINT_STOP_BLOCK',
            'MINT_SUPPLY',
            'ORDER_ACTION_INDEX',
            'OWNERSHIPS',
            'QUANTITY',
            'RESUME_BLOCK',
            'SWAP_ACTION_INDEX',
            'TIER',
            'TRANSFER_SUPPLY',
            'TYPE',
            'UNBIND',
            'VALUE',
        ];

        // Define list of LOCK fields
        //
        // Mirrors xchain-indexer/src/actions/issue.js fieldList['LOCK'], which is what
        // gives every name here the whole lock discipline on chain (0/1 format, and a
        // set lock can never be unset). LOCK_BRIDGE is the ISSUE v7 bridge opt-in's
        // freeze over BRIDGE_CHAINS and MIN_DEPTH; without it in this list the SDK's
        // one LOCK_FIELDS consumer (validator.js) let a LOCK_BRIDGE=2 through to a
        // paid-for action the indexer then refuses.
        config['LOCK_FIELDS'] = [
            'LOCK_MAX_SUPPLY',
            'LOCK_MINT',
            'LOCK_MINT_SUPPLY',
            'LOCK_MAX_MINT',
            'LOCK_DESCRIPTION',
            'LOCK_SLEEP',
            'LOCK_CALLBACK',
            'LOCK_BRIDGE'
        ];

        // Define list of LIST fields
        config['LIST_FIELDS'] = [
            'ALLOW_LIST',
            'BLOCK_LIST'
        ];

        // Programmable policy layer: the controller action classes a token (ISSUE v6) or
        // account (ADDRESS v1) may BIND. The only field this list validates is
        // ACTION_CLASS, which exists on those two formats and nowhere else, so the
        // set it must mirror is the indexer's CONTROLLER_BINDABLE_CLASSES - NOT
        // CONTROLLER_ACTION_CLASSES, which is the narrower ROUTING set (what an
        // incoming action is mapped to). The two differ by `all`, and pinning to the
        // routing set made every `all` bind unrepresentable through this SDK.
        // `ownership` was in neither copy here: it gates a token's ownership deed-over
        // (SWEEP OWNERSHIPS=1 routes to it), which is the class an issuer uses to make
        // ownership non-sweepable to an unapproved destination.
        // xchain-indexer/src/config.js is the authority; anything it accepts on a bind
        // and this list refuses is a client-side dead end, not a protocol rule.
        config['ACTION_CLASSES'] = [
            'transfer',
            'trade',
            'burn',
            'mint',
            'stake',
            'ownership',
            'all'
        ];

        // Define stop check interval (default 5 seconds; override via STOP_CHECK_INTERVAL)
        config['STOP_CHECK_INTERVAL'] = parseIntMin0(process.env.STOP_CHECK_INTERVAL, 5000);

        return config;
    },

    // Environment readers, one per variable the SDK consults outside this file.
    //
    // Each one reads process.env at the moment it is CALLED, never at require
    // time, so a caller that sets a variable after loading the SDK sees exactly
    // what it saw before these existed. None of them supplies a default or
    // coerces a value: every call site keeps its own fallback and its own
    // parsing, because moving a default here would change what an unset
    // variable means rather than only where it is read.
    env: {
        // Which network (for example bitcoin-regtest) to use when the caller
        // did not pass one.
        network:        () => process.env.NETWORK,

        // Service endpoints, used only when the caller passed no url or port.
        hubApiHost:     () => process.env.HUB_API_HOST,
        hubPort:        () => process.env.HUB_PORT,
        explorerUrl:    () => process.env.EXPLORER_URL,
        explorerPort:   () => process.env.EXPLORER_PORT,
        encoderUrl:     () => process.env.ENCODER_URL,
        encoderPort:    () => process.env.ENCODER_PORT,
        websocketUrl:   () => process.env.WEBSOCKET_URL,
        websocketPort:  () => process.env.WEBSOCKET_PORT,

        // Which origins the helper API answers cross-origin requests from.
        corsOrigin:     () => process.env.CORS_ORIGIN,

        // The helper API's listening port, its key, and the raw limiter
        // setting that api.js checks for a malformed value before warning.
        sdkApiPort:      () => process.env.SDK_API_PORT,
        sdkApiKey:       () => process.env.SDK_API_KEY,
        sdkApiRateLimit: () => process.env.SDK_API_RATE_LIMIT,

        // Set by npm while one of its scripts runs; absent when the SDK is
        // simply required as a library.
        packageName:    () => process.env.npm_package_name,
        packageVersion: () => process.env.npm_package_version,

        // The two service API keys are read from clients that are also bundled
        // for browsers, where there may be no process object at all. Check for
        // it before reading, so a browser build gets "not set" instead of a
        // crash, exactly as the guard at the old call sites did.
        encoderApiKey:  () => (typeof process !== 'undefined' && process.env ? process.env.ENCODER_API_KEY : undefined),
        hubApiKey:      () => (typeof process !== 'undefined' && process.env ? process.env.HUB_API_KEY : undefined),
    },

}

module.exports = Config;
