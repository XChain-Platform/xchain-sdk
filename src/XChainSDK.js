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
 * XChain SDK - XChainSDK (Software Development Kit)
 * 
 * This file handles parsing XChain SDK requests
 * 
 ********************************************************************/

// Load required libraries
const config  = require('./config.js');
const actions = require('./actions.js');
const utility = require('./utility.js');

class XChainSDK {

    // Handle constructing a class instance
    constructor(){

        // XChain SDK Version
        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;

    }

    // Handle starting up the SDK
    async start(){
        console.log('Starting up ' + this.name + ' v' + this.version + '...');

        // Get SDK configuration
        this.config = config.getConfig();

        // Create some class instances
        this.util    = new utility();
        this.actions = new actions(this);

        let request = {
            action: 'broadcast',
            params: {
                message: 'test message',
                value: '1234678.12345678',
                memo: 'memo goes here'
            },
            // encoder specific params
            encoder: {
                fee: 1000,              // Fixed fee in satoshis
                encoding: 'op_return',  // Encoding Type
                dust: 1000,             // Dust amount to use
                unconfirmed: true,      // Use Unconfirmed UTXOs
                rbf: true               // Enable Replace-By-Fee

            }
        }

        let tx = this.actions.createAction(request);

        console.log('tx=',tx);
        // let fields  = this.util.getActionFormatFieldList('issue',0);
        // console.log('fields=',fields);

        while (true){

            // Bail out if stop is requested
            if(this.stopFlag)
                break;

            // Sleep for a few seconds between STOP checks
            await this.util.sleep(this.config['STOP_CHECK_INTERVAL']);

        }

    }
}

module.exports = XChainSDK;