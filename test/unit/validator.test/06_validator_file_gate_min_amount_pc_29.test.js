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
 * XChain Platform SDK - Validator Tests
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility    = require('../../../src/utils/utility.js');
const Validator  = require('../../../src/protocol/validator.js');
const { SDKValidationError } = require('../../../src/utils/errors.js');

function createValidator() {
    return new Validator(new Utility());
}

function hasNoErrorCode(errors, code) {
    return !errors.some(e => e.code === code);
}

function hasErrorCode(errors, code) {
    return errors.some(e => e.code === code);
}



describe('Validator: FILE GATE_MIN_AMOUNT (PC-29)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const bad = (value) => v.validate('FILE', { NAME: 'f.txt', TYPE: 'text/plain', GATE_MIN_AMOUNT: value });
    const isRejected = (value) => !hasNoErrorCode(bad(value), 'INVALID_FIELD_VALUE');

    describe('shared GATE_MIN_AMOUNT vectors', function () {
        const fs      = require('fs');
        const path    = require('path');
        const FIXTURE = path.join(__dirname, '../../fixtures/gate-min-amount-vectors.json');
        const vectors = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));


        for (const vec of vectors.layer_asymmetry.sdk_rejects_indexer_normalizes) {
            it(`${vec.label}: ${JSON.stringify(vec.value)} is rejected here, normalized by the indexer`, function () {
                expect(isRejected(vec.value), 'the SDK must not emit it').to.be.true;
                expect(isRejected(vec.normalizes_to), 'the trimmed form is what consensus sees').to.be.false;
            });
        }

        // The division of labour, asserted rather than described: every divisibility
        // vector is a well-formed decimal, so this stateless layer must pass ALL of
        // them, including the ones the indexer rejects against the tick at that block.
        for (const vec of vectors.divisibility) {
            it(`divisibility is not this layer's call: ${vec.value} passes the format check`, function () {
                expect(isRejected(vec.value)).to.be.false;
            });
        }

        // Cross-repo byte identity. Skips (rather than fails) when a sibling checkout
        // is absent, matching the repo's other sibling-conformance tests; CI sets
        // XCHAIN_REQUIRE_SIBLINGS=1 so a missing sibling hard-fails there.
        const SIBLINGS = [
            ['xchain-indexer', 'test/fixtures/gate-min-amount-vectors.json'],
            ['xchain-wallet',  'test/fixtures/gate-min-amount-vectors.json']
        ];
        const canonical = fs.readFileSync(FIXTURE);
        SIBLINGS.forEach(([repo, rel]) => {
            it(`the ${repo} copy is byte-identical`, function () {
                const p = path.join(__dirname, '../../../..', repo, rel);
                if (!fs.existsSync(p)) {
                    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                        throw new Error('sibling ' + repo + ' fixture missing: ' + p);
                    return this.skip();
                }
                expect(fs.readFileSync(p).equals(canonical),
                    repo + ' fixture drifted from the canonical sdk copy').to.be.true;
            });
        });
    });
});

// TRANSFER_SUPPLY: an ADDRESS, never a quantity

