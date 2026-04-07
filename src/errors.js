/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
    SDKAuthError
};
