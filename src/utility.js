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
 * XChain SDK - Utility Class
 * 
 * This file provides utility functions used throughout the SDK
 *
 ********************************************************************/

// Load required libraries
const config  = require('./config.js');
const formats = require('./formats.js');
const mathjs  = require('mathjs');

// Support BigInt in JSON stringify()
BigInt.prototype.toJSON = function(){
    return JSON.rawJSON(this.toString());
};

class Utility {

    // Handle constructing a class instance
    constructor(){
        // Setup placeholders to keep track of addresses/tickers/transactions 
        this.addresses = {}; // this.addresses[address] = [tick, tick, tick];
        this.tickers   = [];

        // Get indexer configuration
        this.config = config.getConfig();
    }

    /*
     *  List management functions
     */

    // Reset the addresses list
    resetAddressesList(){
        this.addresses = {};
    }

    // Reset the tickers list
    resetTickersList(){
        this.tickers = [];
    }

    // Reset all the lists
    resetLists(){
        this.resetAddressesList();
        this.resetTickersList();
    }

    // Return list of addresses
    // FORMAT : address = [tick, tick, tick]
    getAddressesList(){
        return this.addresses;
    }

    // Return list of tickers
    getTickersList(){
        return this.tickers;
    }

    /* 
     * General utility functions
     */

    // Handle sleeping for a given number of milliseconds
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Throw an error and log to console
    throwError(error){
        console.error('throwError: ' + error);
        throw new Error(error);
    }

    // Log an error to the error.log file
    logError(error, info){
        // let file  = '/XChainIndexer/error.log';
        // fs.appendFileSync(file, error);
        console.error('logError: ' + error, info);
        // DEBUG: Throw exception on any error
        this.throwError(error);
    }

    // Start a debug timer
    startTimer(){
        let now = Date.now();
        return now;
    }

    // get a timer using a given name
    getTimer(timer){
        let now = Date.now();
        let ms  = now - timer;
        let timeString = this.millisecondsToTimeString(ms);
        let niceString = ms + 'ms';
        if(timeString!='')
            niceString = timeString;
        return niceString;
    }

    // Log a timer using a given name (timeName : (timeString))
    logTimer(timer, timeName){
        var timeString = this.getTimer(timer);
        var niceString = (timeName!=null) ? timeName : 'Time';
        if(timeString!='')
            niceString += '\t: (' + timeString + ')';
        console.log(niceString);
    }

