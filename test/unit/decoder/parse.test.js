'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decoder.parse unit suite: spec §3.1 parse rules 1-8 (each rule is a
// test), failure codes, multi-leg array collection, rest-fields, and
// the never-throws contract for malformed input.

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const { MAX_ACTION_DATA_LENGTH } = require('../../../src/chunkHelper.js');

describe('decoder.parse', function () {

    describe('success shape', function () {
        it('parses a canonical SEND v0', function () {
            const r = parse('SEND|0|JDOG|1.5|bc1qexample|hi');
            expect(r.ok).to.equal(true);
            expect(r.action).to.equal('SEND');
            expect(r.version).to.equal(0);
            expect(r.params).to.deep.equal({ TICK: 'JDOG', AMOUNT: '1.5', DESTINATION: 'bc1qexample', MEMO: 'hi' });
            expect(r.rest).to.equal(null);
            expect(r.commands).to.equal(null);
            expect(r.actionString).to.equal('SEND|0|JDOG|1.5|bc1qexample|hi');
            expect(r.validation).to.be.an('object');
        });

        it('rawAction present only when an alias was used', function () {
            expect(parse('TRANSFER|0|JDOG|1|a').rawAction).to.equal('TRANSFER');
            expect(parse('SEND|0|JDOG|1|a')).to.not.have.property('rawAction');
        });

        it('opts.validate=false skips validator findings', function () {
            const r = parse('SEND|0|JDOG|1|not-an-address', { validate: false });
            expect(r.ok).to.equal(true);
            expect(r.validation).to.equal(null);
        });

        it('validator findings attach but never flip ok (rule: findings are advisory)', function () {
            const r = parse('SEND|0|JDOG|1|not-an-address');
            expect(r.ok).to.equal(true);
            expect(r.validation.ok).to.equal(false);
            expect(r.validation.findings).to.not.be.empty;
        });
    });

    describe('rule 1: input-size gate first', function () {
        it('TOO_LONG on oversized input before any split', function () {
            const r = parse('X'.repeat(MAX_ACTION_DATA_LENGTH + 1));
            expect(r).to.deep.include({ ok: false, code: 'TOO_LONG' });
        });

        it('exactly MAX_ACTION_DATA_LENGTH passes the gate', function () {
            const r = parse('B'.repeat(MAX_ACTION_DATA_LENGTH));
            // Gate passed; fails later as UNKNOWN_ACTION, not TOO_LONG.
            expect(r.code).to.equal('UNKNOWN_ACTION');
        });

        it('gate measures bytes, not characters', function () {
            // 3-byte UTF-8 chars: char count under the cap, byte count over.
            const r = parse('€'.repeat(Math.floor(MAX_ACTION_DATA_LENGTH / 3) + 10));
            expect(r.code).to.equal('TOO_LONG');
        });
    });

    describe('rule 3: case-sensitive action names', function () {
        it('"send" is UNKNOWN_ACTION', function () {
            expect(parse('send|0|JDOG|1|a').code).to.equal('UNKNOWN_ACTION');
        });
        it('"transfer" (lowercase alias) is UNKNOWN_ACTION', function () {
            expect(parse('transfer|0|JDOG|1|a').code).to.equal('UNKNOWN_ACTION');
        });
    });

    describe('rule 4: alias expansion', function () {
        for (const [alias, canonical] of Object.entries({ TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' })) {
            it(`${alias} -> ${canonical}`, function () {
                const r = parse(`${alias}|0|x`);
                // Some alias targets may fail on field shape; the action
                // resolution is what this asserts.
                if (r.ok) expect(r.action).to.equal(canonical);
                else expect(r.code).to.not.equal('UNKNOWN_ACTION');
            });
        }

        it('canonical actionString rewrites the alias', function () {
            expect(parse('TRANSFER|0|JDOG|1|a').actionString).to.equal('SEND|0|JDOG|1|a');
        });
    });

    describe('rule 5: trailing empty fields', function () {
        it('short string fills missing tail with empty strings', function () {
            const r = parse('SEND|0|JDOG|1');
            expect(r.ok).to.equal(true);
            expect(r.params).to.deep.equal({ TICK: 'JDOG', AMOUNT: '1', DESTINATION: '', MEMO: '' });
        });

        it('ACTION|VERSION floor parses', function () {
            const r = parse('COLLECT|0');
            expect(r.ok).to.equal(true);
            // COLLECT v0 gained an optional trailing AMOUNT ; the missing
            // tail fills with an empty string like any short wire.
            expect(r.params).to.deep.equal({ AMOUNT: '' });
        });

        it('canonicalization trims trailing empties like the serializer', function () {
            // Within the field count, trailing empties trim; SEND v0 has 5
            // value slots so one trailing empty (MEMO) is legal.
            expect(parse('SEND|0|JDOG|1|addr|').actionString).to.equal('SEND|0|JDOG|1|addr');
        });

        it('trailing empties BEYOND the field count stay FIELD_COUNT_MISMATCH', function () {
            expect(parse('SEND|0|JDOG|1|addr||').code).to.equal('FIELD_COUNT_MISMATCH');
        });
    });

    describe('rule 6: rest-fields', function () {
        it('LIST v0 collects rest items', function () {
            const r = parse('LIST|0|1|AAA|BBB|CCC');
            expect(r.params.ITEM).to.deep.equal(['AAA', 'BBB', 'CCC']);
            expect(r.rest).to.deep.equal(['AAA', 'BBB', 'CCC']);
        });

        it('empty rest-field is an empty array (zero segments emitted)', function () {
            const r = parse('LIST|0|1');
            expect(r.ok).to.equal(true);
            expect(r.rest).to.deep.equal([]);
        });

        it('EXECUTE rest PARAMS', function () {
            const r = parse('EXECUTE|0|123|mint|alice|5');
            expect(r.params.PARAMS).to.deep.equal(['alice', '5']);
        });
    });

    describe('rule 7: no delimiter escaping / segment-count anomalies', function () {
        it('too many segments (no rest field) is FIELD_COUNT_MISMATCH', function () {
            const r = parse('MINT|0|JDOG|1|dest|memo|surplus');
            expect(r).to.deep.include({ ok: false, code: 'FIELD_COUNT_MISMATCH' });
        });
    });

    describe('multi-leg formats collect repeated fields into arrays', function () {
        it('SEND v1 (AMOUNT|DESTINATION repeated)', function () {
            const r = parse('SEND|1|JDOG|1|a|2|b|memo');
            expect(r.params).to.deep.equal({
                TICK: 'JDOG', AMOUNT: ['1', '2'], DESTINATION: ['a', 'b'], MEMO: 'memo',
            });
        });

        it('SEND v2 (TICK repeated too)', function () {
            const r = parse('SEND|2|T1|1|a|T2|2|b|m');
            expect(r.params.TICK).to.deep.equal(['T1', 'T2']);
        });
    });

    describe('version gate', function () {
        it('unknown version is UNKNOWN_VERSION', function () {
            expect(parse('SEND|9|JDOG|1|a').code).to.equal('UNKNOWN_VERSION');
        });
        it('missing version segment is UNKNOWN_VERSION', function () {
            expect(parse('SEND').code).to.equal('UNKNOWN_VERSION');
        });
        it('non-integer version is UNKNOWN_VERSION', function () {
            expect(parse('SEND|1.5|JDOG|1|a').code).to.equal('UNKNOWN_VERSION');
            expect(parse('SEND|x|JDOG|1|a').code).to.equal('UNKNOWN_VERSION');
        });
        it('PRICE v0 (validator-only, not in formats) refuses', function () {
            expect(parse('PRICE|0|BTC|JDOG|USD|1').code).to.equal('UNKNOWN_VERSION');
        });
    });

    describe('input forms', function () {
        it('empty string / null / undefined are EMPTY', function () {
            expect(parse('').code).to.equal('EMPTY');
            expect(parse(null).code).to.equal('EMPTY');
            expect(parse(undefined).code).to.equal('EMPTY');
        });

        it('Buffer input decodes as strict UTF-8', function () {
            const r = parse(Buffer.from('SEND|0|JDOG|1|addr', 'utf8'));
            expect(r.ok).to.equal(true);
            expect(r.action).to.equal('SEND');
        });

        it('truncated UTF-8 Buffer is BAD_UTF8, not a throw', function () {
            const bad = Buffer.concat([Buffer.from('SEND|0|'), Buffer.from([0xE2, 0x82])]);
            expect(parse(bad).code).to.equal('BAD_UTF8');
        });

        it('non-string/non-Buffer input never throws', function () {
            expect(parse(42).ok).to.equal(false);
            expect(parse({}).ok).to.equal(false);
        });
    });
});
