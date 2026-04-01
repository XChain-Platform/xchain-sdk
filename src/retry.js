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
 * XChain Platform SDK - Retry with Exponential Backoff
 *
 * Configurable retry logic for transient network errors
 *
 ********************************************************************/

// HTTP status codes that are considered transient (worth retrying)
const RETRYABLE_STATUS_CODES = [429, 502, 503, 504];

// Default retry configuration
const DEFAULTS = {
    maxRetries:    3,
    baseDelay:     1000,   // 1 second
    maxDelay:      30000,  // 30 seconds
    backoffFactor: 2
};


// Determine if an axios error is retryable
function isRetryable(err) {
    // Network errors (ECONNRESET, ECONNREFUSED, timeout)
    if (!err.response) {
        // Timeout
        if (err.code === 'ECONNABORTED') return true;
        // Network errors
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') return true;
        return false;
    }
    // HTTP status codes
    return RETRYABLE_STATUS_CODES.includes(err.response.status);
}

// Parse a Retry-After header value into milliseconds
// Supports: integer seconds ("120") or HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT")
function parseRetryAfter(value) {
    if (!value) return null;
    // Integer seconds
    let seconds = parseInt(value, 10);
    if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
    // HTTP-date
    let date = new Date(value);
    if (!isNaN(date.getTime())) {
        let ms = date.getTime() - Date.now();
        return Math.max(0, ms);
    }
    return null;
}

// Extract Retry-After delay from an axios error response
function getRetryAfterDelay(err) {
    if (!err || !err.response || !err.response.headers) return null;
    let header = err.response.headers['retry-after'];
    return parseRetryAfter(header);
}

// Calculate delay with exponential backoff + jitter
// If the error has a Retry-After header, use that instead
function getDelay(attempt, config, err) {
    // Respect Retry-After header if present
    let retryAfter = getRetryAfterDelay(err);
    if (retryAfter !== null) {
        return Math.min(retryAfter, config.maxDelay);
    }
    let delay = config.baseDelay * Math.pow(config.backoffFactor, attempt);
    delay = Math.min(delay, config.maxDelay);
    // Add jitter: ±25%
    let jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(delay + jitter));
}

// Execute an async function with retry logic
// fn: async function to execute
// config: { maxRetries, baseDelay, maxDelay, backoffFactor }
// onRetry: optional callback(attempt, delay, error) for logging/hooks
async function withRetry(fn, config = {}, onRetry = null) {
    let opts = {
        maxRetries:    config.maxRetries !== undefined ? config.maxRetries : DEFAULTS.maxRetries,
        baseDelay:     config.baseDelay !== undefined ? config.baseDelay : DEFAULTS.baseDelay,
        maxDelay:      config.maxDelay !== undefined ? config.maxDelay : DEFAULTS.maxDelay,
        backoffFactor: config.backoffFactor !== undefined ? config.backoffFactor : DEFAULTS.backoffFactor
    };

    let lastError;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            // Don't retry if not retryable or if this was the last attempt
            if (attempt >= opts.maxRetries || !isRetryable(err)) {
                throw err;
            }

            let delay = getDelay(attempt, opts, err);
            if (onRetry) onRetry(attempt + 1, delay, err);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}


module.exports = { withRetry, isRetryable, getDelay, parseRetryAfter, getRetryAfterDelay, DEFAULTS, RETRYABLE_STATUS_CODES };
