/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
            'DISPENSER_ACTION_INDEX',
            'EDIT',
            'ENCRYPTION_METHOD',
            'EXPIRATION', 
            'FEE',
            'FIAT_AMOUNT', 
            'GET_AMOUNT', 
            'GAS_LIMIT',
            'GIVE_AMOUNT',
            'GIVE_ESCROW',
            'LIST_ACTION_INDEX',
            'MAX_SUPPLY', 
            'MAX_MINT', 
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

        // Programmable policy layer — the controller action classes a token (ISSUE v6) or
        // account (ADDRESS v1) may bind. MUST stay in lockstep with the indexer's
        // config CONTROLLER_ACTION_CLASSES (a cross-service regression pins it).
        config['ACTION_CLASSES'] = [
            'transfer',
            'trade',
            'burn',
            'mint',
            'stake'
        ];

        // Define stop check interval (default 5 seconds; override via STOP_CHECK_INTERVAL)
        config['STOP_CHECK_INTERVAL'] = parseIntMin0(process.env.STOP_CHECK_INTERVAL, 5000);

        // TODO: coming soon...
        return config;
    },

}

module.exports = Config;