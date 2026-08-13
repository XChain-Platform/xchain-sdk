'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decoder.parse BATCH sub-grammar suite (spec §3.1 rule 8): 3-way
// split, ';'-joined complete sub-actions, nested-BATCH refusal,
// per-command failure isolation, and per-type caps as validation
// findings.

const { expect } = require('chai');
const { parse, BATCH_ACTION_LIMITS, BATCH_COMMAND_LIMIT } = require('../../../src/decoder/parse.js');

describe('decoder.parse - BATCH sub-grammar', function () {

    it('splits the tail on ";" and recurses the top-level parse per entry', function () {
        const r = parse('BATCH|0|SEND|0|JDOG|1|addr;MINT|0|JDOG|5');
        expect(r.ok).to.equal(true);
        expect(r.commands).to.have.length(2);
        expect(r.commands[0].action).to.equal('SEND');
        expect(r.commands[1].action).to.equal('MINT');
        expect(r.params.COMMAND).to.equal('SEND|0|JDOG|1|addr;MINT|0|JDOG|5');
    });

    it('COMMAND is verbatim: pipes inside sub-actions never mis-slice the top level', function () {
        const r = parse('BATCH|0|ISSUE|0|TOK|1000||0|desc');
        expect(r.ok).to.equal(true);
        expect(r.commands[0].action).to.equal('ISSUE');
        expect(r.commands[0].params.MAX_SUPPLY).to.equal('1000');
    });

    it('nested BATCH flips the OUTER result to NESTED_BATCH_FORBIDDEN', function () {
        const r = parse('BATCH|0|SEND|0|JDOG|1|a;BATCH|0|MINT|0|JDOG|1');
        expect(r).to.deep.include({ ok: false, code: 'NESTED_BATCH_FORBIDDEN' });
    });

    it('a non-BATCH sub-entry failure does NOT flip the outer result', function () {
        const r = parse('BATCH|0|SEND|0|JDOG|1|addr;NOPE|0|x');
        expect(r.ok).to.equal(true);
        expect(r.commands[0].ok).to.equal(true);
        expect(r.commands[1]).to.deep.include({ ok: false, code: 'UNKNOWN_ACTION' });
    });

    it('COMMAND present-but-empty is EMPTY_BATCH (parse failure)', function () {
        expect(parse('BATCH|0|').code).to.equal('EMPTY_BATCH');
    });

    it('COMMAND absent entirely: ok stays true with a validator finding', function () {
        const r = parse('BATCH|0');
        expect(r.ok).to.equal(true);
        expect(r.commands).to.deep.equal([]);
        expect(r.validation.ok).to.equal(false);
        expect(r.validation.findings.map(f => f.code)).to.include('MISSING_REQUIRED_FIELD');
    });

    it('per-command-type caps produce BATCH_LIMIT_EXCEEDED findings, not failures', function () {
        expect(BATCH_ACTION_LIMITS.MINT).to.equal(1);
        const r = parse('BATCH|0|MINT|0|JDOG|1;MINT|0|JDOG|2');
        expect(r.ok).to.equal(true);
        const codes = r.validation.findings.map(f => f.code);
        expect(codes).to.include('BATCH_LIMIT_EXCEEDED');
    });

    it('one MINT + one ISSUE is within caps (no limit finding)', function () {
        const r = parse('BATCH|0|MINT|0|JDOG|1;ISSUE|0|NEW|100');
        expect(r.ok).to.equal(true);
        expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
    });

    it('sub-command aliases expand and are case-sensitive', function () {
        const r = parse('BATCH|0|TRANSFER|0|JDOG|1|addr');
        expect(r.commands[0].action).to.equal('SEND');
        const r2 = parse('BATCH|0|transfer|0|JDOG|1|addr');
        expect(r2.commands[0]).to.deep.include({ ok: false, code: 'UNKNOWN_ACTION' });
    });

    it('a dotted-TICK ISSUE is exempt: a parent plus children is within caps', function () {
        const r = parse('BATCH|0|ISSUE|0|JDOG|1000;ISSUE|0|JDOG.1|1;ISSUE|0|JDOG.2|1');
        expect(r.ok).to.equal(true);
        expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
    });

    it('a caret TICK is never exempt, dot or no dot', function () {
        const r = parse('BATCH|0|ISSUE|0|^12.5|1;ISSUE|0|^13.6|1');
        const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
        expect(limit).to.exist;
        expect(limit.details).to.deep.include({ action: 'ISSUE', limit: 1, count: 2 });
    });

    it('counts entries that did NOT parse, the way the arbiter counts every command', function () {
        // The mirror used to count only the sub-entries it accepted, so a
        // malformed second ISSUE was free here and chargeable on-chain.
        const r = parse('BATCH|0|ISSUE|0|JDOG|1000;ISSUE|0|OTHER|1|||||||||||||||||||||||||||||||');
        expect(r.commands[1].ok).to.equal(false);
        const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
        expect(limit).to.exist;
        expect(limit.details.count).to.equal(2);
    });

    it('over the 250-command cap is a finding, and it is the ONLY one', function () {
        // Precedence: the arbiter checks the cap first and rejects the whole
        // batch, so a per-action finding beside it would name a rule the chain
        // never reached. This batch breaks both.
        const wire = 'BATCH|0|' + Array.from({ length: 251 }, (_, i) => 'ISSUE|0|T' + i + '|1').join(';');
        const r = parse(wire);
        const limits = r.validation.findings.filter(f => f.code === 'BATCH_LIMIT_EXCEEDED');
        expect(limits).to.have.length(1);
        expect(limits[0].details).to.deep.include({ action: 'COMMAND', limit: BATCH_COMMAND_LIMIT, count: 251 });
    });

    it('exactly 250 commands is within the cap', function () {
        const wire = 'BATCH|0|' + Array.from({ length: 250 }, (_, i) => 'ISSUE|0|T.' + i + '|1').join(';');
        const r = parse(wire);
        expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
    });

    it('a trailing semicolon is a counted command', function () {
        const wire = 'BATCH|0|' + Array.from({ length: 250 }, (_, i) => 'ISSUE|0|T.' + i + '|1').join(';') + ';';
        const r = parse(wire);
        const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
        expect(limit.details).to.deep.include({ action: 'COMMAND', count: 251 });
    });

    it('LOWERCASE action names never become a second ISSUE', function () {
        // The arbiter matches action names case-sensitively and kills this batch
        // on the activation scan instead; a mirror that upper-cased before
        // classifying would report an ISSUE limit the chain never reaches.
        const r = parse('BATCH|0|issue|0|A;issue|0|B');
        expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
        expect(r.commands.every(c => c.ok === false && c.code === 'UNKNOWN_ACTION')).to.equal(true);
    });

    it('vendored caps match the indexer arbiter values', function () {
        // xchain-indexer/src/actions/batch.js actionLimits; the sibling
        // conformance below hard-fails if the checkout disagrees.
        expect(BATCH_ACTION_LIMITS).to.deep.equal({ BATCH: 0, MINT: 1, ISSUE: 1 });
    });

    describe('sibling conformance vs xchain-indexer batch.js', function () {
        const fs = require('fs');
        const path = require('path');
        const INDEXER = process.env.XCHAIN_INDEXER_PATH ||
            path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer');
        const BATCH_SRC = path.join(INDEXER, 'src', 'actions', 'batch.js');
        before(function () { if (!fs.existsSync(BATCH_SRC)) this.skip(); });

        it('actionLimits values are byte-equal to the indexer source', function () {
            const src = fs.readFileSync(BATCH_SRC, 'utf8');
            for (const [action, limit] of Object.entries(BATCH_ACTION_LIMITS)) {
                const re = new RegExp(`actionLimits\\['${action}'\\]\\s*=\\s*(\\d+)`);
                const m = src.match(re);
                expect(m, `actionLimits['${action}'] not found in indexer batch.js`).to.not.equal(null);
                expect(Number(m[1])).to.equal(limit);
            }
        });
    });
});
