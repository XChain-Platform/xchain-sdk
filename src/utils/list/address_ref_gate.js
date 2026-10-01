// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

function listAddressRefActive(threshold, lastBlock) {
    return Number.isFinite(threshold)
        && Number.isFinite(lastBlock)
        && lastBlock + 1 >= threshold;
}

function shouldCompactListItems({ listType, threshold, lastBlock }) {
    return String(listType) === '2'
        && listAddressRefActive(threshold, lastBlock);
}

module.exports = {
    listAddressRefActive,
    shouldCompactListItems
};
