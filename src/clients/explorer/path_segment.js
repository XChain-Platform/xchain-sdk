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
 * One explorer path segment.
 *
 * The explorer reads keyed by a tick, an address, a hash or an index, and the
 * client joins that key into the request path. A tick is free text (TDOGE
 * issued "$$$$$$$$$$$78324%@##*(@#"), so joined raw it truncates the request at
 * the '#', or fails URL parsing at the '%@', and the read answers for the
 * wrong key or not at all. Every joined key goes through here so it travels as
 * exactly one segment; the explorer decodes it on arrival.
 *
 ********************************************************************/

'use strict';

function seg(value) {
    return encodeURIComponent(String(value));
}

module.exports = { seg };
