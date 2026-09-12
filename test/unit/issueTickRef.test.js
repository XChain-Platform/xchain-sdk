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
 * XChain Platform SDK - the `^<id>` ISSUE TICK contract, per format.
 *
 * The validator refused EVERY caret-led ISSUE TICK on every format, which is
 * stricter than consensus: the handler resolves a caret TICK through getTickerId
 * exactly as it resolves a spelled-out name, so the client was refusing edits the
 * chain accepts, and the ticker compactor holds ISSUE.TICK back because of it.
 *
 * The rules asserted here are the handler's, with its line numbers:
 *   - every format: a non-numeric id is `invalid: TICK (id)`
 *     (xchain-indexer/src/actions/issue.js:349);
 *   - every format: a '.' inside the id is `invalid: TICK (caret dot)`
 *     (issue.js:361) - the shape the handler's own parseFloat-based isNumeric
 *     lets through;
 *   - formats 6 and 7 ONLY: the id must be canonical, because resolution is
 *     canonical-only (xchain-indexer/src/db.js:4090) and those two formats refuse
 *     an unresolved tick outright (issue.js:782 and issue.js:828,
 *     `invalid: TICK (unknown)`). Formats 0 to 5 fall through to createToken and
 *     ACCEPT it, so refusing there would false-block an action consensus accepts.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const Validator  = require('../../src/validator.js');

function createValidator() {
    return new Validator(new Utility());
}

function codes(errors) {
    return errors.map(e => e.code);
}

function hasErrorCode(errors, code) {
    return errors.some(e => e.code === code);
}

