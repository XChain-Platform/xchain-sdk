'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Tier-1 findings module on its own: how each shape runTier1 returns
// folds into the findings list. batch_tier1.test.js drives the batch
// precedence rule end to end from measured arbiter answers; this file pins
// every other branch (a plain valid verdict, an invalid one, an unreachable
// network, a declined judgement, local-only mode) and the entry's re-export,
// so a change to one branch is caught by a case that names it.

const { expect } = require('chai');
const tier1Findings = require('../../../src/preflight/index/tier1_findings.js');
const preflight = require('../../../src/preflight/index.js');
const { FINDING_CODES: FC } = require('../../../src/preflight/constants.js');

const { applyTier1, classifySubCommands, pushSubCommandFindings } = tier1Findings;

function clientError(code, data) {
    return { code, severity: 'error', source: 'client', overridable: true, message: 'x', data: data || {} };
}

function byCode(findings, code) {
    return findings.filter((f) => f.code === code);
}

describe('pre-flight Tier-1 findings: entry and empty input', function () {

    it('the entry exports the same applyTier1 the module defines', function () {
        expect(preflight.applyTier1).to.equal(applyTier1);
    });

    it('returns the findings untouched when Tier 1 produced nothing', function () {
        const findings = [clientError('TOKEN_NOT_FOUND')];
        expect(applyTier1(findings, null)).to.equal(findings);
        expect(findings).to.have.length(1);
        expect(findings[0].severity).to.equal('error');
    });

    it('adds nothing for a Tier-1 kind it does not know', function () {
        expect(applyTier1([], { kind: 'something-else' })).to.deep.equal([]);
    });
});

describe('pre-flight Tier-1 findings: a valid verdict', function () {

    it('demotes a confirmed-state client error to info and discloses the approval', function () {
        const findings = [clientError('TOKEN_NOT_FOUND')];
        applyTier1(findings, { kind: 'verdict', valid: true });
        expect(findings[0].severity).to.equal('info');
        expect(findings[0]._downgradedBy).to.equal('dryrun-valid');
        const valid = byCode(findings, FC.DRYRUN_VALID);
        expect(valid).to.have.length(1);
        expect(valid[0].message).to.equal('The network dry-run accepted this action.');
        expect(valid[0].data).to.deep.equal({});
    });

    it('keeps a local-delta error at warning and drops its override flag', function () {
        const findings = [clientError('INSUFFICIENT_BALANCE', { localDeltaApplied: true })];
        applyTier1(findings, { kind: 'verdict', valid: true });
        expect(findings[0].severity).to.equal('warning');
        expect(findings[0]._downgradedBy).to.equal('dryrun-valid-local-delta');
        expect(findings[0]).to.not.have.property('overridable');
    });

    it('leaves dryrun-sourced errors and client warnings alone', function () {
        const warning = { code: 'W', severity: 'warning', source: 'client', data: {} };
        const dryrun = { code: 'D', severity: 'error', source: 'dryrun', data: {} };
        applyTier1([warning, dryrun], { kind: 'verdict', valid: true });
        expect(warning.severity).to.equal('warning');
        expect(dryrun.severity).to.equal('error');
    });

    it('discloses owed oracle fees as info, naming each payee', function () {
        const owed = { addrA: '5', addrB: '7' };
        const fees = byCode(applyTier1([], { kind: 'verdict', valid: true, oracleFeesOwed: owed }),
            FC.DRYRUN_ORACLE_FEES_OWED);
        expect(fees).to.have.length(1);
        expect(fees[0].severity).to.equal('info');
        expect(fees[0].message).to.contain('5 to addrA, 7 to addrB');
        expect(fees[0].data).to.deep.equal({ oracleFeesOwed: owed });
    });
});

