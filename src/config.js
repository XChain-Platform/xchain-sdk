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
            // on the wire (deep-review 2026-07-17 F11 / ).
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
            // test/unit/wire-number-canonical.test.js: without it a market with a
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
        config['LOCK_FIELDS'] = [
            'LOCK_MAX_SUPPLY',
            'LOCK_MINT',
            'LOCK_MINT_SUPPLY',
            'LOCK_MAX_MINT',
            'LOCK_DESCRIPTION',
            'LOCK_SLEEP',
            'LOCK_CALLBACK'
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

}

module.exports = Config;