describe('Validator: caret ^<id> ISSUE TICK, gated by format', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    describe('accepted where consensus accepts it', function () {

        // The edit formats. Each carries the field set that selects it, so the
        // action is the real shape a caller builds, not a bare TICK.
        const EDITS = [
            { label: 'format 1 (description edit)', fields: { VERSION: 1, TICK: '^12', DESCRIPTION: 'new desc' } },
            { label: 'format 2 (mint params)',      fields: { VERSION: 2, TICK: '^12', MAX_MINT: '10' } },
            { label: 'format 3 (lock params)',      fields: { VERSION: 3, TICK: '^12', LOCK_MAX_SUPPLY: '1' } },
            { label: 'format 4 (callback params)',  fields: { VERSION: 4, TICK: '^12', CALLBACK_BLOCK: '100' } },
            { label: 'format 5 (list params)',      fields: { VERSION: 5, TICK: '^12', ALLOW_LIST: '1' } },
            { label: 'format 6 (controller bind)',  fields: { VERSION: 6, TICK: '^12', CONTROLLER: '1', ACTION_CLASS: 'transfer' } },
            { label: 'format 7 (bridge opt-in)',    fields: { VERSION: 7, TICK: '^12', BRIDGE_CHAINS: 'DOGE' } },
        ];

        for (const { label, fields } of EDITS) {
            it('accepts a canonical ^<id> on ' + label, function () {
                const errors = v.validate('ISSUE', fields);
                expect(codes(errors), label).to.not.include('INVALID_TICK_ID');
                expect(codes(errors), label).to.not.include('INVALID_TICK_NAME');
            });
        }

        // Format 0 is create-or-edit: a caret names an existing row, which the
        // handler resolves and re-issues from. issue.js has no create-only caret
        // refusal, so neither does this.
        it('accepts a canonical ^<id> on format 0 (create-or-edit)', function () {
            const errors = v.validate('ISSUE', { VERSION: 0, TICK: '^1234', MAX_SUPPLY: '1000', DECIMALS: '0' });
            expect(codes(errors)).to.not.include('INVALID_TICK_ID');
            expect(codes(errors)).to.not.include('INVALID_TICK_NAME');
        });

        it('accepts a canonical ^<id> when VERSION is absent and downstream selects the format', function () {
            const errors = v.validate('ISSUE', { TICK: '^1234', DESCRIPTION: 'edit by id' });
            expect(codes(errors)).to.not.include('INVALID_TICK_ID');
            expect(codes(errors)).to.not.include('INVALID_TICK_NAME');
        });

        // A large id must survive as a digit string: the handler hands it to SQL
        // verbatim rather than through Number(), so precision is not the client's
        // to lose either.
        it('accepts an id wider than Number.MAX_SAFE_INTEGER', function () {
            const errors = v.validate('ISSUE', { VERSION: 7, TICK: '^90071992547409911', BRIDGE_CHAINS: 'DOGE' });
            expect(codes(errors)).to.not.include('INVALID_TICK_ID');
        });
    });

    describe('refused on EVERY format, as the handler refuses it before it branches', function () {

        // issue.js:349 - the id must be numeric.
        it('refuses a non-numeric id on an edit format', function () {
            for (const version of [0, 1, 2, 3, 4, 5, 6, 7]) {
                const errors = v.validate('ISSUE', { VERSION: version, TICK: '^ABC' });
                expect(hasErrorCode(errors, 'INVALID_TICK_ID'), 'version: ' + version).to.be.true;
            }
        });

        it('refuses a bare caret with no id', function () {
            const errors = v.validate('ISSUE', { VERSION: 1, TICK: '^', DESCRIPTION: 'x' });
            expect(hasErrorCode(errors, 'INVALID_TICK_ID')).to.be.true;
        });

        // issue.js:361 - a '.' inside the id, which isNumeric lets through.
        it('refuses a dotted id on every format, including the permissive ones', function () {
            for (const version of [0, 1, 2, 3, 4, 5, 6, 7]) {
                for (const tick of ['^12.5', '^1.0', '^0.1']) {
                    const errors = v.validate('ISSUE', { VERSION: version, TICK: tick });
                    expect(hasErrorCode(errors, 'INVALID_TICK_ID'), 'version ' + version + ' tick ' + tick).to.be.true;
                }
            }
        });

        // TICK opts out of the blanket delimiter guard in favour of its own
        // validation, so the caret branch has to run the scan itself: a '|' or ';'
        // inside the id would otherwise be serialized straight into the wire string.
        it('refuses a delimiter inside the id, under the delimiter code', function () {
            for (const tick of ['^1|100', '^1;SEND']) {
                const errors = v.validate('ISSUE', { VERSION: 1, TICK: tick, DESCRIPTION: 'x' });
                expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER'), 'tick: ' + tick).to.be.true;
            }
        });
    });

    describe('the format gate: non-canonical ids', function () {

        // Resolution is canonical-only (db.js:4090), so `^007` and `^0` name no row
        // anywhere. Formats 6 and 7 turn that into `invalid: TICK (unknown)` on every
        // plane at every height, so the client can say so without false-blocking.
        const NON_CANONICAL = ['^007', '^0', '^-1'];

        it('refuses a non-canonical id on format 7 (bridge opt-in)', function () {
            for (const tick of NON_CANONICAL) {
                const errors = v.validate('ISSUE', { VERSION: 7, TICK: tick, BRIDGE_CHAINS: 'DOGE' });
                expect(hasErrorCode(errors, 'INVALID_TICK_ID'), 'tick: ' + tick).to.be.true;
            }
        });

        it('refuses a non-canonical id on format 6 (controller bind)', function () {
            for (const tick of NON_CANONICAL) {
                const errors = v.validate('ISSUE', { VERSION: 6, TICK: tick, CONTROLLER: '1', ACTION_CLASS: 'transfer' });
                expect(hasErrorCode(errors, 'INVALID_TICK_ID'), 'tick: ' + tick).to.be.true;
            }
        });

        // The same id on a format the chain accepts it on must NOT be refused:
        // issue.js falls through to createToken there, so an error would block an
        // action consensus lets through (spec §4.2 false-block invariant).
        it('accepts the same non-canonical ids on formats 0 to 5, which consensus accepts', function () {
            for (const version of [0, 1, 2, 3, 4, 5]) {
                for (const tick of NON_CANONICAL) {
                    const errors = v.validate('ISSUE', { VERSION: version, TICK: tick });
                    expect(codes(errors), 'version ' + version + ' tick ' + tick).to.not.include('INVALID_TICK_ID');
                }
            }
        });

        // VERSION is auto-selected downstream, so the fields that only format 7 (and
        // only format 6) can carry have to stand in for it, or the gate is skipped by
        // every caller who lets the SDK pick the format.
        it('recovers format 7 from a bridge field when VERSION is absent', function () {
            for (const field of ['BRIDGE_CHAINS', 'MIN_DEPTH', 'LOCK_BRIDGE']) {
                const fields = { TICK: '^007' };
                fields[field] = field === 'BRIDGE_CHAINS' ? 'DOGE' : '1';
                const errors = v.validate('ISSUE', fields);
                expect(hasErrorCode(errors, 'INVALID_TICK_ID'), 'field: ' + field).to.be.true;
            }
        });

        it('recovers format 6 from a controller field when VERSION is absent', function () {
            const errors = v.validate('ISSUE', { TICK: '^007', CONTROLLER: '1', ACTION_CLASS: 'transfer' });
            expect(hasErrorCode(errors, 'INVALID_TICK_ID')).to.be.true;
        });
    });

    describe('the name branch is untouched', function () {

        it('still refuses a caret that is not the first character as a bad NAME', function () {
            // '^' is inside the consensus TICK_CHARACTERS set, so mid-name it is a
            // legal name character and nothing here may refuse it.
            const errors = v.validate('ISSUE', { TICK: 'A^B' });
            expect(codes(errors)).to.not.include('INVALID_TICK_ID');
            expect(codes(errors)).to.not.include('INVALID_TICK_NAME');
        });

        it('still refuses an ordinary bad name under the name code', function () {
            const errors = v.validate('ISSUE', { TICK: 'BAD/TOKEN' });
            expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
        });
    });
});
