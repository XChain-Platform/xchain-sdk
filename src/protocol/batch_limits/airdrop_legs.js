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
 * XChain Platform SDK - BATCH limit scan: the per-leg AIRDROP weight
 *
 * One part of src/protocol/batch_limits.js, whose `subCommandWeight`
 * multiplies an AIRDROP's table weight by the factor exported here.
 *
 * BATCH_AIRDROP_LEG_WEIGHT: at and above this height the arbiter weighs an
 * AIRDROP sub-command PER LEG, its table weight (25) times the legs it pays
 * out, because every leg of a multi-leg AIRDROP (FORMATs 1 to 3) expands its
 * own list. Below it, and for DIVIDEND at every height, the weight is flat.
 * The table mirrors the arbiter's gate row: unarmed on mainnet and testnet,
 * active from genesis on regtest.
 *
 * `at` is an optional { network, height }. Without a network the SDK's
 * NETWORK setting is used (a `<coin>-<network>` name or a bare network);
 * without a height the gate counts as active only where it is armed at 0, so
 * a client that cannot say where its batch lands never refuses legal work.
 *
 ********************************************************************/

'use strict';

const { formatVersion } = require('./command_classification.js');
const { UNARMED } = require('../../consensus/gate_registry/core.js');
const { env: sdkEnv } = require('../../config.js');

const BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION = Object.freeze({ mainnet: UNARMED, testnet: UNARMED, regtest: 0 });

function airdropLegWeightActive(at) {
    const named = (at && at.network !== undefined && at.network !== null) ? at.network : sdkEnv.network();
    const network = String(named || '').toLowerCase().split('-').pop();
    const activation = BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION[network];
    if (!Number.isInteger(activation)) return false;
    const height = (at && at.height !== undefined && at.height !== null) ? Number(at.height) : NaN;
    return Number.isFinite(height) ? height >= activation : activation === 0;
}

/*
 * Leg count of ONE AIRDROP sub-command's params (VERSION first), at least 1,
 * counted exactly as the arbiter's readAirdropLegs builds its legs: format 0
 * is one leg, format 1 one per TICK|AMOUNT pair after the LIST, formats 2 and
 * 3 one per full group that is not the trailing MEMO. Unreadable is one leg,
 * so an entry is never made free.
 */
function airdropLegCount(params) {
    try {
        const format = formatVersion(params[0]);
        if (!Number.isInteger(format) || format < 0 || format > 3) return 1;
        const last = params.length - 1;
        let legs = 0;
        for (let idx = 0; idx < params.length; idx++) {
            if ((format === 0 && idx === 0) || (format === 1 && idx > 1 && idx % 2 === 1)
                || (format === 2 && idx > 0 && idx % 3 === 1 && idx < last)
                || (format === 3 && idx > 0 && idx % 4 === 1 && idx < last)) legs++;
        }
        return Math.max(1, legs);
    } catch (e) {
        return 1;
    }
}

// The multiplier `subCommandWeight` applies to an action's table weight: the
// leg count for an AIRDROP weighed at or above the gate, 1 for everything else.
function airdropLegFactor(action, command, at) {
    try {
        if (action !== 'AIRDROP' || !airdropLegWeightActive(at)) return 1;
        return airdropLegCount(String(command).split('|').slice(1));
    } catch (e) {
        return 1;   // the flat weight: never cheaper than below the gate
    }
}

module.exports = {
    BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION,
    airdropLegWeightActive,
    airdropLegCount,
    airdropLegFactor,
};
