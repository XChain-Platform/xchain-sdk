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
 * The GIVE_COIN / GET_COIN presence rule shared by ORDER, SWAP and DISPENSER creates.
 *
 ********************************************************************/

// The indexer refuses a create whose GIVE_COIN or GET_COIN is empty, so it can
// never be valid. createAction fills both from the SDK network; this catches a
// caller with no network configured and a hand-built field map.
function marketCoinErrors(validator, action, fields) {
    let errors = [];
    for (let field of ['GIVE_COIN', 'GET_COIN'])
        if (validator.isEmpty(fields[field]))
            errors.push(validator.buildError('MISSING_REQUIRED_FIELD', action + ' create requires field: ' + field + ' (set it, or configure the SDK network so it defaults to that coin)', { field }));
    return errors;
}

module.exports = { marketCoinErrors };
