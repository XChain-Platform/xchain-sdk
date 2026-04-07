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
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Platform SDK - Configuration
 * 
 ********************************************************************/

Config = {

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
            'COIN2_ACTION_INDEX',
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

        // Define stop check interval (5 seconds)
        config['STOP_CHECK_INTERVAL'] = 5000;

        // TODO: coming soon...
        return config;
    },

}

module.exports = Config;