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
 * XChain SDK - Actions ckass
 * 
 * This file handles generating action strings 
 * 
 ********************************************************************/


class Actions {

    // Handle constructing a class instance
    constructor(sdk){
        // Setup short aliases
        this.config  = sdk.config;
        this.util    = sdk.util;

        // Get a list of valid actions using actions defined in formats.js
        this.actions = this.util.getActions();

    }

    // Handle processing an action request
    createAction(data){
        // Standardize the request fields
        // data = this.normalizeRequestData(data);
        // let error = false;
        // // Verify ACTION is given 
        // if(this.util.isNull(req.action))
        //     error = 'Missing required Field : ACTION';

        // // let action = (!this.util.isNull(req.action)) ? req.action : null;
        // // if(this.actions.includes(action)){

        // // }

        console.log('request=',data);
    }

}

module.exports = Actions;