    // Create nice human readable time string based on miliiseconds
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        // Display time in XX format
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        // Build out time string to nicely display time
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    }

    // Determine if a value is numeric
    isNumeric(value){
        return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
    }

    // Determine if value is floating point
    isFloat(value){
        return value === +value && value !== (value|0);
    }

    // Determine if value is integer
    isInteger(value){
        return value === +value && value === (value|0);
    }

    // Determine if value is null or undefined or empty
    isNull(value){
        return (value === null || value === undefined || value==='');
    }

    // Handle converting a string number to an integer or float
    bcnum(num){
        if(String(num).indexOf('.')!=-1)
            return parseFloat(num);
        else
            return parseInt(num);
    }

    // Handle returning a number to a given decimal point precision
    bcformat(num, decimals){
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(this.bcnum(num),{notation: 'fixed', precision: d});
    }

    // Handle subtracting 2 big numbers
    bcsub(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle adding 2 big numbers
    bcadd(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle multiplying 2 big numbers
    bcmul(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.multiply(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle dividing 2 big numbers
    bcdiv(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Validate if a given value is considered valid
    // @value = string or integer
    // @valid = string or array of values
    isValidValue(value, valid){
        let valueType = typeof value,
            validType = typeof valid;
        // Convert any numeric string values to integer value
        if(valueType=='string' && this.isNumeric(value))
            value = parseInt(value);
        // Convert a valid string to an array
        if(validType=='string')
            valid = [valid];
        // Only return true for valid values
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    }

    // Handle validating amount format
    isValidAmountFormat(decimals, amount){
        // Determine divisibility and default to true
        let divisible   = (parseInt(decimals)==0) ? false : true;
        let [int, sats] = String(amount).split('.');
        if(!divisible && this.isNumeric(int) && int==amount)
            return true;
        if(divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats)))
            return true;
        return false;
    }

    // Handle validating fiat amount format
    isValidFiatFormat(decimals, amount){
        let valid = this.isValidAmountFormat(decimals, amount);
        if(valid){
            let [int, sats] = String(amount).split('.');
            if(!this.isNull(sats) && String(sats).length > decimals);
                valid = false;
        }
        return valid;
    }

    // Validate if a lock flag value evaluates to 0 (unlocked) or 1 (locked)
    isValidLockValue(value){
        let type  = typeof value,
            valid = [0,1];
        // Convert any numeric strings to integer value
        if(type=='string' && this.isNumeric(value))
            value = parseInt(value);
        // Only return true for 0/1 values
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    }


    // Handle doing VERY lose validation on an address
    // TODO: Clean this up to actually verify crypto addresses using crypto library
    isCryptoAddress(address){
        let len = String(address).length;
        // Check P2PKH (26-35 chars)
        if(len>=26 && len<=35)
            return true;
        // Check Segwit (42 chars)
        if(len==42)
            return true;
        return false;
    }

    // Handle adding a ticker to the addreses
    addAddressTicker(address, tick){
        let type = typeof tick;
        let list = (!this.isNull(this.addresses[address])) ? this.addresses[address] : [];
        // If tick is not null and type is an object, loop through tickers
        if(type=="object" && !this.isNull(tick)){
            for(let t of tick){
                // Add ticker to addresses list 
                if(!list.includes(t))
                    list.push(t);
                // Add ticker to tickers list
                if(!this.tickers.includes(t))
                    this.tickers.push(t);
            }
        } else if(type!='undefined'){
            // Add ticker to addresses list 
            if(!list.includes(tick))
                list.push(tick);
            // Add ticker to tickers list
            if(!this.tickers.includes(tick))
                this.tickers.push(tick);
        }
        // Update address list with updated list of tickers
        this.addresses[address] = list;
    }

    // Handle getting the current time in seconds
    getCurrentTime(){
        return this.bcdiv(Date.now(), 1000, 0);
    }

    // Handle getting the default EXPIRATION 
    getDefaultExpiration(block_time){
        // Get current time in seconds
        let now = block_time;
        // Get number of seconds in EXPIRATION_FEE_DEFAULT_DAYS
        let sec = this.bcmul(this.config['EXPIRATION_FEE_DEFAULT_DAYS'], 86400, 0);
        return this.bcadd(now, sec, 0);
    }

    // Convert NUMBER fields from string value to number value so comparisons are mathematical 
    setNumberFormats(data){
        for(let name of this.config['NUMBER_FIELDS']){
            let value = data[name];
            if(!this.isNull(value))
                data[name] = this.bcnum(value);
        }
        return data;
    }

    // Determine if a tx hash is valid or not
    // TODO: clean this up to verify it is an actual tx hash
    isValidTransactionHash(hash){
        if(String(hash).length==64)
            return 1;
        return 0;
    }

    // Determine price of an item (numerator / denominator)
    // Note : Use precision up to 64 decimals points for very precise prices
    getPrice(numerator, denominator, precision=64){
        return this.bcdiv(numerator, denominator, precision);
    }

    // Sort an object by key values
    ksort(obj){
        const sortedKeys = Object.keys(obj).sort();
        const sortedObj = sortedKeys.reduce((acc, key) => {
            acc[key] = obj[key];
            return acc;
        }, {});
        return sortedObj;
    }

    // Handle getting a list of actions from 
    getActions(){
        let actions = [];
        for(let action in formats)
            actions.push(action);
        return actions;
    }

    // Handle returning integer format version
    getActionFormats(action){
        let arr  = null,
            name = String(action).toUpperCase();
        if(!this.isNull(formats[name]))
            arr = formats[name];
        return arr;
    }

    // Handle getting a list of all possible fields from the formats object
    getActionFormatFieldList(action, format){
        let list = [],
            arr  = this.getActionFormats(action);
        if(!this.isNull(arr[format])){
            let fields = String(arr[format]).split('|');
            for(let field in fields){
                let name = fields[field];
                if(!list.includes(name))
                    list.push(name);
            }
        }
        return list;
    }


}

module.exports = Utility;