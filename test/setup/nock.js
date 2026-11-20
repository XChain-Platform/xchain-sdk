/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * CommonJS test compatibility for nock 15.
 *
 ********************************************************************/

'use strict';

const nockPath = require.resolve('nock');
const nockModule = require(nockPath);

// Nock 15 is ESM and Node exposes its callable default under `.default` to
// CommonJS. Normalize the cached export so existing tests retain `nock(url)`.
if (typeof nockModule.default === 'function') {
    require.cache[nockPath].exports = nockModule.default;
}
