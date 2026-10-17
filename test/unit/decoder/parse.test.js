'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decoder.parse unit suite: spec §3.1 parse rules 1-8 (each rule is a
// test), failure codes, multi-leg array collection, rest-fields, and
// the never-throws contract for malformed input.

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const { MAX_ACTION_DATA_LENGTH } = require('../../../src/contract/chunk_helper.js');

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
});

describe('decoder.parse', function () {

    describe('rule 1: input-size gate first', function () {
        it('TOO_LONG on oversized input before any split', function () {
            const r = parse('X'.repeat(MAX_ACTION_DATA_LENGTH + 1), { carrier: 'P2SH' });
            expect(r).to.deep.include({ ok: false, code: 'TOO_LONG' });
        });

        it('the largest string whose compiled push fits passes the gate', function () {
            // The cap bounds the COMPILED push (payload plus a 3-byte OP_PUSHDATA2
            // prefix at this size), exactly as the on-chain decoder measures it.
            const r = parse('B'.repeat(MAX_ACTION_DATA_LENGTH - 3), { carrier: 'P2SH' });
            // Gate passed; fails later as UNKNOWN_ACTION, not TOO_LONG.
            expect(r.code).to.equal('UNKNOWN_ACTION');
        });

        it('raw bytes under the cap whose compiled push is over it are TOO_LONG', function () {
            for (const carrier of ['OP_RETURN', 'P2SH', 'P2WSH', 'MULTISIGN'])
                for (const n of [MAX_ACTION_DATA_LENGTH - 2, MAX_ACTION_DATA_LENGTH])
                    expect(parse('B'.repeat(n), { carrier }).code, carrier + ' ' + n).to.equal('TOO_LONG');
        });

        it('gate measures bytes, not characters', function () {
            // 3-byte UTF-8 chars: char count under the cap, byte count over.
            const r = parse('€'.repeat(Math.floor(MAX_ACTION_DATA_LENGTH / 3) + 10), { carrier: 'P2SH' });
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
});

describe('decoder.parse', function () {

    describe('rule 1: input-size gate first', function () {
        it('the Taproot envelope, or no named carrier, is bound only by the envelope ceiling', function () {
            const { ENVELOPE_MAX_PAYLOAD } = require('../../../src/protocol/constants.js');
            for (const carrier of ['TAPROOT', undefined]) {
                expect(parse('B'.repeat(20000), { carrier }).code, String(carrier)).to.equal('UNKNOWN_ACTION');
                // 390,000 bytes compile with a 5-byte OP_PUSHDATA4 prefix, so the
                // largest that fits is 389,995.
                expect(parse('B'.repeat(ENVELOPE_MAX_PAYLOAD - 5), { carrier }).code).to.equal('UNKNOWN_ACTION');
                expect(parse('B'.repeat(ENVELOPE_MAX_PAYLOAD - 4), { carrier }).code).to.equal('TOO_LONG');
            }
        });

        it('flags a result no legacy carrier could hold when no carrier is named', function () {
            const r = parse('BROADCAST|0|' + 'm'.repeat(MAX_ACTION_DATA_LENGTH));
            expect([r.ok, r.legacyCarrierFits]).to.deep.equal([true, false]);
            expect(parse('BROADCAST|0|m').legacyCarrierFits).to.equal(undefined);
        });

        it('strictWire keeps the raw-length gate', function () {
            const head = 'BROADCAST|0|';
            const at = (n) => parse(head + 'm'.repeat(n - head.length), { strictWire: true, validate: false });
            expect(at(MAX_ACTION_DATA_LENGTH).ok).to.equal(true);
            expect(at(MAX_ACTION_DATA_LENGTH + 1).code).to.equal('TOO_LONG');
        });
    });
});

describe('decoder.parse', function () {

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
            // COLLECT v0 gained an optional trailing AMOUNT; the missing tail
            // fills with an empty string like any short wire.
            expect(r.params).to.deep.equal({ AMOUNT: '' });
        });

        it('canonicalization trims trailing empties like the serializer', function () {
            // Within the field count, trailing empties trim; SEND v0 has 5
            // value slots so one trailing empty (MEMO) is legal.
            expect(parse('SEND|0|JDOG|1|addr|').actionString).to.equal('SEND|0|JDOG|1|addr');
        });

        it('trailing empties BEYOND the field count are ignored, as the indexer ignores them', function () {
            const r = parse('SEND|0|JDOG|1|addr||');
            expect(r.ok).to.equal(true);
            expect(r.ignoredSegments).to.deep.equal(['']);
            expect(r.actionString).to.equal('SEND|0|JDOG|1|addr');
        });

        it('strictWire keeps trailing empties beyond the field count a FIELD_COUNT_MISMATCH', function () {
            expect(parse('SEND|0|JDOG|1|addr||', { strictWire: true }).code).to.equal('FIELD_COUNT_MISMATCH');
        });
    });
});

