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

const config  = require('../config.js');
const formats = require('../protocol/formats.js');
const { getLogger } = require('../observability/logger.js');
const log = getLogger('xchain-sdk:utility');

// Support BigInt in JSON stringify(), as a QUOTED decimal string.
// JSON.rawJSON emitted a bare numeric token, so JSON.parse rounded any satoshi value
// above 2^53 straight back down. The encoder already parses the string form exactly
// (validator.parseSatoshiAmount), and it is what xchain-indexer's jsonStringify pins.
BigInt.prototype.toJSON = function(){
    return this.toString();
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
        log.error('throwError:', error);
        throw error;
    }

    logError(error, info){
        log.error('logError: ' + error, info);
        // Deliberately fatal: every logged error is also rethrown.
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
        log.log(niceString);
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
    // routing and keep the surprise, so a MISMATCHED version throws instead.
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

Object.assign(Utility.prototype, require('./utility/number_format.js'), require('./utility/address_codec.js'));

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