describe('pre-flight Tier-1 findings: an invalid verdict', function () {

    it('adds an overridable DRYRUN_INVALID error carrying the status', function () {
        const status = 'invalid: TICK (unknown)';
        const invalid = byCode(applyTier1([], { kind: 'verdict', valid: false, status, error: null }),
            FC.DRYRUN_INVALID);
        expect(invalid).to.have.length(1);
        expect(invalid[0]).to.include({ severity: 'error', source: 'dryrun', overridable: true });
        expect(invalid[0].message).to.equal('The network reports this will fail: ' + status);
        expect(invalid[0].data).to.deep.equal({ status, error: null });
    });

    it('falls back to the error text, then to "rejected"', function () {
        const withError = applyTier1([], { kind: 'verdict', valid: false, error: 'boom' });
        expect(withError[0].message).to.equal('The network reports this will fail: boom');
        const bare = applyTier1([], { kind: 'verdict', valid: false });
        expect(bare[0].message).to.equal('The network reports this will fail: rejected');
    });

    it('still reports sub-command verdicts that arrive with it, before the outer error', function () {
        const findings = applyTier1([], { kind: 'verdict', valid: false, status: 'invalid',
            subCommands: [{ position: 0, action: 'SEND', status: 'invalid: X', refused: null }] });
        expect(findings.map((f) => f.code)).to.deep.equal([FC.DRYRUN_SUBCOMMAND_INVALID, FC.DRYRUN_INVALID]);
    });
});

describe('pre-flight Tier-1 findings: no network judgement', function () {

    it('discloses an unreachable network with the reason and leaves client errors standing', function () {
        const findings = applyTier1([clientError('E')], { kind: 'unavailable', reason: 'timeout' });
        const notice = byCode(findings, FC.DRYRUN_UNAVAILABLE);
        expect(notice).to.have.length(1);
        expect(notice[0].message).to.equal('The network dry-run was unavailable (timeout); relying on client checks.');
        expect(findings[0].severity).to.equal('error');
    });

    it('words a declined judgement as a refusal and carries the denied sub-action', function () {
        const findings = applyTier1([], { kind: 'no-verdict', reason: 'guard inert', deniedSubAction: 'XCALL' });
        expect(findings).to.have.length(1);
        expect(findings[0].code).to.equal(FC.DRYRUN_UNAVAILABLE);
        expect(findings[0].message).to.equal('The network declined to judge this action (guard inert); relying on client checks.');
        expect(findings[0].data).to.deep.equal({ deniedSubAction: 'XCALL' });
    });

    it('words local-only mode as a network that was not consulted', function () {
        const findings = applyTier1([], { kind: 'no-verdict', reason: 'local-only mode' });
        expect(findings[0].message).to.equal('The network was not consulted (local-only mode); relying on client checks.');
        expect(findings[0].data).to.deep.equal({});
    });
});

describe('pre-flight Tier-1 findings: sub-command buckets', function () {

    const subs = [
        { position: 0, action: 'SEND', status: 'valid', refused: null },
        { position: 1, action: 'SEND', status: 'invalid: TICK (unknown)', refused: null },
        { position: 2, action: 'COINPAY', status: null, refused: null },
        { position: 3, action: 'XCALL', status: null, refused: 'denylisted' },
        { position: 4, action: 'SEND', status: '', refused: null },
    ];

    it('splits valid, invalid and unjudged, treating an empty status as unjudged', function () {
        const cls = classifySubCommands(subs);
        expect([...cls.valid]).to.deep.equal([0]);
        expect(cls.invalid.map((s) => s.position)).to.deep.equal([1]);
        expect(cls.unjudged.map((s) => s.position)).to.deep.equal([2, 3, 4]);
        expect(cls.allValid).to.equal(false);
        expect(classifySubCommands([subs[0]]).allValid).to.equal(true);
    });

    it('pushes an error per invalid command and an info per unjudged one', function () {
        const findings = [];
        pushSubCommandFindings(findings, subs);
        expect(byCode(findings, FC.DRYRUN_SUBCOMMAND_INVALID).map((f) => f.data.commandIndex)).to.deep.equal([1]);
        const unjudged = byCode(findings, FC.DRYRUN_SUBCOMMAND_UNJUDGED);
        expect(unjudged.map((f) => f.data.commandIndex)).to.deep.equal([2, 3, 4]);
        expect(unjudged[1].message).to.contain('(denylisted)');
        expect(unjudged[0].message).to.contain('the read-only pre-flight cannot evaluate this command');
    });
});
