/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    classifyIssueTick,
    formatVersion,
    classifyCommand,
} = require('../../../../../src/protocol/batch_limits/command_classification.js');
const { CHILD_ISSUE_KEY } = require('../../../../../src/protocol/batch_limits/limit_tables.js');

describe('command classification', function () {
    it('classifies only non-caret dotted ticks as child issues', function () {
        expect(classifyIssueTick(undefined)).to.equal('ISSUE');
        expect(classifyIssueTick(null)).to.equal('ISSUE');
        expect(classifyIssueTick('^PARENT.CHILD')).to.equal('ISSUE');
        expect(classifyIssueTick('JDOG')).to.equal('ISSUE');
        expect(classifyIssueTick('PARENT.CHILD')).to.equal(CHILD_ISSUE_KEY);
    });

    it('normalizes valid format versions and rejects invalid ones', function () {
        expect(formatVersion(3)).to.equal(3);
        expect(formatVersion('3')).to.equal(3);
        expect(formatVersion(undefined)).to.equal(0);
        expect(formatVersion('')).to.equal(0);
        expect(formatVersion('"2"')).to.equal(2);
        expect(formatVersion(256)).to.equal(null);
        expect(formatVersion(1.5)).to.equal(null);
        expect(formatVersion('abc')).to.equal(null);
        expect(formatVersion({})).to.equal(null);
    });

    it('classifies wire commands by action and issue tick without throwing', function () {
        const send = ['SEND', '0', 'JDOG', '1', 'address'].join(String.fromCharCode(124));
        const unknown = ['UNKNOWN', '0'].join(String.fromCharCode(124));
        const issue = ['ISSUE', '0', 'JDOG'].join(String.fromCharCode(124));
        const childIssue = ['ISSUE', '0', 'PARENT.CHILD'].join(String.fromCharCode(124));
        expect(classifyCommand(send)).to.equal('SEND');
        expect(classifyCommand(unknown)).to.equal('UNKNOWN');
        expect(classifyCommand(issue)).to.equal('ISSUE');
        expect(classifyCommand(childIssue)).to.equal(CHILD_ISSUE_KEY);
        expect(() => classifyCommand('')).not.to.throw();
    });
});
