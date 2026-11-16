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
 * XChain Platform SDK - File Assembly Wait
 *
 ********************************************************************/

const { SDKActionError, SDKConfigError } = require('../errors.js');

function validateAssemblyArgs(actionIndex) {
    if (actionIndex === undefined || actionIndex === null || actionIndex === '')
        throw new SDKConfigError('MISSING_FILE_ACTION_INDEX',
            'waitForFileComplete requires a file ACTION_INDEX');
}

function classifyAssembly(multipart, actionIndex) {
    let status = multipart && multipart.status;
    let satisfied = status === 'complete' || status === 'mismatch';

    return {
        satisfied,
        result: { actionIndex, multipart },
        observed: multipart
    };
}

function assemblyTimeoutError(actionIndex, opts = {}, observed, lastError) {
    let timeout = opts.timeout > 0 ? opts.timeout : 120000;
    let partsReceived = observed && observed.parts_received !== undefined
        ? observed.parts_received : 0;
    let totalParts = observed && observed.total_parts !== undefined
        ? observed.total_parts : 'unknown';

    return new SDKActionError('FILE_ASSEMBLY_TIMEOUT',
        'File ' + actionIndex + ' assembly did not complete within ' + timeout + 'ms; last read received ' +
        partsReceived + ' of ' + totalParts + ' parts.',
        { actionIndex, multipart: observed, timeout: opts.timeout,
          cause: lastError || undefined });
}

module.exports = {
    validateAssemblyArgs,
    classifyAssembly,
    assemblyTimeoutError
};
