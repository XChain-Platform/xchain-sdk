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

const mathjs = require('mathjs');

module.exports = {
    isNumeric(value){
        return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
    },

    isFloat(value){
        return value === +value && value !== (value|0);
    },

    isInteger(value){
        return Number.isInteger(+value);
    },

    isNull(value){
        return (value === null || value === undefined || value==='');
    },

    // Mirrors xchain-indexer/src/utility.js safeToString: returns null for values
    // that cannot be safely stringified, so callers can reject unsafe object amounts.
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
    },

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
    },

    bcformat(num, decimals){
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(this.bcnum(num),{notation: 'fixed', precision: d});
    },

    bcsub(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    },

    bcadd(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    },

    bcmul(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(mathjs.multiply(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    },

    bcdiv(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        if(String(b) === '0' || b === 0)
            return mathjs.format(mathjs.bignumber(0),{notation: 'fixed', precision: d});
        return mathjs.format(mathjs.divide(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d});
    },

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
    },

    // Two arguments on purpose. The consensus-authoritative indexer copy takes an
    // optional third one, the including block's consensus timestamp, which opts that
    // call into its flag-day AMOUNT-REPRESENTABILITY gate (an amount must be a plain
    // decimal numeral that denotes the number the ledger credits, so '5e-19' no longer
    // validates and then credits 1e-18). This copy stays on the legacy rule while
    // mainnet and testnet are both unarmed for that gate: a client that rejects what
    // those planes still accept blocks a valid broadcast. Parity with the indexer copy
    // is asserted in test/unit/utility.test.js, and it is parity with the legacy
    // two-argument path, which the indexer preserves byte-for-byte below the threshold.
    isValidAmountFormat(decimals, amount){
        // Reject objects that can't be safely converted to string (mirrors indexer).
        if(amount !== null && amount !== undefined && typeof amount === 'object' && this.safeToString(amount) === null)
            return false;
        // Reject negative amounts (mirrors the consensus-authoritative indexer guard).
        if(String(amount).startsWith('-'))
            return false;
        let divisible   = (parseInt(decimals)==0) ? false : true;
        let parts       = String(amount).split('.');
        let [int, sats] = parts;
        //<MULTI-DOT-REJECT> reject an amount carrying more than one decimal
        // point. Destructuring keeps only the first two segments, so "1.2.3" reads as
        // int="1"/sats="2" and clears the divisible branch below, letting the SDK build an
        // amount the consensus-authoritative indexer would choke on. Mirrors the identical
        // guard in xchain-indexer/src/utility.js.
        if(parts.length > 2)
            return false;
        //</MULTI-DOT-REJECT>
        if(!divisible && this.isNumeric(int) && int==amount)
            return true;
        //<FRACTIONAL-PRECISION-CAP> an amount must not carry more fractional
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
    },

    isValidFiatFormat(decimals, amount){
        let valid = this.isValidAmountFormat(decimals, amount);
        if(valid){
            let [int, sats] = String(amount).split('.');
            if(!this.isNull(sats) && String(sats).length > decimals)
                valid = false;
        }
        return valid;
    },

    isValidLockValue(value){
        let type  = typeof value,
            valid = [0,1];
        if(type=='string' && this.isNumeric(value))
            value = parseInt(value);
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    },

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
            if(!this.isNull(value) && this.isNumeric(value)){
                // A JS Number arrives having ALREADY been through the double
                // rounding, and String() then prints the shortest decimal that
                // round-trips, so the bignumber below turns a value the caller never
                // sent into an exact-looking wire amount with no error anywhere:
                // JSON.parse('{"AMOUNT":9007199254740993}') is 9007199254740992 by
                // the time this gate sees it, and bodyParser.json() puts every HTTP
                // caller on that path. The double carries 15 decimal digits
                // faithfully; a shortest form needing MORE than that is a value the
                // Number could not have held as written, so refuse it and say what
                // to send instead. Strings and BigInt are untouched, and a Number
                // that IS exact at this width (1e21 prints as one significant digit)
                // still canonicalizes exactly as before.
                if(typeof value === 'number' && this.significantDigits(value) > 15)
                    throw new RangeError(
                        name + ' was supplied as a JS number with more precision than a ' +
                        'double carries, so its value was already rounded before the SDK ' +
                        'saw it; send an amount of this size as a decimal string');
                data[name] = mathjs.format(mathjs.bignumber(String(value).trim()), { notation: 'fixed' });
            }
        }
        return data;
    },

    // Significant decimal digits in a finite Number's SHORTEST round-tripping form
    // (what String() prints), ignoring sign, exponent, and leading/trailing zeros:
    // 1e21 and 100 are 1, 9007199254740992 is 16, 0.1 is 1. Used by
    // setNumberFormats to tell a faithfully-carried magnitude from a rounded one.
    significantDigits(value){
        if(typeof value !== 'number' || !Number.isFinite(value))
            return 0;
        let mantissa = String(value).split(/[eE]/)[0].replace('-','').replace('.','');
        return mantissa.replace(/^0+/,'').replace(/0+$/,'').length;
    }
};