describe('decoder.parse', function () {

    describe('rule 6: rest-fields', function () {
        it('LIST v0 collects rest items', function () {
            // MEMO holds the slot before the rest-field, empty here.
            const r = parse('LIST|0|1||AAA|BBB|CCC');
            expect(r.params.ITEM).to.deep.equal(['AAA', 'BBB', 'CCC']);
            expect(r.rest).to.deep.equal(['AAA', 'BBB', 'CCC']);
        });

        it('LIST v0 MEMO is a fixed field, not the first rest item', function () {
            const r = parse('LIST|0|1|why this list exists|AAA|BBB');
            expect(r.params.MEMO).to.equal('why this list exists');
            expect(r.params.ITEM).to.deep.equal(['AAA', 'BBB']);
            expect(r.rest).to.deep.equal(['AAA', 'BBB']);
        });

        it('LIST v1 MEMO sits after LIST_ACTION_INDEX and before the items', function () {
            const r = parse('LIST|1|1|1234|adding two|AAA|BBB');
            expect(r.params.EDIT).to.equal('1');
            expect(r.params.LIST_ACTION_INDEX).to.equal('1234');
            expect(r.params.MEMO).to.equal('adding two');
            expect(r.params.ITEM).to.deep.equal(['AAA', 'BBB']);
        });

        it('empty rest-field is an empty array (zero segments emitted)', function () {
            const r = parse('LIST|0|1|');
            expect(r.ok).to.equal(true);
            expect(r.rest).to.deep.equal([]);
        });

        it('EXECUTE rest PARAMS', function () {
            const r = parse('EXECUTE|0|123|mint|alice|5');
            expect(r.params.PARAMS).to.deep.equal(['alice', '5']);
        });
    });

    describe('rule 7: no delimiter escaping / segment-count anomalies', function () {
        it('too many segments (no rest field) are ignored and reported back', function () {
            const r = parse('MINT|0|JDOG|1|dest|memo|surplus');
            expect(r.ok).to.equal(true);
            expect(r.ignoredSegments).to.deep.equal(['surplus']);
            expect(r.actionString).to.equal('MINT|0|JDOG|1|dest|memo');
        });

        it('strictWire refuses too many segments as FIELD_COUNT_MISMATCH', function () {
            const r = parse('MINT|0|JDOG|1|dest|memo|surplus', { strictWire: true });
            expect(r).to.deep.include({ ok: false, code: 'FIELD_COUNT_MISMATCH' });
        });
    });
});

describe('decoder.parse', function () {

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
        it('a missing version segment reads as VERSION 0, as on the indexer', function () {
            const r = parse('SEND');
            expect(r.ok).to.equal(true);
            expect(r.version).to.equal(0);
            expect(r.legacyVersion).to.equal(true);
            expect(parse('SEND', { strictWire: true }).code).to.equal('UNKNOWN_VERSION');
        });
        it('a non-integer version is UNKNOWN_VERSION where no legacy shift applies', function () {
            expect(parse('ORDER|1.5|1|m').code).to.equal('UNKNOWN_VERSION');
            expect(parse('BROADCAST|x|hi').code).to.equal('UNKNOWN_VERSION');
            expect(parse('SEND|1.5|JDOG|1|a', { strictWire: true }).code).to.equal('UNKNOWN_VERSION');
            expect(parse('SEND|x|JDOG|1|a', { strictWire: true }).code).to.equal('UNKNOWN_VERSION');
        });
        it('PRICE v0 (validator-only, not in formats) refuses', function () {
            expect(parse('PRICE|0|BTC|JDOG|USD|1').code).to.equal('UNKNOWN_VERSION');
        });
        it('a token the indexer shifts or reads differently is read the indexer\'s way', function () {
            // ISSUE/MINT/SEND: a token longer than two characters, or non-numeric,
            // is a legacy TICK with VERSION 0 injected in front of it.
            for (const s of ['SEND|000|A|1|x', 'SEND||A|1|x', 'SEND|0e0|A|1|x']) {
                const r = parse(s);
                expect([r.version, r.legacyVersion, r.params.TICK], s).to.deep.equal([0, true, s.split('|')[1]]);
            }
            // Elsewhere the token goes through getFormatVersion's parseInt.
            expect(parse('ORDER|0o2|1|m').version).to.equal(0);
            expect(parse('ORDER|1e1|1|m').version).to.equal(1);
            expect(parse('SEND|01|JDOG|1|a|b|c').version).to.equal(1);
            // The co-signer's strict reading still refuses every one of them.
            for (const s of ['SEND|000|A|1|x', 'SEND||A|1|x', 'SEND|0e0|A|1|x', 'ORDER|0o2|1|m', 'ORDER|1e1|1|m'])
                expect(parse(s, { strictWire: true }).code, s).to.equal('UNKNOWN_VERSION');
        });
        it('every accepted VERSION token reads the same on the indexer', function () {
            const { isLegacyActionFormat } = require('../../../src/protocol/batch_limits/limit_tables.js');
            const { parseVersion } = require('../../../src/decoder/parse/field_mapping.js');
            const tokens = Array.from({ length: 100 }, (_, i) => String(i)).concat(['00', '01', '000', '0x0', '0b1', '.0', '-0']);
            for (const t of tokens.filter((t) => parseVersion(t) !== null))
                expect([isLegacyActionFormat([t]), parseInt(t, 10)], t).to.deep.equal([false, parseVersion(t)]);
        });
    });
});

describe('decoder.parse', function () {

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
