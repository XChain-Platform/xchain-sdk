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
 * XChain Platform SDK - Workflow Recipes
 *
 * High-level helpers that compose multiple actions into common
 * workflows. Built on WalletSession + submitAction.
 *
 ********************************************************************/

const issuanceAndStaking = require('./workflows/issuance_and_staking.js');
const contractDeploy = require('./workflows/contract_deploy.js');
const contentVotesMarkets = require('./workflows/content_votes_markets.js');
const bridge = require('./workflows/bridge.js');


class Workflows {

    constructor(sdk) {
        this.sdk = sdk;
    }

}

Object.assign(
    Workflows.prototype,
    issuanceAndStaking,
    contractDeploy,
    contentVotesMarkets,
    bridge
);

module.exports = Workflows;
