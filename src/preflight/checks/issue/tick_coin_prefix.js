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
 * XChain Platform SDK - ISSUE coin-qualified tick verdict
 *
 ********************************************************************/

const { coinQualifierRoot } = require('../../../protocol/list_tick_coin.js');

const TICK_RESERVED_VERDICT = 'invalid: TICK (reserved)';

function tickCoinPrefixVerdict({ tick, active, token }) {
    if (active !== true || typeof tick !== 'string') return null;
    if (tick.startsWith('^') || tick.includes('.')) return null;

    const root = coinQualifierRoot(tick);
    if (root === null) return null;
    if (token === undefined) return { unverified: 'token lookup unavailable' };
    if (token !== null) return null;

    return { refuse: TICK_RESERVED_VERDICT, root };
}

module.exports = { TICK_RESERVED_VERDICT, tickCoinPrefixVerdict };
