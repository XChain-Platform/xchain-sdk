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

const CONNECT_PACKAGE = '@dankest-llc/xchain-connect';

const loadCodec = () => {
    try {
        return require(CONNECT_PACKAGE);
    } catch (error) {
        if (error?.code === 'MODULE_NOT_FOUND' && error.message.includes(`'${CONNECT_PACKAGE}'`)) {
            throw new Error(`${CONNECT_PACKAGE} is not installed; install it to sign wallet action requests`);
        }
        throw error;
    }
};

function signAction(params, options = {}) {
    const { buildRequest, requestLink } = loadCodec();
    const request = buildRequest('signAction', params, options);
    const codecOptions = {};
    if (options.now !== undefined) codecOptions.now = options.now;
    if (options.developerMode !== undefined) codecOptions.developerMode = options.developerMode;
    return { request, link: requestLink(request, codecOptions) };
}

module.exports = { signAction };
