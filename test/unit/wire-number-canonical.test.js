// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Byte-level wire contract: no NUMBER_FIELDS value may ever
// leave the SDK in JS scientific notation ("1e-8"). Every current parser
// (mathjs) tolerates it, but the literal is stored verbatim and a future
// strict-decimal validator tier would reject it, which is a consensus split.
// setNumberFormats is the single canonicalization gate, so the contract is:
// every amount-class field is listed in NUMBER_FIELDS, and the gate's output
// never matches /e/i for any numeric input, including the sub-1e-6 and
// >2^53 magnitudes where String()/parseFloat go scientific.

const { expect } = require('chai');
const config     = require('../../src/config.js');
const Utility    = require('../../src/utility.js');
const { XChainSDK } = require('../../index.js');

const cfg  = config.getConfig();
const util = new Utility(cfg);

// Values whose String() form is scientific notation, with the exact
// fixed-decimal bytes the wire must carry instead.
const SCI_CASES = [
    [0.00000001,  '0.00000001'],           // String() => "1e-8"
    [0.0000001,   '0.0000001'],            // String() => "1e-7"
    [2e-8,        '0.00000002'],
    [1e21,        '1000000000000000000000'], // String() => "1e+21"
    ['1e-8',      '0.00000001'],           // scientific already in a string
    ['2.5E-7',    '0.00000025'],           // uppercase exponent
];

describe('wire number canonicalization contract', function () {

    it('NUMBER_FIELDS covers the VOTE escrow amounts DEPOSIT and GAS_ESCROW', function () {
        expect(cfg.NUMBER_FIELDS).to.include('DEPOSIT');
        expect(cfg.NUMBER_FIELDS).to.include('GAS_ESCROW');
    });

    it('setNumberFormats never emits scientific notation for any NUMBER_FIELD', function () {
        for (const field of cfg.NUMBER_FIELDS) {
            for (const [input, expected] of SCI_CASES) {
                const out = util.setNumberFormats({ [field]: input })[field];
                expect(String(out)).to.not.match(/e/i,
                    `${field}: ${input} serialized as ${out} (scientific notation on the wire)`);
                expect(String(out)).to.equal(expected, `${field}: ${input}`);
            }
        }
    });

    it('VOTE v0 poll-create wire string carries DEPOSIT/GAS_ESCROW as fixed decimals', async function () {
        // compactTickers:false so createAction never reaches the network.
        const sdk = new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
        const p = sdk.voting.createPollParams({
            tick: 'GOVTOKEN', endBlock: 850000, options: ['YES', 'NO'],
            quorum: '0.5', minVoters: 1,
            deposit: 0.00000002,
            callbackContract: 42, callbackMethod: 'onResult',
            gasEscrow: 0.00000001,
        });
        const built = await sdk.vote(p);
        expect(built.fields.DEPOSIT).to.equal('0.00000002');
        expect(built.fields.GAS_ESCROW).to.equal('0.00000001');
        // Byte-level: no pipe segment of the wire string may be scientific
        // notation (a digit mantissa followed by an e/E exponent).
        for (const seg of built.actionString.split('|')) {
            expect(seg).to.not.match(/^-?\d+(\.\d+)?[eE][+-]?\d+$/,
                `wire segment "${seg}" is scientific notation: ${built.actionString}`);
        }
        expect(built.actionString).to.include('|0.00000002|');
        expect(built.actionString.endsWith('|0.00000001')).to.equal(true);
    });
});
