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
 * XChain Platform SDK - Retry with Exponential Backoff
 *
 * Configurable retry logic for transient network errors
 *
 ********************************************************************/

// HTTP status codes that are considered transient (worth retrying)
const RETRYABLE_STATUS_CODES = [429, 502, 503, 504];

const DEFAULTS = {
    maxRetries:    3,
    baseDelay:     1000,   // 1 second
    maxDelay:      30000,  // 30 seconds
    backoffFactor: 2,
    // A 429 is a policy answer with a wait attached, not a transient fault, so
    // it gets its own ceiling: maxDelay is tuned for how long a caller will sit
    // through 5xx backoff (the wallet uses 2 s), which is far shorter than the
    // window an origin actually asks a rate-limited client to wait out.
    retryAfterMaxDelay: 60000,  // 60 seconds
    // 429 retries are budgeted separately from maxRetries, so a caller on the
    // 3-retry default does not sit through three full Retry-After windows.
    maxRateLimitRetries: 1
};


// Determine if an axios error is retryable
function isRetryable(err) {
    // Network errors (ECONNRESET, ECONNREFUSED, timeout)
    if (!err.response) {
        if (err.code === 'ECONNABORTED') return true;
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') return true;
        return false;
    }
    return RETRYABLE_STATUS_CODES.includes(err.response.status);
}

// Parse a Retry-After header value into milliseconds
// Supports: integer seconds ("120") or HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT")
function parseRetryAfter(value) {
    if (!value) return null;
    let seconds = parseInt(value, 10);
    if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
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

// Parse a RateLimit-Reset header value (IETF draft standard headers): whole
// seconds until the current limit window resets. Milliseconds out, or null.
function parseRateLimitReset(value) {
    if (value === undefined || value === null || value === '') return null;
    let seconds = parseInt(value, 10);
    if (isNaN(seconds) || seconds < 0) return null;
    return seconds * 1000;
}

// How long a rate-limited response asks the caller to wait, in milliseconds.
// Retry-After is authoritative; RateLimit-Reset is the fallback for an origin
// that only emits the draft-standard headers. axios lower-cases header names.
function getRateLimitDelay(err) {
    let retryAfter = getRetryAfterDelay(err);
    if (retryAfter !== null) return retryAfter;
    if (!err || !err.response || !err.response.headers) return null;
    return parseRateLimitReset(err.response.headers['ratelimit-reset']);
}

// Whole seconds a rate-limited response asked for, or null when it carried
// neither header. Rounded UP: waiting less than the origin asked for just
// buys another 429. This is what the clients put on SDKRateLimitedError.
function getRetryAfterSeconds(err) {
    let ms = getRateLimitDelay(err);
    if (ms === null) return null;
    return Math.ceil(ms / 1000);
}

// Calculate delay with exponential backoff + jitter
// If the error has a Retry-After header, use that instead
function getDelay(attempt, config, err) {
    let status = (err && err.response) ? err.response.status : null;
    if (status === 429) {
        // Honour what the origin asked for, capped by retryAfterMaxDelay rather
        // than maxDelay, so the honoured wait is a real one instead of a 2 s
        // stub that walks straight into the next 429.
        let asked = getRateLimitDelay(err);
        if (asked !== null) {
            let cap = config.retryAfterMaxDelay !== undefined ? config.retryAfterMaxDelay : DEFAULTS.retryAfterMaxDelay;
            return Math.min(asked, cap);
        }
        // Neither header on the 429: fall through to the normal backoff.
    } else {
        let retryAfter = getRetryAfterDelay(err);
        if (retryAfter !== null) {
            return Math.min(retryAfter, config.maxDelay);
        }
    }
    let delay = config.baseDelay * Math.pow(config.backoffFactor, attempt);
    delay = Math.min(delay, config.maxDelay);
    // Add jitter: ±25%
    let jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(delay + jitter));
}

// Execute an async function with retry logic
// fn: async function to execute
// config: { maxRetries, baseDelay, maxDelay, backoffFactor, retryAfterMaxDelay, maxRateLimitRetries }
// onRetry: optional callback(attempt, delay, error) for logging/hooks
async function withRetry(fn, config = {}, onRetry = null) {
    let opts = {
        maxRetries:    config.maxRetries !== undefined ? config.maxRetries : DEFAULTS.maxRetries,
        baseDelay:     config.baseDelay !== undefined ? config.baseDelay : DEFAULTS.baseDelay,
        maxDelay:      config.maxDelay !== undefined ? config.maxDelay : DEFAULTS.maxDelay,
        backoffFactor: config.backoffFactor !== undefined ? config.backoffFactor : DEFAULTS.backoffFactor,
        retryAfterMaxDelay:  config.retryAfterMaxDelay !== undefined ? config.retryAfterMaxDelay : DEFAULTS.retryAfterMaxDelay,
        maxRateLimitRetries: config.maxRateLimitRetries !== undefined ? config.maxRateLimitRetries : DEFAULTS.maxRateLimitRetries
    };

    let lastError;
    let rateLimitRetries = 0;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            // 429s spend their own budget: past it the caller gets the rate
            // limit to surface, however many general retries are left.
            let isRateLimit = !!(err && err.response && err.response.status === 429);
            if (isRateLimit && rateLimitRetries >= opts.maxRateLimitRetries) {
                throw err;
            }

            if (attempt >= opts.maxRetries || !isRetryable(err)) {
                throw err;
            }

            if (isRateLimit) rateLimitRetries++;

            let delay = getDelay(attempt, opts, err);
            if (onRetry) onRetry(attempt + 1, delay, err);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}


module.exports = {
    withRetry, isRetryable, getDelay,
    parseRetryAfter, getRetryAfterDelay,
    parseRateLimitReset, getRateLimitDelay, getRetryAfterSeconds,
    DEFAULTS, RETRYABLE_STATUS_CODES
};
