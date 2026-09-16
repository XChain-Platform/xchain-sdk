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
 * XChain Platform SDK - Actions Class Tests
 *
 * Comprehensive unit tests for the Actions class covering all 19 ACTION
 * types, format version selection, result structure, error cases,
 * pre-flight encoding validation, validateAction dry-run, and
 * introspection methods.
 *
 ********************************************************************/

'use strict';

const config  = require('../../../../../src/config.js');
const Utility = require('../../../../../src/utils/utility.js');
const Actions = require('../../../../../src/actions/index.js');

// Reusable valid segwit address (42 chars)
const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Factory: create a fresh Actions instance backed by real config + utility
function createActions() {
    let sdk = { config: config.getConfig(), util: new Utility() };
    return new Actions(sdk);
}

module.exports = { ADDR, createActions };
