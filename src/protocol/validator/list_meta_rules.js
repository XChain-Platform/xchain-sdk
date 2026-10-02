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
 * XChain Platform SDK - LIST metadata field rules
 *
 ********************************************************************/

'use strict';

const { isValidMetaText } = require('../../contract/utils/meta_literals.js');

function listMetaFieldError(field, value, maxBytes, isCreate) {
    if (value === '') return null;
    if (value.includes('|')) return 'invalid: ' + field + ' (pipe)';
    if (value.includes(';')) return 'invalid: ' + field + ' (semicolon)';
    if (Buffer.byteLength(value, 'utf8') > maxBytes)
        return 'invalid: ' + field + ' (length)';
    if ((isCreate && value === '-') || !isValidMetaText(value, maxBytes, false))
        return 'invalid: ' + field + ' (format)';
    return null;
}

module.exports = { listMetaFieldError };
