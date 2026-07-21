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
 * XChain Platform SDK - Error Classes
 *
 * This file defines typed errors for the SDK
 *
 ********************************************************************/


class SDKError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SDKError';
        this.code = code;
        this.details = details;
    }
}

class SDKValidationError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKValidationError';
    }
}

class SDKFormatError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKFormatError';
    }
}

class SDKEncoderError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKEncoderError';
    }
}

class SDKExplorerError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKExplorerError';
    }
}

class SDKHubError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKHubError';
    }
}

class SDKConfigError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKConfigError';
    }
}

class SDKContractError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKContractError';
    }
}

class SDKWalletError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKWalletError';
    }
}

class SDKAuthError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKAuthError';
    }
}

class SDKMessagingError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKMessagingError';
    }
}

class SDKActionError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKActionError';
    }
}

class SDKMuSigError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKMuSigError';
    }
}

class SDKGatedFileError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKGatedFileError';
    }
}

class SDKPolicyError extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKPolicyError';
    }
}

class SDKX402Error extends SDKError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SDKX402Error';
    }
}

// Pre-flight verdict error (spec §4.2). Thrown under 'enforce' mode
// when a pre-flight run returns verdict 'fail'; `.report` carries the
// full PreflightReport so headless callers can inspect every finding.
// The code is always 'PREFLIGHT_FAIL'; the report distinguishes the
// specific findings. (Unparseable input throws SDKFormatError instead,
// a distinct catchable class, so callers can tell "bad input" from
// "would be rejected".)
class SDKPreflightError extends SDKError {
    constructor(message, report) {
        super('PREFLIGHT_FAIL', message, { report });
        this.name = 'SDKPreflightError';
        this.report = report;
    }
}

module.exports = {
    SDKError,
    SDKValidationError,
    SDKFormatError,
    SDKEncoderError,
    SDKExplorerError,
    SDKHubError,
    SDKConfigError,
    SDKContractError,
    SDKWalletError,
    SDKAuthError,
    SDKMessagingError,
    SDKActionError,
    SDKMuSigError,
    SDKGatedFileError,
    SDKPolicyError,
    SDKX402Error,
    SDKPreflightError
};
