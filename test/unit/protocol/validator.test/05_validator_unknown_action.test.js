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
const Utility    = require('../../../../src/utils/utility.js');
const Validator  = require('../../../../src/protocol/validator.js');
const { SDKValidationError } = require('../../../../src/utils/errors.js');

function createValidator() {
    return new Validator(new Utility());
}

function hasNoErrorCode(errors, code) {
    return !errors.some(e => e.code === code);
}

function hasErrorCode(errors, code) {
    return errors.some(e => e.code === code);
}



// UNKNOWN ACTION

describe('Validator: unknown action', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('returns UNKNOWN_ACTION error for an unrecognised action type', function () {
        const errors = v.validate('FAKEACTION', {});
        expect(hasErrorCode(errors, 'UNKNOWN_ACTION')).to.be.true;
    });
});

// FIELD-LEVEL VALIDATION: COOLDOWN_BLOCKS / VALUE / DEPLOY / DISPENSER ownership

describe('Validator: field + cross-field constraints', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // COOLDOWN_BLOCKS (DEPLOY v1)
    it('rejects a non-numeric COOLDOWN_BLOCKS', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: 'abc' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        expect(errors.some(e => /COOLDOWN_BLOCKS must be numeric/.test(e.message))).to.be.true;
    });

    it('rejects a COOLDOWN_BLOCKS below the minimum (1)', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be in \[1, 100000\]/.test(e.message))).to.be.true;
    });

    it('rejects a COOLDOWN_BLOCKS above the maximum (100000)', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: '100001' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be in \[1, 100000\]/.test(e.message))).to.be.true;
    });

    it('accepts a COOLDOWN_BLOCKS within range', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: '500' });
        expect(errors.some(e => /COOLDOWN_BLOCKS/.test(e.message))).to.be.false;
    });

    // VALUE (BROADCAST)
    it('rejects a non-numeric VALUE', function () {
        const errors = v.validate('BROADCAST', { VALUE: 'not-a-number' });
        expect(errors.some(e => /VALUE must be numeric/.test(e.message))).to.be.true;
    });

});

describe('Validator: field + cross-field constraints', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


    // DEPLOY cross-field: SLASH_DESTINATION requires COOLDOWN_BLOCKS
    it('rejects DEPLOY with SLASH_DESTINATION but no COOLDOWN_BLOCKS', function () {
        const errors = v.validate('DEPLOY', { SLASH_DESTINATION: '1BurnAddrXXXXXXXXXXXXXXXXXXXXXXX' });
        expect(hasErrorCode(errors, 'DEPLOY_CONSTRAINT')).to.be.true;
    });

    it('accepts DEPLOY with both SLASH_DESTINATION and COOLDOWN_BLOCKS', function () {
        const errors = v.validate('DEPLOY', {
            SLASH_DESTINATION: '1BurnAddrXXXXXXXXXXXXXXXXXXXXXXX', COOLDOWN_BLOCKS: '100',
        });
        expect(hasErrorCode(errors, 'DEPLOY_CONSTRAINT')).to.be.false;
    });

    // DISPENSER ownership create-path: GIVE_AMOUNT / GIVE_ESCROW must be empty
    it('rejects an ownership DISPENSER carrying a GIVE_AMOUNT', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_OWNERSHIP: '1', GIVE_TICK: 'TOK', GET_AMOUNT: '5', GET_COIN: 'BTC',
            GIVE_AMOUNT: '10',
        });
        expect(errors.some(e => /GIVE_AMOUNT must be empty when GIVE_OWNERSHIP=1/.test(e.message))).to.be.true;
    });

    it('rejects an ownership DISPENSER carrying a GIVE_ESCROW', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_OWNERSHIP: '1', GIVE_TICK: 'TOK', GET_AMOUNT: '5', GET_COIN: 'BTC',
            GIVE_ESCROW: '3',
        });
        expect(errors.some(e => /GIVE_ESCROW must be empty when GIVE_OWNERSHIP=1/.test(e.message))).to.be.true;
    });
});

