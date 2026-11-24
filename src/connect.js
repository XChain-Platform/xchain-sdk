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
 ********************************************************************/

'use strict';

function codec() {
    return require('@dankest-llc/xchain-connect');
}

function signAction(params, options = {}) {
    const { buildRequest, requestLink } = codec();
    const request = buildRequest('signAction', params, options);
    const codecOptions = {};
    if (options.now !== undefined) codecOptions.now = options.now;
    if (options.developerMode !== undefined) codecOptions.developerMode = options.developerMode;
    return { request, link: requestLink(request, codecOptions) };
}

module.exports = { signAction };
