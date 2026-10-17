// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// Mainnet launch gate: protocol actions are refused on a *-mainnet network
// until the launch time. A payment-only submit carries no action and stays allowed.

const { SDKConfigError } = require('../utils/errors.js');

const MAINNET_LAUNCH_TIME = 1798761600;

function isMainnetNetwork(network) {
    return typeof network === 'string' && /-mainnet$/i.test(network);
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

// Throws SDKConfigError MAINNET_NOT_LAUNCHED for an action on a mainnet network
// before the launch time. `now` is in unix seconds and defaults to the clock.
function assertMainnetLaunched(network, actionData, now = nowSeconds()) {
    if (!isMainnetNetwork(network)) return;
    if (!actionData || !actionData.action) return;
    if (now >= MAINNET_LAUNCH_TIME) return;
    throw new SDKConfigError(
        'MAINNET_NOT_LAUNCHED',
        'Actions on ' + network + ' are not accepted before ' + MAINNET_LAUNCH_TIME + ' (unix seconds)',
        { network, action: actionData.action, launchTime: MAINNET_LAUNCH_TIME, now },
    );
}

module.exports = { MAINNET_LAUNCH_TIME, isMainnetNetwork, assertMainnetLaunched };
