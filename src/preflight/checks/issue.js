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
 * Pre-flight Tier-2: ISSUE (spec §4.4; mirrors xchain-indexer
 * src/actions/issue.js). THE load-bearing correction from the
 * ground-truthing pass: existence alone is NOT a reject (format 0 is
 * create-or-edit); the reject is existence AND caller is not the
 * owner. Fee only on create (issue.js:531). Lock ratchets,
 * isDistributed callback freeze, and TICK reserved tables are
 * internal; TICK charset mirrors as warning only.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const { tokenField } = require('./mint.js');

async function checkIssue(ctx) {
    const tick = ctx.field('TICK');
    if (!tick || Array.isArray(tick)) return;

    const token = await ctx.token(tick);
    ctx.markRun(FINDING_CODES.NOT_OWNER);
    if (token === undefined) {
        ctx.addUnverified(FINDING_CODES.NOT_OWNER, 'token lookup unavailable');
        return;
    }
    if (token === null) return; // fresh create: nothing to gate

    const owner = tokenField(token, ['owner', 'OWNER', 'owner_address', 'issuer']);
    if (!ctx.source) {
        ctx.addUnverified(FINDING_CODES.NOT_OWNER, 'no source address supplied');
    } else if (owner && owner !== ctx.source) {
        ctx.addFinding(FINDING_CODES.NOT_OWNER, 'error',
            `${tick} exists and is owned by ${owner}; only the owner can edit it.`,
            { tick, owner, source: ctx.source });
    }

    ctx.addUnverified('ISSUE_LOCK_RATCHETS',
        'lock ratchets vs requested edits, isDistributed callback freeze, and reserved-TICK tables are server-side only');
}

module.exports = { checkIssue };