describe('Validator: TRANSFER_SUPPLY is an address field', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // TRANSFER_SUPPLY names the address ISSUE credits MINT_SUPPLY to, and both
    // addressRefFields.js and the indexer treat it that way. It was ALSO listed
    // among the numeric AMOUNT fields, so every real address failed the numeric
    // rule and owner issue-and-transfer could not be composed through the SDK.
    it('accepts a real address, which the numeric rule used to reject', function () {
        const errors = v.validate('ISSUE', {
            TICK:            'MYTOKEN',
            MINT_SUPPLY:     '1000',
            TRANSFER_SUPPLY: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a value that is not an address', function () {
        const errors = v.validate('ISSUE', {
            TICK:            'MYTOKEN',
            MINT_SUPPLY:     '1000',
            TRANSFER_SUPPLY: 'not-an-address'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // A ^<id> compacted reference is resolved later by the indexer, so the
    // address check is skipped for it exactly as it is for TRANSFER.
    it('accepts a compacted ^<id> reference without an address check', function () {
        const errors = v.validate('ISSUE', {
            TICK:            'MYTOKEN',
            MINT_SUPPLY:     '1000',
            TRANSFER_SUPPLY: '^42'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ISSUE v7: the issuer's bridge opt-in (BRIDGE_CHAINS / MIN_DEPTH / LOCK_BRIDGE)
//
// Every rule below mirrors a named refusal in xchain-indexer/src/actions/issue.js, so
// each case is written as "what the chain does with this wire value", never as a
// restatement of the SDK's own message.

describe('Validator: ISSUE v7 bridge opt-in fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // BRIDGE_CHAINS (indexer issue.js: 'invalid: BRIDGE_CHAINS')

    it('accepts the "-" sentinel, which is how an opt-in is cleared', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', BRIDGE_CHAINS: '-' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts a comma list of chain coins', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', BRIDGE_CHAINS: 'DOGE,LTC' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // The handler upper-cases each segment before testing membership, so a lowercase
    // coin is accepted on chain and must not be refused here.
    it('accepts a lowercase coin, which the handler upper-cases before testing', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', BRIDGE_CHAINS: 'doge' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a coin the platform does not run', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', BRIDGE_CHAINS: 'ETH' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects the whole list when only one entry is bad', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', BRIDGE_CHAINS: 'DOGE,ETH,LTC' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // The handler splits on ',' and does NOT trim, so ' LTC' never matches a coin and
    // the action is refused on chain. Trimming here would make the SDK looser than
    // consensus and the caller would pay a miner fee to discover it.
    it('rejects an entry padded with a space, exactly as the untrimming handler does', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', BRIDGE_CHAINS: 'DOGE, LTC' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // MIN_DEPTH (indexer issue.js: 'invalid: MIN_DEPTH (format)', /^\d+$/)

    it('accepts a whole-number MIN_DEPTH', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', MIN_DEPTH: '6' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts MIN_DEPTH = 0, which is the raise-only "no raise"', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', MIN_DEPTH: 0 });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

});

describe('Validator: ISSUE v7 bridge opt-in fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


    ['-1', '6.5', 'six', '1e3'].forEach(function (bad) {
        it('rejects a non-digit MIN_DEPTH: ' + bad, function () {
            const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG', MIN_DEPTH: bad });
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });
    });

    // Subassets are not bridgeable yet: the indexer refuses the WHOLE format for a
    // dotted name ('invalid: TICK (subassets are not bridgeable yet)').

    it('refuses the opt-in for a dotted (subasset) TICK', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG.SUB', BRIDGE_CHAINS: 'DOGE' });
        expect(hasErrorCode(errors, 'ISSUE_CONSTRAINT')).to.be.true;
    });

    // The refusal is on the whole format, not only on a non-empty BRIDGE_CHAINS: a
    // dotted token record can never carry a value in these fields, so a lock or a clear on one
    // is meaningless and answers the same way.
    it('refuses a dotted TICK even when the opt-in only locks the fields', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: 'JDOG.SUB', LOCK_BRIDGE: 1 });
        expect(hasErrorCode(errors, 'ISSUE_CONSTRAINT')).to.be.true;
    });

    it('leaves a dotted TICK alone on every other ISSUE format', function () {
        const errors = v.validate('ISSUE', { VERSION: 1, TICK: 'JDOG.SUB', DESCRIPTION: 'a child token' });
        expect(hasNoErrorCode(errors, 'ISSUE_CONSTRAINT')).to.be.true;
    });

});

describe('Validator: ISSUE v7 bridge opt-in fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


    // An absent VERSION is auto-selected downstream and these three fields exist on
    // format 7 alone, so carrying one of them is the format.
    it('applies the subasset refusal when VERSION is absent but a bridge field is carried', function () {
        const errors = v.validate('ISSUE', { TICK: 'JDOG.SUB', MIN_DEPTH: '6' });
        expect(hasErrorCode(errors, 'ISSUE_CONSTRAINT')).to.be.true;
    });

    it('says nothing about a plain ISSUE that carries no bridge field', function () {
        const errors = v.validate('ISSUE', { TICK: 'JDOG.SUB', DESCRIPTION: 'a child token' });
        expect(hasNoErrorCode(errors, 'ISSUE_CONSTRAINT')).to.be.true;
    });

    // The handler judges the RESOLVED name, which a '^id' reference does not carry:
    // that refusal needs the token record and belongs to the pre-flight, so nothing is
    // asserted about it here rather than guessed at.
    it('says nothing about a ^<id> reference, whose row only the pre-flight can resolve', function () {
        const errors = v.validate('ISSUE', { VERSION: 7, TICK: '^12', BRIDGE_CHAINS: 'DOGE' });
        expect(hasNoErrorCode(errors, 'ISSUE_CONSTRAINT')).to.be.true;
    });

    it('accepts a well-formed opt-in on a top-level tick', function () {
        const errors = v.validate('ISSUE', {
            VERSION:       7,
            TICK:          'JDOG',
            BRIDGE_CHAINS: 'DOGE,LTC',
            MIN_DEPTH:     '6',
            LOCK_BRIDGE:   1
        });
        expect(errors).to.deep.equal([]);
    });
});
