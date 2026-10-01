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
 * Pre-flight Tier-2: AIRDROP (spec §4.4; mirrors xchain-indexer
 * src/actions/airdrop.js). LIST existence is checkable; a null AMOUNT
 * is a WARNING, never an error - airdrop.js:176 accepts it as a
 * zero airdrop with the fee still charged (false-block invariant).
 * The full total<=balance check needs the resolved recipient count,
 * which is server-side; the per-recipient balance sanity check runs
 * when the list size is reconstructable.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES, activationThreshold, describeActivation } = require('../constants.js');
const numeric = require('../numeric.js');
const { actionRecord } = require('../resolvers.js');

// Judge an invalid LIST reference from the pinned activation table: an error only where it is active from genesis.
function noteInvalidListReference(ctx, idx, status) {
    const at = activationThreshold('LIST_REFERENCE_VALIDITY', ctx.sdk);
    if (at === 0) {
        ctx.addFinding(FINDING_CODES.LIST_NOT_FOUND, 'error',
            `List #${idx} exists but is not valid, so it cannot be referenced on this network.`,
            { listActionIndex: String(idx), status });
        return;
    }
    const here = typeof at === 'number' ? `this network arms the validity gate at height ${at}` : 'the gate is unarmed on this network';
    ctx.addUnverified('LIST_REFERENCE_VALIDITY',
        `list #${idx} is not valid; invalid LIST references are rejected where the validity gate is active (`
        + describeActivation('LIST_REFERENCE_VALIDITY') + '), and ' + here);
}

async function checkAirdrop(ctx) {
    const amount = ctx.field('AMOUNT');
    const listIdxRaw = ctx.params.LIST_ACTION_INDEX;
    const listIdxs = [].concat(listIdxRaw || []).filter(Boolean);

    if (amount === '' || (typeof amount === 'string' && !numeric.isPositive(amount))) {
        ctx.addFinding(FINDING_CODES.AMOUNT_NOT_POSITIVE, 'warning',
            'The chain accepts a null/zero airdrop amount as a zero airdrop; the protocol fee is still charged.',
            { amount });
    }

    for (const idx of listIdxs) {
        // By ACTION INDEX, which means the action-detail route: /lists/ is keyed
        // by block or address only, so `getLists(idx, 'action_index')` 404'd and
        // every AIRDROP naming a perfectly good list was told it did not exist.
        // Same defect, same shape, as the dispenser resolvers (see resolvers.js).
        const res = await ctx.fetch('LIST_LOOKUP', [String(idx)], () =>
            ctx.sdk.explorer.getAction(String(idx)));
        ctx.markRun(FINDING_CODES.LIST_NOT_FOUND);
        if (!res.ok) {
            ctx.addUnverified(FINDING_CODES.LIST_NOT_FOUND, 'list lookup unavailable for #' + idx);
            continue;
        }
        const record = actionRecord(res.value);
        if (res.notFound || !record || String(record.action || '').toUpperCase() !== 'LIST') {
            ctx.addFinding(FINDING_CODES.LIST_NOT_FOUND, 'error',
                `List #${idx} does not exist.`, { listActionIndex: String(idx) });
            continue;
        }
        const status = String(record.status ?? record.STATUS ?? '').toLowerCase();
        if (status && status !== 'valid') noteInvalidListReference(ctx, idx, status);
    }

    ctx.addUnverified('AIRDROP_TOTAL_VS_BALANCE',
        'effective recipient set (and thus the debit total) resolves server-side');
}

module.exports = { checkAirdrop };
