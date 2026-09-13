'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decoder.parse BATCH sub-grammar suite (spec §3.1 rule 8): 3-way
// split, ';'-joined complete sub-actions, nested-BATCH refusal,
// per-command failure isolation, and per-type caps as validation
// findings.

const { expect } = require('chai');
const {
    parse,
    BATCH_ACTION_LIMITS,
    BATCH_GATED_ACTION_LIMITS,
    BATCH_COMMAND_LIMIT,
} = require('../../../src/decoder/parse.js');

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
        // What this module ENFORCES is the arbiter's MERGED post-flag table, so
        // DEPLOY (D5) belongs here even though the indexer keeps it in a second
        // table below the flag. The sibling conformance below reads each entry
        // out of the table the arbiter actually stores it in.
        expect(BATCH_ACTION_LIMITS).to.deep.equal({ BATCH: 0, MINT: 1, ISSUE: 1, DEPLOY: 1 });
        expect(BATCH_GATED_ACTION_LIMITS).to.deep.equal({ DEPLOY: 1 });
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
                // A gated cap lives in `gatedActionLimits` on purpose: writing it
                // into `actionLimits` would have applied it retroactively, so
                // finding it there would be the drift, not the match.
                const table = BATCH_GATED_ACTION_LIMITS[action] !== undefined
                    ? 'gatedActionLimits' : 'actionLimits';
                const re = new RegExp(`${table}\\['${action}'\\]\\s*=\\s*(\\d+)`);
                const m = src.match(re);
                expect(m, `${table}['${action}'] not found in indexer batch.js`).to.not.equal(null);
                expect(Number(m[1])).to.equal(limit);
            }
        });

        it('DEPLOY is absent from the indexer UNGATED table, so below the flag it stays uncapped', function () {
            // The pin above proves the SDK and the arbiter agree on DEPLOY: 1.
            // This proves the arbiter still keeps it on the GATED side, which is
            // what makes the merge in batchLimits.js a mirror rather than a
            // guess. `gatedActionLimits` capitalizes its A, so the pattern reads
            // only the ungated table by construction.
            const src = fs.readFileSync(BATCH_SRC, 'utf8');
            expect(/actionLimits\['DEPLOY'\]/.test(src)).to.equal(false);
        });
    });

    describe('D5/D7 post-flag caps', function () {

        it('one DEPLOY is within the cap', function () {
            const r = parse('BATCH|0|DEPLOY|0|MyContract|1|0|src');
            expect(r.ok).to.equal(true);
            expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
        });

        it('two DEPLOYs raise BATCH_LIMIT_EXCEEDED for DEPLOY', function () {
            // D5: the chain accepts exactly one, because every DEPLOY runs a
            // constructor in the VM and the 250-command cap was sized for cheap
            // commands. Before D5 this module had no DEPLOY entry at all.
            const r = parse('BATCH|0|DEPLOY|0|A|1|0|src;DEPLOY|0|B|1|0|src');
            expect(r.ok).to.equal(true);
            const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
            expect(limit).to.exist;
            expect(limit.details).to.deep.include({ action: 'DEPLOY', limit: 1, count: 2 });
        });

        it('MINTs of two DISTINCT ticks raise nothing', function () {
            // D7: the cap is per distinct token. Minting two different tokens
            // in one transaction takes nothing from anyone.
            const r = parse('BATCH|0|MINT|0|JDOG|1;MINT|0|PEPE|1');
            expect(r.ok).to.equal(true);
            expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
        });

        it('two MINTs of ONE tick raise the MINT finding, counted per distinct token', function () {
            const r = parse('BATCH|0|MINT|0|JDOG|1;MINT|0|PEPE|1;MINT|0|JDOG|2');
            const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
            expect(limit).to.exist;
            // 2, the largest run naming ONE token, NOT the raw occurrence count
            // of 3: that difference is the whole of D7.
            expect(limit.details).to.deep.include({ action: 'MINT', limit: 1, count: 2 });
        });

        it('a caret-ambiguous MINT pair raises NOTHING, deliberately', function () {
            // `JDOG` and `^614` can name ONE token, and only an indexer can say
            // whether they do. This module DECODES a string the chain may
            // already have accepted, so silence is the honest answer: raising a
            // finding here would claim a limit the chain may never have reached.
            // The divergence is declared in batchLimits.js's header, not hidden.
            const r = parse('BATCH|0|MINT|0|JDOG|1;MINT|0|^614|1');
            expect(r.ok).to.equal(true);
            expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
        });

        it('a caret does NOT silence a breach a literal repeat already proved', function () {
            // The pair above raises nothing because one MINT per name really is
            // a per-token maximum of 1 - no finding was ever due. Here JDOG
            // genuinely repeats, so the maximum is 2 before `^614` is even
            // looked at, and no resolution can talk it back down: keying on
            // strings only ever SPLITS what the arbiter merges, so this
            // maximum is a lower bound. A lower bound over the cap is certain,
            // and `approximate` is still set to say the batch may be worse than
            // reported - never that this finding is in doubt.
            const r = parse('BATCH|0|MINT|0|JDOG|1;MINT|0|JDOG|2;MINT|0|^614|1');
            expect(r.ok).to.equal(true);
            const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
            expect(limit).to.exist;
            expect(limit.details).to.deep.include({ action: 'MINT', limit: 1, count: 2 });
        });

        it('two MINTs of the SAME caret string still raise it: one string, one id', function () {
            const r = parse('BATCH|0|MINT|0|^614|1;MINT|0|^614|2');
            const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
            expect(limit).to.exist;
            expect(limit.details).to.deep.include({ action: 'MINT', limit: 1, count: 2 });
        });

        it('a legacy no-VERSION MINT reads its TICK off the injected VERSION 0', function () {
            // `MINT|A|1|addr` carries no VERSION, so the arbiter splices one in
            // and the TICK lands at params[1]. Reading position 1 without the
            // injection would key both entries on '1' and '2' and miss that they
            // name the SAME token.
            const r = parse('BATCH|0|MINT|A|1|addr;MINT|A|2|addr');
            const limit = r.validation.findings.find(f => f.code === 'BATCH_LIMIT_EXCEEDED');
            expect(limit).to.exist;
            expect(limit.details).to.deep.include({ action: 'MINT', limit: 1, count: 2 });
        });

        it('legacy no-VERSION MINTs of DIFFERENT ticks raise nothing', function () {
            const r = parse('BATCH|0|MINT|A|1|addr;MINT|B|1|addr');
            expect(r.validation.findings.map(f => f.code)).to.not.include('BATCH_LIMIT_EXCEEDED');
        });

        it('the command cap still runs FIRST and alone over a per-distinct-token MINT breach', function () {
            const wire = 'BATCH|0|' + Array.from({ length: 251 }, () => 'MINT|0|JDOG|1').join(';');
            const limits = parse(wire).validation.findings.filter(f => f.code === 'BATCH_LIMIT_EXCEEDED');
            expect(limits).to.have.length(1);
            expect(limits[0].details.action).to.equal('COMMAND');
        });
    });

    /*
     * R2b: among per-ACTION caps, the error names the action whose FIRST
     * sub-command appears EARLIEST in the command list.
     *
     * This decoder reports EVERY broken per-action cap rather than stopping at
     * the first, so R2b shows up here as the ORDER of the findings: the
     * arbiter emits exactly one error string, and it is the one findings[0]
     * names. A caller that surfaces the leading finding therefore predicts the
     * chain's verdict, which is only true while this order holds. Both
     * directions of each pair are stated, because one direction alone is
     * satisfied by alphabetical or key-insertion order just as well.
     */
    describe('R2b per-ACTION error precedence (finding order)', function () {
        const limitDetails = (wire) => parse(wire).validation.findings
            .filter(f => f.code === 'BATCH_LIMIT_EXCEEDED')
            .map(f => f.details.action);

        it('leads with the action seen FIRST (DEPLOY before ISSUE)', function () {
            expect(limitDetails('BATCH|0|DEPLOY|0|6001;DEPLOY|0|6002;ISSUE|0|A|1;ISSUE|0|B|1'))
                .to.deep.equal(['DEPLOY', 'ISSUE']);
        });

        it('leads with the action seen FIRST (ISSUE before DEPLOY)', function () {
            expect(limitDetails('BATCH|0|ISSUE|0|A|1;ISSUE|0|B|1;DEPLOY|0|6001;DEPLOY|0|6002'))
                .to.deep.equal(['ISSUE', 'DEPLOY']);
        });

        it('interleaving does not reorder: the LEADER is first, not the cap completed first', function () {
            expect(limitDetails('BATCH|0|DEPLOY|0|6001;ISSUE|0|A|1;ISSUE|0|B|1;DEPLOY|0|6002'))
                .to.deep.equal(['DEPLOY', 'ISSUE']);
            expect(limitDetails('BATCH|0|ISSUE|0|A|1;DEPLOY|0|6001;DEPLOY|0|6002;ISSUE|0|B|1'))
                .to.deep.equal(['ISSUE', 'DEPLOY']);
        });

        it('a bigger overage does not jump the queue', function () {
            // DEPLOY exceeds by 2 and ISSUE by 1; ISSUE still leads.
            expect(limitDetails('BATCH|0|ISSUE|0|A|1;ISSUE|0|B|1;DEPLOY|0|6001;DEPLOY|0|6002;DEPLOY|0|6003'))
                .to.deep.equal(['ISSUE', 'DEPLOY']);
        });

        it('MINT takes its turn by first appearance despite its substituted count', function () {
            expect(limitDetails('BATCH|0|MINT|0|JDOG|1;MINT|0|JDOG|2;ISSUE|0|A|1;ISSUE|0|B|1'))
                .to.deep.equal(['MINT', 'ISSUE']);
            expect(limitDetails('BATCH|0|ISSUE|0|A|1;ISSUE|0|B|1;MINT|0|JDOG|1;MINT|0|JDOG|2'))
                .to.deep.equal(['ISSUE', 'MINT']);
        });

        it('orders three broken caps by first appearance, both directions', function () {
            expect(limitDetails('BATCH|0|MINT|0|JDOG|1;MINT|0|JDOG|2;DEPLOY|0|6001;DEPLOY|0|6002;'
                + 'ISSUE|0|A|1;ISSUE|0|B|1')).to.deep.equal(['MINT', 'DEPLOY', 'ISSUE']);
            expect(limitDetails('BATCH|0|ISSUE|0|A|1;ISSUE|0|B|1;DEPLOY|0|6001;DEPLOY|0|6002;'
                + 'MINT|0|JDOG|1;MINT|0|JDOG|2')).to.deep.equal(['ISSUE', 'DEPLOY', 'MINT']);
        });

        it('uncapped and exempt commands take no turn', function () {
            expect(limitDetails('BATCH|0|SEND|0|JDOG|1|addr;ISSUE|0|JDOG.1|1;DEPLOY|0|6001;'
                + 'ISSUE|0|A|1;ISSUE|0|B|1;DEPLOY|0|6002')).to.deep.equal(['DEPLOY', 'ISSUE']);
        });
    });
});
