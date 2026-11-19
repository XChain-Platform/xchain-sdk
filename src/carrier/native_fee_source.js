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
 * XChain Platform SDK - Native Fee Quote Source
 *
 * Which address the indexer dry-runs an action as when it sizes the native-coin
 * fee. estimateFees and submitAction both resolve it here, so the output an
 * estimate quotes is the output a submit would build for the same options: the
 * funding address wins, then the change address, then the signing pubkey.
 *
 ********************************************************************/

'use strict';

function nativeFeeQuoteSource(encoderOpts){
    const o = encoderOpts || {};
    return o.sourceAddress || o.change || o.pubkey;
}

module.exports = { nativeFeeQuoteSource };
