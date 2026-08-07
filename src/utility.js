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
        return Number.isInteger(+value);
    }

    isNull(value){
        return (value === null || value === undefined || value==='');
    }

    // Mirrors xchain-indexer/src/utility.js safeToString: returns null for values
    // that cannot be safely stringified (used to reject unsafe object amounts).
    safeToString(val) {
        if(val === null || val === undefined)
            return null;
        if(typeof val !== 'object')
            return String(val);
        if(mathjs.isBigNumber && mathjs.isBigNumber(val))
            return mathjs.format(val, {notation: 'fixed'});
        if(typeof val.toString !== 'function')
            return null;
        try { return String(val); } catch(e){ return null; }
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
        if(String(b) === '0' || b === 0)
            return mathjs.format(mathjs.bignumber(0),{notation: 'fixed', precision: d});
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
        // Reject objects that can't be safely converted to string (mirrors indexer).
        if(amount !== null && amount !== undefined && typeof amount === 'object' && this.safeToString(amount) === null)
            return false;
        // Reject negative amounts (mirrors the consensus-authoritative indexer guard).
        if(String(amount).startsWith('-'))
            return false;
        let divisible   = (parseInt(decimals)==0) ? false : true;
        let [int, sats] = String(amount).split('.');
        if(!divisible && this.isNumeric(int) && int==amount)
            return true;
        //<FRACTIONAL-PRECISION-CAP> (item 5346): an amount must not carry more fractional
        // digits than the tick's decimals. This mirrors the consensus-authoritative cap in
        // xchain-indexer/src/utility.js so the SDK rejects over-precise amounts client-side
        // before they are submitted. Parity is asserted in test/unit/utility.test.js.
        if(divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats))){
            if(!this.isNull(sats) && String(sats).length > parseInt(decimals))
                return false;
            return true;
        }
        //</FRACTIONAL-PRECISION-CAP>
        return false;
    }

    isValidFiatFormat(decimals, amount){
        let valid = this.isValidAmountFormat(decimals, amount);
        if(valid){
            let [int, sats] = String(amount).split('.');
            if(!this.isNull(sats) && String(sats).length > decimals)
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

    // Pin the wire VERSION a version-locked helper exists to force.
    //
    // The helpers used to build `{ VERSION: '3', ...params }`, so the spread
    // landed AFTER the forced value and a caller-supplied VERSION won; lowercase
    // `version` won too, since normalizeFields upper-snakes both spellings onto
    // the same key. A caller could therefore serialize STAKE|1 out of the v3
    // staking helper, dropping TARGET_CONTRACT_INDEX and TICK and routing assets
    // into the wrong lane. Silently ignoring the caller's value would fix the
    // routing and keep the surprise, so a MISMATCHED version throws instead
    // ().
    // Delegates to the module-level function so the call sites (walletSession,
    // workflows) can reach it WITHOUT an sdk instance: they are handed a stub sdk
    // in their own unit tests, and a helper that guards fund routing must not be
    // the thing that needs wiring to work.
    withForcedVersion(version, params) {
        return withForcedVersion(version, params);
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

// Pure, instance-free, and exported as a static so the version-locked helpers can
// call it directly (see the instance method above for why that matters).
function withForcedVersion(version, params) {
    let out = {};
    let supplied;
    for (let key in (params || {})) {
        // Same upper-snake normalization normalizeFields applies, so `version`,
        // `Version` and `VERSION` are all caught rather than only the loud one.
        if (key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() === 'VERSION'){ supplied = params[key]; continue; }
        out[key] = params[key];
    }
    if (supplied !== undefined && supplied !== null && String(supplied) !== String(version))
        throw new Error(`this helper forces VERSION ${version} and will not route to VERSION ${supplied}; call the helper for that version instead`);
    out.VERSION = String(version);
    return out;
}

Utility.withForcedVersion = withForcedVersion;

module.exports = Utility;