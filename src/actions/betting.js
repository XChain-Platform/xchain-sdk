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
 * XChain Platform SDK - BET (parimutuel betting) Helpers
 *
 * Pure builders for the four BET formats (see
 * xchain-documentation/protocol/actions/BET.md): v0 create a market, v1 cancel,
 * v2 place a bet, v3 resolve. Every rule mirrored here is a CONSENSUS rule the
 * indexer enforces; the point of duplicating them is that a malformed market
 * should fail in the caller's hands rather than after paying a fee to be
 * rejected on-chain. The SDK must never be stricter than consensus (that
 * refuses actions the protocol accepts) nor looser (that lets fees burn).
 *
 * The DETAILS schema lives here and is the single source of truth for it:
 * BET.md documents it, the wallet's create form is generated from it, and the
 * explorer renders against it. Only the shape rules the indexer actually checks
 * are enforced as errors (strict base64, size, JSON object, depth, and the
 * outcomes cross-check); every other key is convention and is validated only for
 * type, so a market carrying extra keys still composes.
 *
 * All pure: no network, no consensus. Submit-flow recipes live on
 * sdk.workflows (openMarket / placeBet / resolveMarket / cancelMarket); the raw
 * action wrapper is sdk.bet().
 *
 ********************************************************************/

const { BET_LIMITS, BET_DETAILS_SCHEMA } = require('./betting/bet_rules.js');
const betDetails = require('./betting/bet_details.js');
const marketParams = require('./betting/market_params.js');
const payoutProjection = require('./betting/payout_projection.js');
const { installMethods } = require('../utils/install_methods.js');


class BettingHelpers {

    get LIMITS()         { return Object.assign({}, BET_LIMITS); }
    // A copy, so a caller building a form cannot mutate the shared schema.
    get DETAILS_SCHEMA() { return JSON.parse(JSON.stringify(BET_DETAILS_SCHEMA)); }

}

installMethods(
    BettingHelpers.prototype,
    betDetails,
    marketParams,
    payoutProjection
);

module.exports = Object.assign(BettingHelpers, {
    BET_LIMITS,
    BET_DETAILS_SCHEMA,
});