// CONTROLLER BIND/UNBIND VALIDATION (ISSUE v6 / ADDRESS v1, programmable policy)

describe('Validator: controller bind/unbind (ISSUE v6 / ADDRESS v1)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // CONTROLLER: non-negative integer (a contract ACTION_INDEX)
    it('accepts a non-negative integer CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '42', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.false;
    });
    it('rejects a negative CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '-1', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(errors.some(e => /CONTROLLER must be a non-negative integer/.test(e.message))).to.be.true;
    });
    it('rejects a non-integer CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '4.2', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(errors.some(e => /CONTROLLER must be a non-negative integer/.test(e.message))).to.be.true;
    });

    // ACTION_CLASS: must be one of {transfer, trade, burn, mint, stake}
    ['transfer', 'trade', 'burn', 'mint', 'stake'].forEach(cls => {
        it('accepts ACTION_CLASS=' + cls, function () {
            const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: cls, UNBIND: '0' });
            expect(errors.some(e => /ACTION_CLASS must be one of/.test(e.message))).to.be.false;
        });
    });
    it('rejects an unknown ACTION_CLASS', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: 'admin', UNBIND: '0' });
        expect(errors.some(e => /ACTION_CLASS must be one of/.test(e.message))).to.be.true;
    });

    // UNBIND: 0 or 1 only
    it('accepts UNBIND=0 and UNBIND=1', function () {
        expect(v.validate('ADDRESS', { CONTROLLER: '1', ACTION_CLASS: 'trade', UNBIND: '0' }).some(e => /UNBIND must be/.test(e.message))).to.be.false;
        expect(v.validate('ADDRESS', { ACTION_CLASS: 'trade', UNBIND: '1' }).some(e => /UNBIND must be/.test(e.message))).to.be.false;
    });
    it('rejects UNBIND=2', function () {
        const errors = v.validate('ADDRESS', { CONTROLLER: '1', ACTION_CLASS: 'trade', UNBIND: '2' });
        expect(errors.some(e => /UNBIND must be 0 .bind. or 1 .unbind./.test(e.message))).to.be.true;
    });

    // COOLDOWN_BLOCKS: non-negative integer on a controller bind (0 allowed)
});

describe('Validator: controller bind/unbind (ISSUE v6 / ADDRESS v1)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


    it('accepts COOLDOWN_BLOCKS=0 on an ISSUE controller bind', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: 'mint', COOLDOWN_BLOCKS: '0', UNBIND: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS/.test(e.message))).to.be.false;
    });
    it('accepts COOLDOWN_BLOCKS=0 on an ADDRESS controller bind', function () {
        const errors = v.validate('ADDRESS', { CONTROLLER: '1', ACTION_CLASS: 'trade', COOLDOWN_BLOCKS: '0', UNBIND: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS/.test(e.message))).to.be.false;
    });
    it('rejects a negative COOLDOWN_BLOCKS on a controller bind', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: 'mint', COOLDOWN_BLOCKS: '-5', UNBIND: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be a non-negative integer/.test(e.message))).to.be.true;
    });
    it('still enforces the DEPLOY COOLDOWN_BLOCKS [1,100000] range', function () {
        const errors = v.validate('DEPLOY', { CODE_ENCODING: 'ab', GAS_LIMIT: '1', COOLDOWN_BLOCKS: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be in \[1, 100000\]/.test(e.message))).to.be.true;
    });

    // Bind/unbind interlock
    it('requires CONTROLLER on a bind (UNBIND=0)', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(errors.some(e => /CONTROLLER is required to bind/.test(e.message))).to.be.true;
    });
    it('requires ACTION_CLASS whenever controller fields are present', function () {
        const errors = v.validate('ADDRESS', { CONTROLLER: '1', UNBIND: '0' });
        expect(errors.some(e => /ACTION_CLASS is required for a controller bind\/unbind/.test(e.message))).to.be.true;
    });
    it('allows an unbind (UNBIND=1) with no CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', ACTION_CLASS: 'burn', UNBIND: '1' });
        expect(errors.some(e => /CONTROLLER is required to bind/.test(e.message))).to.be.false;
    });
    it('leaves a plain ISSUE (no controller fields) unaffected by the interlock', function () {
        const errors = v.validate('ISSUE', { TICK: 'PLAIN', DESCRIPTION: 'hi' });
        expect(errors.some(e => /controller bind/.test(e.message))).to.be.false;
        expect(errors.some(e => /CONTROLLER is required/.test(e.message))).to.be.false;
    });
});

