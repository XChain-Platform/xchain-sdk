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

const crypto = require('crypto');
const coins  = require('../../coins');

// Address encoding constants for the coin-and-network-aware address validator
// ported from xchain-indexer/src/utility.js (xchain-bridge.md section 13: a
// bridge mint to a mis-validated address is a permanent loss, so the SDK cannot
// keep gating DEST_ADDRESS on its length heuristic alone).
//
// The per-coin version bytes and bech32 HRPs are NOT hand-duplicated here the way
// the indexer duplicates them: they are read from the hashed coin registry
// (src/coins), which already carries pubKeyHash / scriptHash / bech32 per network
// and is covered by the consensus pin. test/unit/address_parity.test.js asserts the
// indexer's hand-written ADDRESS_PARAMS table still equals this registry, so a
// one-sided edit to either is a red test rather than a silent divergence.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET  = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST    = 1;          // BIP-173 checksum constant (segwit v0)
const BECH32M_CONST   = 0x2bc830a3; // BIP-350 checksum constant (segwit v1+)
const BECH32_GEN      = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

module.exports = {
    // Per-coin, per-network address parameters, read from the hashed coin registry.
    // Returns { p2pkh, p2sh, hrp } or false for an unknown coin or network, so an
    // unrecognized pair fails CLOSED (no address validates) instead of falling back
    // to another chain's version bytes.
    addressParams(coin, network){
        if(this.isNull(coin) || this.isNull(network))
            return false;
        let cfg;
        try { cfg = coins.getCoinConfig(String(coin).toUpperCase(), String(network)); }
        catch(e){ return false; }
        let net = (cfg) ? cfg.net : null;
        if(!net)
            return false;
        return {
            p2pkh: net.pubKeyHash,
            p2sh:  net.scriptHash,
            // DOGE has no segwit, so no HRP; null means "base58check only".
            hrp:   (typeof net.bech32 == 'string' && net.bech32) ? net.bech32 : null
        };
    },

    // Decode a base58check string and return its payload bytes, or false if the
    // string is not valid base58check (bad charset, bad length, bad checksum).
    // Byte-for-byte the indexer's algorithm (xchain-indexer/src/utility.js).
    base58CheckDecode(address){
        let str = String(address);
        // Reject anything outside the plausible base58check address length band
        if(str.length<26 || str.length>48)
            return false;
        // Decode base58 to a big integer, rejecting any out-of-alphabet character
        let num = 0n;
        for(let char of str){
            let value = BASE58_ALPHABET.indexOf(char);
            if(value==-1)
                return false;
            num = num * 58n + BigInt(value);
        }
        // Convert integer to bytes, restoring leading zero bytes (leading '1' chars)
        let hex = num.toString(16);
        if(hex.length % 2)
            hex = '0' + hex;
        let bytes = Buffer.from(hex,'hex');
        if(num==0n)
            bytes = Buffer.alloc(0);
        let leading = 0;
        while(leading<str.length && str[leading]=='1')
            leading++;
        let data = Buffer.concat([Buffer.alloc(leading), bytes]);
        // Last 4 bytes are a double-SHA256 checksum over the payload
        if(data.length<5)
            return false;
        let payload  = data.subarray(0, data.length-4);
        let checksum = data.subarray(data.length-4);
        let hash = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest();
        if(!hash.subarray(0,4).equals(checksum))
            return false;
        return payload;
    },

    // Decode a bech32/bech32m string (BIP-173/BIP-350) and return
    // { hrp, version, program } for a valid segwit address, or false
    bech32Decode(address){
        let str = String(address);
        // Reject mixed case, then work in lowercase (all-uppercase is allowed)
        if(str!=str.toLowerCase() && str!=str.toUpperCase())
            return false;
        str = str.toLowerCase();
        if(str.length<8 || str.length>90)
            return false;
        // Split on the last '1' separator
        let pos = str.lastIndexOf('1');
        if(pos<1 || pos+7>str.length)
            return false;
        let hrp  = str.substring(0,pos);
        let data = [];
        for(let char of str.substring(pos+1)){
            let value = BECH32_CHARSET.indexOf(char);
            if(value==-1)
                return false;
            data.push(value);
        }
        // Verify the BCH checksum (BIP-173 polymod over expanded hrp + data)
        let chk = this.bech32Polymod(hrp, data);
        // Witness version is the first data value; remaining values (minus the
        // 6 checksum chars) are the witness program in 5-bit groups
        let version = data[0];
        if(version>16)
            return false;
        // Segwit v0 uses the bech32 constant, v1+ uses bech32m (BIP-350)
        if(chk!=(version==0 ? BECH32_CONST : BECH32M_CONST))
            return false;
        // Convert the witness program from 5-bit to 8-bit groups (no padding bits set)
        let bits = 0, acc = 0, program = [];
        for(let value of data.slice(1, data.length-6)){
            acc  = (acc<<5)|value;
            bits += 5;
            while(bits>=8){
                bits -= 8;
                program.push((acc>>bits)&0xff);
            }
        }
        if(bits>=5 || ((acc<<(8-bits))&0xff))
            return false;
        // Witness program length rules (BIP-141): 2-40 bytes, v0 exactly 20 or 32
        if(program.length<2 || program.length>40)
            return false;
        if(version==0 && program.length!=20 && program.length!=32)
            return false;
        return { hrp: hrp, version: version, program: program };
    },

    // BIP-173 BCH polymod over the expanded HRP plus the given 5-bit data values.
    bech32Polymod(hrp, data){
        let values = [];
        for(let i=0; i<hrp.length; i++)
            values.push(hrp.charCodeAt(i)>>5);
        values.push(0);
        for(let i=0; i<hrp.length; i++)
            values.push(hrp.charCodeAt(i)&31);
        values = values.concat(data);
        let chk = 1;
        for(let value of values){
            let top = chk>>25;
            chk = ((chk&0x1ffffff)<<5)^value;
            for(let i=0; i<5; i++)
                if((top>>i)&1)
                    chk ^= BECH32_GEN[i];
        }
        return chk;
    },

    // Split a bridged tick '<ORIGIN>.<NAME>' into { origin, name }, or null when the
    // tick is not a bridged row's name (xchain-token-bridge.md sections 3 and 6).
    // Answers only on the three conditions the rooted namespace guarantees:
    //   - the prefix is a coin in the registry
    //   - it is not THIS chain's own coin (a row rooted under the local coin is a
    //     plain subasset of the reserved root, never a bridged copy)
    //   - the tick carries exactly one dot (milestone 1 does not bridge subassets)
    // `coin` is the chain being read. The SDK has no configured coin (unlike the
    // indexer, whose copy defaults to config['COIN']), so an omitted coin skips the
    // not-this-chain clause rather than guessing a chain.
    parseBridgedTick(tick, coin){
        if(this.isNull(tick))
            return null;
        let str   = String(tick);
        let parts = str.split('.');
        if(parts.length!=2)
            return null;
        let origin = parts[0].toUpperCase();
        let name   = parts[1];
        if(name==='')
            return null;
        if(!coins.ALLOWED_COINS.includes(origin))
            return null;
        if(!this.isNull(coin) && origin==String(coin).toUpperCase())
            return null;
        return { origin: origin, name: name };
    },

    // Validate an address.
    //
    // With a COIN and NETWORK this is the indexer's validator (full base58check
    // version byte + checksum, full bech32/bech32m checksum and witness-program
    // rules), so a checksum typo or a wrong-chain address is refused instead of
    // becoming an unspendable bridge destination.
    //
    // With NEITHER it keeps the historical one-argument length heuristic. That is
    // deliberate: every pre-bridge caller (the validator's flat ADDRESS_FIELDS
    // sweep, wallet pre-flight) passes one argument, and silently tightening them
    // against a chain this class cannot know would refuse addresses the protocol
    // accepts. Bridge fields pass the coin explicitly.
    isCryptoAddress(address, coin, network){
        if(this.isNull(address))
            return false;
        if(!this.isNull(coin) || !this.isNull(network)){
            let params = this.addressParams(coin, network);
            if(!params)
                return false;
            let str = String(address);
            // Segwit address (only on coins with a bech32 HRP, e.g. not DOGE)
            if(params.hrp && str.toLowerCase().startsWith(params.hrp + '1')){
                let decoded = this.bech32Decode(str);
                return (decoded && decoded.hrp==params.hrp) ? true : false;
            }
            // Base58check address (P2PKH / P2SH): payload is version byte + hash160
            let payload = this.base58CheckDecode(str);
            if(!payload || payload.length!=21)
                return false;
            return (payload[0]==params.p2pkh || payload[0]==params.p2sh);
        }
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
    },

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
    },

    // Determine if a tx hash is valid or not
    // TODO: only checks length === 64; does not verify hex encoding or format
    isValidTransactionHash(hash){
        if(String(hash).length==64)
            return 1;
        return 0;
    }
};
