'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decoder.parse DoS/fuzz corpus (spec §3.5.1): multi-MB inputs,
// delimiter-dense strings, truncated UTF-8, deep fake-BATCH nesting,
// and random garbage. Invariants: parse never throws, and pathological
// inputs are rejected fast (the size gate runs before any split).

const { expect } = require('chai');
const { parse } = require('../../src/decoder/parse.js');

// Deterministic PRNG so failures reproduce (no Math.random in corpus).
function lcg(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

describe('decoder.parse fuzz/DoS corpus @fuzz', function () {

    it('multi-MB input rejects fast via the size gate', function () {
        const big = 'SEND|0|' + 'A'.repeat(4 * 1024 * 1024);
        const t0 = process.hrtime.bigint();
        const r = parse(big);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        expect(r.code).to.equal('TOO_LONG');
        expect(ms).to.be.below(50);
    });

    it('multi-MB Buffer rejects before UTF-8 decode', function () {
        const r = parse(Buffer.alloc(8 * 1024 * 1024, 0x41));
        expect(r.code).to.equal('TOO_LONG');
    });

    it('delimiter-dense strings never throw', function () {
        expect(() => parse('|'.repeat(8000))).to.not.throw();
        expect(() => parse(';'.repeat(8000))).to.not.throw();
        expect(() => parse(('|;').repeat(4000))).to.not.throw();
        expect(parse('|'.repeat(8000)).ok).to.equal(false);
    });

    it('pipe-flood inside BATCH COMMAND never throws', function () {
        const r = parse('BATCH|0|' + '|'.repeat(8000));
        expect(r.ok).to.equal(true);
        // Every sub-entry is a failed parse; the outer result stands.
        expect(r.commands.every(c => c.ok === false)).to.equal(true);
    });

    it('semicolon-flood inside BATCH COMMAND (many empty commands)', function () {
        const r = parse('BATCH|0|' + ';'.repeat(7000));
        expect(r.ok).to.equal(true);
        expect(r.commands.length).to.equal(7001);
    });

    it('deep fake-BATCH nesting is rejected without recursion blowup', function () {
        // "BATCH|0|BATCH|0|BATCH|0|..." - only ONE level of recursion
        // ever runs (the first nested BATCH aborts the outer parse).
        const deep = Array(500).fill('BATCH|0').join('|') + '|SEND|0|A|1|x';
        const r = parse(deep);
        expect(r.ok).to.equal(false);
        expect(r.code).to.equal('NESTED_BATCH_FORBIDDEN');
    });

    it('truncated/overlong UTF-8 buffers are BAD_UTF8', function () {
        const cases = [
            Buffer.from([0x53, 0x45, 0x4E, 0x44, 0x7C, 0xE2, 0x82]),        // truncated 3-byte seq
            Buffer.from([0x53, 0xC0, 0xAF]),                                 // overlong encoding
            Buffer.from([0xFF, 0xFE, 0x53]),                                 // invalid lead bytes
        ];
        for (const buf of cases) {
            const r = parse(buf);
            expect(r.ok).to.equal(false);
            expect(r.code).to.equal('BAD_UTF8');
        }
    });

    it('1000 random garbage strings never throw', function () {
        const rand = lcg(0xC0FFEE);
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789|;.:^~!@#$%&*(){}[]<>?/\\\'"\n\t ‮​€漢';
        for (let i = 0; i < 1000; i++) {
            const len = 1 + Math.floor(rand() * 200);
            let s = '';
            for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
            expect(() => parse(s), JSON.stringify(s)).to.not.throw();
        }
    });

    it('1000 random mutations of a valid wire string never throw and stay classified', function () {
        const rand = lcg(0xBEEF);
        const base = 'SEND|0|JDOG|1.5|bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4|memo';
        for (let i = 0; i < 1000; i++) {
            const pos = Math.floor(rand() * base.length);
            const ch = String.fromCharCode(Math.floor(rand() * 0x2FFF));
            const mutated = base.slice(0, pos) + ch + base.slice(pos + 1);
            let r;
            expect(() => { r = parse(mutated); }).to.not.throw();
            expect(r).to.have.property('ok');
        }
    });
});