// ADDRESS ^id REFERENCE VALIDATION (address compaction)

describe('Validator: address ^id reference', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a numeric ^id in DESTINATION (no crypto-address error)', function () {
        const errors = v.validate('SEND', { TICK: 'JDOG', AMOUNT: '1', DESTINATION: '^57' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        expect(hasNoErrorCode(errors, 'INVALID_ADDRESS_ID')).to.be.true;
    });

    it('accepts a numeric ^id in GET_ADDRESS', function () {
        const errors = v.validate('DISPENSER', { GIVE_TICK: 'JDOG', GIVE_QUANTITY: '1', ESCROW_QUANTITY: '1', MAINCHAINRATE: '1', GET_ADDRESS: '^900' });
        expect(hasNoErrorCode(errors, 'INVALID_ADDRESS_ID')).to.be.true;
    });

    it('rejects a non-numeric ^id with INVALID_ADDRESS_ID', function () {
        const errors = v.validate('SEND', { TICK: 'JDOG', AMOUNT: '1', DESTINATION: '^notanumber' });
        expect(hasErrorCode(errors, 'INVALID_ADDRESS_ID')).to.be.true;
    });

    it('still rejects a malformed full address in DESTINATION', function () {
        const errors = v.validate('SEND', { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'not-an-address!!' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// PC-29: FILE.GATE_MIN_AMOUNT (the unlock threshold)
//
// A ninth, optional FILE field. Every rule here is a FORMAT rule and every one
// exists for a reason worth stating, because the value is consensus-visible and
// lands in a VARCHAR(40): a value this validator lets through must be one the
// indexer can store and compare without the DB changing it.
//
// Divisibility is deliberately absent. The real bound is
// min(gate tick divisibility, THRESHOLD_SCALE), and divisibility is chain STATE
// at the FILE's block, which a stateless validator does not have. The indexer is
// the arbiter for that half; a guess here would be a second, weaker opinion that
// disagrees at exactly the boundary the shared vectors exist to pin.

describe('Validator: FILE GATE_MIN_AMOUNT (PC-29)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const bad = (value) => v.validate('FILE', { NAME: 'f.txt', TYPE: 'text/plain', GATE_MIN_AMOUNT: value });
    const isRejected = (value) => !hasNoErrorCode(bad(value), 'INVALID_FIELD_VALUE');

    it('accepts an absent or empty threshold (= no threshold)', function () {
        expect(hasNoErrorCode(v.validate('FILE', { NAME: 'f.txt', TYPE: 'text/plain' }), 'INVALID_FIELD_VALUE')).to.be.true;
        expect(isRejected(''), 'empty means no threshold, not an invalid one').to.be.false;
    });

    it('accepts ordinary decimal amounts', function () {
        for (const ok of ['1', '100', '0.5', '0.00000001', '12345.6789', '1.0'])
            expect(isRejected(ok), ok).to.be.false;
    });

    it('rejects every spelling of zero', function () {
        // A zero threshold is not "no threshold"; it is a threshold nobody can fail.
        // Letting it through would give one meaning two encodings.
        for (const z of ['0', '0.0', '0.00000000'])
            expect(isRejected(z), z).to.be.true;
    });

    it('rejects signs and exponents', function () {
        for (const s of ['-1', '+1', '1e3', '1E3', '-0.5'])
            expect(isRejected(s), s).to.be.true;
    });

    it('rejects malformed decimal shapes', function () {
        for (const s of ['1.', '.5', '1.2.3', '1,5', '1 ', ' 1', 'abc', '1a'])
            expect(isRejected(s), JSON.stringify(s)).to.be.true;
    });

    it('rejects leading zeros so one value has exactly one spelling', function () {
        // '01' and '1' would otherwise be two byte-different FILEs meaning the same
        // threshold, which the shared P1/P9 vectors treat as a defect.
        for (const s of ['01', '007', '00.5'])
            expect(isRejected(s), s).to.be.true;
        expect(isRejected('0.5'), 'a single leading zero before the point is correct').to.be.false;
    });

    it('rejects a pipe, which would split the wire record', function () {
        expect(isRejected('1|2')).to.be.true;
    });

});

describe('Validator: FILE GATE_MIN_AMOUNT (PC-29)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const bad = (value) => v.validate('FILE', { NAME: 'f.txt', TYPE: 'text/plain', GATE_MIN_AMOUNT: value });
    const isRejected = (value) => !hasNoErrorCode(bad(value), 'INVALID_FIELD_VALUE');


    it('enforces the 40-character bound the storage column depends on', function () {
        const forty = '1'.repeat(40);
        expect(isRejected(forty), '40 is allowed').to.be.false;
        expect(isRejected('1'.repeat(41)), '41 is not').to.be.true;
        // The bound is a WIRE rule, not merely a column width: if an oversized value
        // reached a VARCHAR(40) it could be silently truncated, and consensus validity
        // would then depend on the DB's mode rather than on the bytes.
        expect(isRejected('0.' + '1'.repeat(45))).to.be.true;
    });

    it('does NOT reject on divisibility, which is the indexer\'s call', function () {
        // 30 decimal places is beyond any tick's divisibility, but this validator is
        // stateless and must not pretend to know. It is a well-formed decimal, so it
        // passes here and the indexer rejects it against the gate tick at that block.
        expect(isRejected('0.' + '1'.repeat(30)), 'stateless layer must stay silent on divisibility').to.be.false;
    });

    it('applies only to FILE, not to other actions carrying a like-named field', function () {
        const errors = v.validate('SEND', { GATE_MIN_AMOUNT: '0' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

});

describe('Validator: FILE GATE_MIN_AMOUNT (PC-29)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const bad = (value) => v.validate('FILE', { NAME: 'f.txt', TYPE: 'text/plain', GATE_MIN_AMOUNT: value });
    const isRejected = (value) => !hasNoErrorCode(bad(value), 'INVALID_FIELD_VALUE');


    // ── Shared vector fixture group 6.5
    // The tests above are this repo's own reading of the rules. These run the SAME
    // vectors the indexer and the wallet run, from a byte-identical file, so the
    // three implementations are pinned to one another rather than to three
    // independently-written test suites that agree today by coincidence.
    describe('shared GATE_MIN_AMOUNT vectors', function () {
        const fs      = require('fs');
        const path    = require('path');
        const FIXTURE = path.join(__dirname, '../../../fixtures/gate-min-amount-vectors.json');
        const vectors = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

        it('the fixture carries vectors in every section (it has not been emptied)', function () {
            for (const key of ['format', 'divisibility', 'pack_threshold', 'handoff_required'])
                expect(vectors[key], key).to.be.an('array').with.length.greaterThan(0);
        });

        for (const vec of vectors.format) {
            it(`${vec.label}: ${JSON.stringify(vec.value)} is ${vec.valid ? 'accepted' : 'rejected'}`, function () {
                expect(isRejected(vec.value)).to.equal(!vec.valid);
            });
        }

        // The asymmetry the shared fixture exposed: setActionParams trims every action
        // field on the indexer's way in, so a whitespace-padded threshold reaches
        // consensus already trimmed and is ACCEPTED there, while this layer refuses to
        // emit it. Pinned on both sides so the difference stays deliberate: closing it
        // would mean changing the trim for every field of every action.
    });
});
