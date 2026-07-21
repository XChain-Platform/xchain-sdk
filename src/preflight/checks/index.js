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
 * XChain Platform SDK - Tier-2 per-action check dispatch (spec §4.4)
 *
 * One module per action group; each module implements exactly the
 * ground-truthed matrix rows for its actions. Certified error-capable
 * codes live in ../constants.js; the context enforces the cap, so a
 * check here CANNOT accidentally hard-block on an uncertified code.
 * Actions without a module (or aspects a module cannot reach) land
 * `unverified` - degraded but honest.
 *
 * INDEXER-MAP.md alongside this directory records which indexer
 * handler each module mirrors; the drift gate requires updating it
 * whenever xchain-indexer/src/actions/*.js validity logic changes.
 *
 ********************************************************************/

'use strict';

const sendChecks      = require('./send.js');
const mintChecks      = require('./mint.js');
const issueChecks     = require('./issue.js');
const dispenserChecks = require('./dispenser.js');
const tradingChecks   = require('./trading.js');
const airdropChecks   = require('./airdrop.js');
const dividendChecks  = require('./dividend.js');
const batchChecks     = require('./batch.js');
const miscChecks      = require('./misc.js');

const DISPATCH = {
    SEND:      sendChecks.checkSend,
    DESTROY:   sendChecks.checkDestroy,
    MINT:      mintChecks.checkMint,
    ISSUE:     issueChecks.checkIssue,
    DISPENSER: dispenserChecks.checkDispenser,
    DISPENSE:  dispenserChecks.checkDispense,
    ORDER:     tradingChecks.checkOrder,
    SWAP:      tradingChecks.checkSwap,
    AIRDROP:   airdropChecks.checkAirdrop,
    DIVIDEND:  dividendChecks.checkDividend,
    BATCH:     batchChecks.checkBatch,
};

async function runActionChecks(ctx) {
    const handler = DISPATCH[ctx.parsed.action] || miscChecks.checkMisc;
    await handler(ctx);
}

module.exports = { runActionChecks, DISPATCH };
