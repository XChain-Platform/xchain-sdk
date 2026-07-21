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
 * XChain Platform SDK - decoder display hardening
 *
 * decoder.describe() renders attacker-supplied strings to a user who
 * is about to authorize money movement. Free-text fields (MEMO,
 * BROADCAST text, DESCRIPTION, FILE name/title, MESSAGE) arrive
 * unchecked from dApps, so every interpolated value is neutralized
 * here first:
 *
 * - Bidi controls (U+202A-U+202E embedding/override, U+2066-U+2069
 *   isolates) can visually reverse an address or amount; they are
 *   replaced with a visible placeholder, never silently dropped
 *   (silent stripping would let "evil<RLO>txt" read clean).
 * - Zero-width characters (ZWSP/ZWNJ/ZWJ/BOM) enable homoglyph
 *   spoofing and copy-paste divergence; stripped.
 * - Amounts render through one canonical bignumber-aware formatter:
 *   exponential notation, precision beyond the tick's DECIMALS, and
 *   non-numeric junk come back flagged, never prettified. When
 *   DECIMALS is unknown the raw wire string renders verbatim with a
 *   "precision unverified" note - never a guessed normalization.
 * - Addresses truncate through one shared format so every surface
 *   shows the same head/tail window.
 *
 * All output is plain text; consumers must render as text nodes.
 *
 ********************************************************************/

'use strict';

// U+202A-U+202E (LRE/RLE/PDF/LRO/RLO) + U+2066-U+2069 (LRI/RLI/FSI/PDI)
// + U+200E/U+200F (LRM/RLM).
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;

// Zero-width space/non-joiner/joiner (U+200B-U+200D), word joiner
// (U+2060), BOM/ZWNBSP (U+FEFF).
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

// Visible stand-in for a removed bidi control: makes tampering evident
// without reproducing the directionality attack.
const BIDI_PLACEHOLDER = '␦'; // SYMBOL FOR SUBSTITUTE FORM TWO

/*
 * Neutralize a free-text value for display. Returns the sanitized
 * string; when `flags` is supplied, pushes a human-readable warning
 * for each neutralization applied so the UI can surface that the raw
 * value was altered.
 */
function sanitizeText(value, flags) {
    // Replace-then-compare instead of .test(): a /g regex's test() is
    // stateful (lastIndex) and would intermittently miss matches.
    let s = value === undefined || value === null ? '' : String(value);
    const noBidi = s.replace(BIDI_CONTROLS, BIDI_PLACEHOLDER);
    if (noBidi !== s) {
        s = noBidi;
        if (flags) flags.push('Text contains hidden direction-control characters (shown as ' + BIDI_PLACEHOLDER + '). Treat this transaction with suspicion.');
    }
    const noZw = s.replace(ZERO_WIDTH, '');
    if (noZw !== s) {
        s = noZw;
        if (flags) flags.push('Text contained invisible zero-width characters; they were removed for display.');
    }
    return s;
}

// Plain decimal amount: optional fraction, no sign, no exponent.
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/*
 * Canonical amount rendering.
 *
 * @param {*} value           raw wire amount string
 * @param {number|null} decimals  the tick's DECIMALS when known, else null
 * @param {string[]} [flags]  warning sink
 * @returns {string}          display string (the raw wire text; junk is
 *                            returned sanitized-verbatim but flagged)
 */
function formatAmount(value, decimals, flags) {
    const raw = value === undefined || value === null ? '' : String(value);
    if (raw === '') return raw;

    if (!PLAIN_DECIMAL.test(raw)) {
        if (flags) {
            if (/e/i.test(raw) && /^[-+0-9.eE]+$/.test(raw))
                flags.push('Amount "' + sanitizeText(raw) + '" uses exponential notation; the protocol will not accept it as written.');
            else
                flags.push('Amount "' + sanitizeText(raw) + '" is not a plain decimal number.');
        }
        return sanitizeText(raw);
    }

    const frac = raw.includes('.') ? raw.split('.')[1] : '';
    if (decimals === undefined || decimals === null) {
        if (frac.length > 0 && flags)
            flags.push('Amount precision could not be verified (token decimals unknown).');
        return raw;
    }
    if (frac.length > decimals && flags)
        flags.push('Amount has more decimal places (' + frac.length + ') than the token allows (' + decimals + '); the ledger will not accept it as written.');
    return raw;
}

/*
 * One shared address truncation: head 8 / tail 6 with an ellipsis.
 * Callers render the full address on tap/hover with copy; this is the
 * inline form only. Sanitized (an address should never contain bidi
 * or zero-width characters; if it does, that itself is the warning).
 */
function truncateAddress(address, flags) {
    const s = sanitizeText(address, flags);
    if (s.length <= 18) return s;
    return s.slice(0, 8) + '…' + s.slice(-6);
}

module.exports = {
    sanitizeText,
    formatAmount,
    truncateAddress,
    BIDI_CONTROLS,
    ZERO_WIDTH,
    BIDI_PLACEHOLDER,
};
