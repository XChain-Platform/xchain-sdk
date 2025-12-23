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
 * XChain SDK - API
 * 
 * This file parses in environmental variables and starts up the parsing API
 * 
 ********************************************************************/

// Load required libraries
const dotenv        = require('dotenv');
const express       = require('express');
const bodyParser    = require('body-parser');
const helmet        = require('helmet');
const cors          = require('cors');
const XChainSDK     = require('./XChainSDK');
const jsonRouter    = require('express-json-rpc-router');

// Parse in .env config data
dotenv.config();

// Parse in the environmental variables
const SDK_API_PORT = process.env.SDK_API_PORT;

// Start up the API
async function startApi(){

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS for development
    app.use(cors());

    const jsonRpcController = {

        // Handle returning a success response to ping requests
        async ping(){
            return { status: "success" };
        }

    };

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}));

    // Start the server
    app.listen(SDK_API_PORT, () => {
      console.log('SDK API listening on port ' + SDK_API_PORT);
    });

    // Start the SDK
    const sdk = new XChainSDK();
    sdk.start();

}

startApi();