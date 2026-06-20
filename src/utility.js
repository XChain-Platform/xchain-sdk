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
 * XChain Platform SDK - Utility Class
 * 
 * This file provides utility functions used throughout the SDK
 *
 ********************************************************************/

const config  = require('./config.js');
const formats = require('./formats.js');
const mathjs  = require('mathjs');

// Support BigInt in JSON stringify()
BigInt.prototype.toJSON = function(){
    return JSON.rawJSON(this.toString());
};

class Utility {

    constructor(){
        this.addresses = {}; // this.addresses[address] = [tick, tick, tick];
        this.tickers   = [];
        this.config = config.getConfig();
    }

    resetAddressesList(){
        this.addresses = {};
    }

    resetTickersList(){
        this.tickers = [];
    }

    resetLists(){
        this.resetAddressesList();
        this.resetTickersList();
    }

    getAddressesList(){
        return this.addresses;
    }

    getTickersList(){
        return this.tickers;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    throwError(error){
        console.error('throwError:', error);
        throw error;
    }

    logError(error, info){
        // let file  = '/XChainIndexer/error.log';
        // fs.appendFileSync(file, error);
        console.error('logError: ' + error, info);
        // DEBUG: Throw exception on any error
        this.throwError(error);
    }

    startTimer(){
        let now = Date.now();
        return now;
    }

    getTimer(timer){
        let now = Date.now();
        let ms  = now - timer;
        let timeString = this.millisecondsToTimeString(ms);
        let niceString = ms + 'ms';
        if(timeString!='')
            niceString = timeString;
        return niceString;
    }

    logTimer(timer, timeName){
        var timeString = this.getTimer(timer);
        var niceString = (timeName!=null) ? timeName : 'Time';
        if(timeString!='')
            niceString += '\t: (' + timeString + ')';
        console.log(niceString);
    }

    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    }

    isNumeric(value){
        return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
    }

    isFloat(value){
        return value === +value && value !== (value|0);
    }

    isInteger(value){
        return value === +value && value === (value|0);
    }

    isNull(value){
        return (value === null || value === undefined || value==='');
    }

    // Coerce a value to a full-precision bignumber (matches the indexer's
    // canonical bcnum). Returns a mathjs bignumber (NOT a JS double), so neither
    // this nor the bc* helpers below truncate amounts beyond 2^53 or past ~16
    // significant digits, and no result is ever re-funnelled through parseFloat
    // (which also emits scientific notation). Non-numeric / NaN / Infinity inputs
    // yield bignumber(0) rather than throwing, mirroring the indexer guard.
    bcnum(num){
        let str = String(num).trim();
        if(str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !this.isNumeric(num))
            return mathjs.bignumber(0);
        return mathjs.bignumber(str);
    }

    bcformat(num, decimals){
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(this.bcnum(num),{notation: 'fixed', precision: d});
    }

    bcsub(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    }

    bcadd(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    }

    bcmul(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(mathjs.multiply(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    }

    bcdiv(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(mathjs.divide(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    }

    isValidValue(value, valid){
        let valueType = typeof value,
            validType = typeof valid;
        if(valueType=='string' && this.isNumeric(value))
            value = parseInt(value);
        if(validType=='string')
            valid = [valid];
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    }

    isValidAmountFormat(decimals, amount){
        let divisible   = (parseInt(decimals)==0) ? false : true;
        let [int, sats] = String(amount).split('.');
        if(!divisible && this.isNumeric(int) && int==amount)
            return true;
        if(divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats)))
            return true;
        return false;
    }

    isValidFiatFormat(decimals, amount){
        let valid = this.isValidAmountFormat(decimals, amount);
        if(valid){
            let [int, sats] = String(amount).split('.');
            if(!this.isNull(sats) && String(sats).length > decimals);
                valid = false;
        }
        return valid;
    }

    isValidLockValue(value){
        let type  = typeof value,
            valid = [0,1];
        if(type=='string' && this.isNumeric(value))
            value = parseInt(value);
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
        // Check segwit bech32: BTC/LTC P2WPKH and P2WSH across mainnet/testnet/regtest
        // span roughly 42 to 64 chars (bc1/tb1/bcrt1/ltc1/tltc1 HRP + program). This is a
        // loose pre-flight only; real validation happens at encode/broadcast time.
        if(len>=42 && len<=64)
            return true;
        return false;
    }

    addAddressTicker(address, tick){
        let type = typeof tick;
        let list = (!this.isNull(this.addresses[address])) ? this.addresses[address] : [];
        if(type=="object" && !this.isNull(tick)){
            for(let t of tick){
                if(!list.includes(t))
                    list.push(t);
                if(!this.tickers.includes(t))
                    this.tickers.push(t);
            }
        } else if(type!='undefined'){
            if(!list.includes(tick))
                list.push(tick);
            if(!this.tickers.includes(tick))
                this.tickers.push(tick);
        }
        this.addresses[address] = list;
    }

    getDefaultExpiration(block_time){
        let now = block_time;
        let sec = this.bcmul(this.config['EXPIRATION_FEE_DEFAULT_DAYS'], 86400, 0);
        return this.bcadd(now, sec, 0);
    }

    setNumberFormats(data){
        for(let name of this.config['NUMBER_FIELDS']){
            let value = data[name];
            // Only cast values that are actually numeric. Some field NAMES are
            // numeric for one action but string-valued for another (e.g. TYPE is
            // a 0/1 selector for LIST but a MIME string for FILE). Casting a
            // non-numeric string (e.g. "text/plain") with bcnum yields NaN and
            // corrupts the action. Mirrors the indexer's setNumberFormats guard.
            //
            // Use a full-precision bignumber + fixed notation rather than bcnum's
            // parseFloat/parseInt: amounts can be DIVISIBLE to 18 decimals
            // (MAX_DECIMALS) and supplies can exceed 2^53, both of which JS doubles
            // truncate, and parseFloat also emits scientific notation (e.g.
            // "1e-18"), corrupting the on-chain ACTION string. fixed notation keeps
            // the exact wire value, matching how the indexer reads it back.
            if(!this.isNull(value) && this.isNumeric(value))
                data[name] = mathjs.format(mathjs.bignumber(String(value).trim()), { notation: 'fixed' });
        }
        return data;
    }

    // Determine if a tx hash is valid or not
    // TODO: only checks length === 64; does not verify hex encoding or format
    isValidTransactionHash(hash){
        if(String(hash).length==64)
            return 1;
        return 0;
    }

    // Precision up to 64 decimal points for very precise prices
    getPrice(numerator, denominator, precision=64){
        return this.bcdiv(numerator, denominator, precision);
    }

    ksort(obj){
        const sortedKeys = Object.keys(obj).sort();
        const sortedObj = sortedKeys.reduce((acc, key) => {
            acc[key] = obj[key];
            return acc;
        }, {});
        return sortedObj;
    }

    camelToUpperSnake(str) {
        return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    }

    normalizeFields(data) {
        let normalized = {};
        for (let key in data) {
            let upperKey = this.camelToUpperSnake(key);
            normalized[upperKey] = data[key];
        }
        return normalized;
    }

    getActions(){
        let actions = [];
        for(let action in formats)
            actions.push(action);
        return actions;
    }

    getActionFormats(action){
        let arr  = null,
            name = String(action).toUpperCase();
        if(!this.isNull(formats[name]))
            arr = formats[name];
        return arr;
    }

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