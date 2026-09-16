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
 * XChain Platform SDK - BET (parimutuel betting) Helpers
 *
 * Pure builders for the four BET formats (see
 * xchain-documentation/protocol/actions/BET.md): v0 create a market, v1 cancel,
 * v2 place a bet, v3 resolve. Every rule mirrored here is a CONSENSUS rule the
 * indexer enforces; the point of duplicating them is that a malformed market
 * should fail in the caller's hands rather than after paying a fee to be
 * rejected on-chain. The SDK must never be stricter than consensus (that
 * refuses actions the protocol accepts) nor looser (that lets fees burn).
 *
 * The DETAILS schema lives here and is the single source of truth for it:
 * BET.md documents it, the wallet's create form is generated from it, and the
 * explorer renders against it. Only the shape rules the indexer actually checks
 * are enforced as errors (strict base64, size, JSON object, depth, and the
 * outcomes cross-check); every other key is convention and is validated only for
 * type, so a market carrying extra keys still composes.
 *
 * All pure: no network, no consensus. Submit-flow recipes live on
 * sdk.workflows (openMarket / placeBet / resolveMarket / cancelMarket); the raw
 * action wrapper is sdk.bet().
 *
 ********************************************************************/

const { BET_LIMITS, OUTCOME_FORBIDDEN, BET_DETAILS_SCHEMA, fail, jsonDepth } = require('./bet_rules.js');

function normalizeDetailsOutcomes(owner, out, options, ctx) {
    // Canonical outcomes, when the caller supplied them, are authoritative.
    if (options.outcomes !== undefined) {
        const canonical = owner.outcomeArray(options.outcomes, ctx);
        if (out.outcomes === undefined) {
            out.outcomes = canonical;
        } else {
            if (!Array.isArray(out.outcomes))
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: DETAILS.outcomes must be an array when present`, { field: 'DETAILS' });
            const given = out.outcomes.map(o => String(o == null ? '' : o).trim());
            if (given.length !== canonical.length || given.some((o, i) => o !== canonical[i]))
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: DETAILS.outcomes must match the OUTCOMES field exactly (same order, same count). ` +
                    `OUTCOMES=${JSON.stringify(canonical)} DETAILS.outcomes=${JSON.stringify(given)}`,
                    { field: 'DETAILS', outcomes: canonical, details: given });
            out.outcomes = given;
        }
    } else if (out.outcomes !== undefined && !Array.isArray(out.outcomes)) {
        fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS.outcomes must be an array when present`, { field: 'DETAILS' });
    }
}

function validateDetailsFields(out, ctx) {
    for (const [key, rule] of Object.entries(BET_DETAILS_SCHEMA)) {
        const value = out[key];
        if (value === undefined || value === null) {
            if (rule.required)
                fail('MISSING_REQUIRED_FIELD', `${ctx}: DETAILS.${key} is required`, { field: 'DETAILS', key });
            continue;
        }
        if (rule.type === 'string') {
            if (typeof value !== 'string')
                fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS.${key} must be a string`, { field: 'DETAILS', key });
            if (rule.required && value.trim() === '')
                fail('MISSING_REQUIRED_FIELD', `${ctx}: DETAILS.${key} is required`, { field: 'DETAILS', key });
            if (rule.maxLength && value.length > rule.maxLength)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: DETAILS.${key} is ${value.length} characters, max ${rule.maxLength}`,
                    { field: 'DETAILS', key, constraint: { max: rule.maxLength } });
        }
        if (rule.type === 'string[]') {
            if (!Array.isArray(value) || value.some(v => typeof v !== 'string'))
                fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS.${key} must be an array of strings`, { field: 'DETAILS', key });
        }
    }
}

module.exports = {
    // Normalize an OUTCOMES input (array of labels, or a comma string) to the
    // canonical stored form: trimmed labels, single-comma joined. Consensus
    // compares DETAILS.outcomes against THIS form, so both sides of a create
    // must be derived from it, never from the caller's raw input.
    outcomeArray(outcomes, ctx = 'betting') {
        let list = Array.isArray(outcomes)
            ? outcomes.map(o => String(o == null ? '' : o).trim())
            : String(outcomes == null ? '' : outcomes).split(',').map(o => o.trim());

        if (list.length < 2 || list.length > BET_LIMITS.MAX_BET_OUTCOMES)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: OUTCOMES must have between 2 and ${BET_LIMITS.MAX_BET_OUTCOMES} entries, got ${list.length}`,
                { field: 'OUTCOMES', count: list.length });

        for (const label of list) {
            if (label === '')
                fail('INVALID_FIELD_VALUE', `${ctx}: outcome labels may not be empty`, { field: 'OUTCOMES' });
            if (label.length > BET_LIMITS.MAX_BET_OUTCOME_LENGTH)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: outcome "${label}" is ${label.length} characters, max ${BET_LIMITS.MAX_BET_OUTCOME_LENGTH}`,
                    { field: 'OUTCOMES', value: label });
            if (OUTCOME_FORBIDDEN.test(label))
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: outcome "${label}" contains a comma, pipe, semicolon, or control character`,
                    { field: 'OUTCOMES', value: label });
        }

        // Byte-exact uniqueness. Case variants are legal on-chain but are almost
        // always a mistake, so they are reported as a distinct, softer message.
        const seen = new Set();
        for (const label of list) {
            if (seen.has(label))
                fail('INVALID_FIELD_VALUE', `${ctx}: duplicate outcome "${label}"`, { field: 'OUTCOMES', value: label });
            seen.add(label);
        }

        return list;
    },

    // Case-variant advisory. Not an error (consensus allows it), returned so a
    // wallet form can warn: "Yes" and "yes" are two different outcomes and
    // bettors will misread them.
    outcomeCaseCollisions(outcomes) {
        const list = Array.isArray(outcomes) ? outcomes.map(o => String(o).trim()) : this.outcomeArray(outcomes);
        const byLower = new Map();
        for (const label of list) {
            const key = label.toLowerCase();
            byLower.set(key, (byLower.get(key) || []).concat(label));
        }
        return [...byLower.values()].filter(group => group.length > 1);
    },

    // Validate a market-definition object against the DETAILS schema and return
    // it base64-encoded, ready for the DETAILS field.
    //
    // definition - the market definition object (see BET_DETAILS_SCHEMA)
    // options.outcomes - the market's OUTCOMES. When given, definition.outcomes
    //                    is cross-checked against it (and filled in when absent),
    //                    which is what stops OUTCOMES and DETAILS disagreeing.
    buildBetDetails(definition, options = {}) {
        const ctx = 'betting.buildBetDetails';

        if (definition === null || typeof definition !== 'object' || Array.isArray(definition))
            fail('INVALID_FIELD_VALUE', `${ctx}: definition must be a plain object`, { field: 'DETAILS' });

        const out = Object.assign({}, definition);

        normalizeDetailsOutcomes(this, out, options, ctx);
        validateDetailsFields(out, ctx);

        // outcome_details, when present, is one entry per outcome. Consensus does
        // not check this; a mismatched array just renders wrong, so catch it here.
        if (Array.isArray(out.outcome_details) && Array.isArray(out.outcomes) &&
            out.outcome_details.length !== out.outcomes.length)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: DETAILS.outcome_details has ${out.outcome_details.length} entries for ${out.outcomes.length} outcomes`,
                { field: 'DETAILS', key: 'outcome_details' });

        const json = JSON.stringify(out);
        const bytes = Buffer.byteLength(json, 'utf8');
        if (bytes > BET_LIMITS.MAX_BET_DETAILS_LENGTH)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: DETAILS is ${bytes} bytes, max ${BET_LIMITS.MAX_BET_DETAILS_LENGTH}. ` +
                'Shorten description or resolution_criteria; the whole market definition rides on-chain.',
                { field: 'DETAILS', value: bytes, constraint: { max: BET_LIMITS.MAX_BET_DETAILS_LENGTH } });

        const depth = jsonDepth(out);
        if (depth > BET_LIMITS.MAX_BET_DETAILS_DEPTH)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: DETAILS nests ${depth} levels deep, max ${BET_LIMITS.MAX_BET_DETAILS_DEPTH}`,
                { field: 'DETAILS', value: depth, constraint: { max: BET_LIMITS.MAX_BET_DETAILS_DEPTH } });

        return Buffer.from(json, 'utf8').toString('base64');
    },

    // Parse a DETAILS field back to its object form, applying the consensus
    // shape rules. Used by wallet/explorer render paths, which receive DETAILS
    // straight off the chain and must treat it as hostile input.
    parseBetDetails(details) {
        const ctx = 'betting.parseBetDetails';
        const b64 = String(details == null ? '' : details);

        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0)
            fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS is not strict base64`, { field: 'DETAILS' });

        const buf = Buffer.from(b64, 'base64');
        if (buf.toString('base64') !== b64)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: DETAILS is not canonical base64 (it does not re-encode to itself)`, { field: 'DETAILS' });
        if (buf.length > BET_LIMITS.MAX_BET_DETAILS_LENGTH)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: DETAILS decodes to ${buf.length} bytes, max ${BET_LIMITS.MAX_BET_DETAILS_LENGTH}`,
                { field: 'DETAILS' });

        let parsed;
        try { parsed = JSON.parse(buf.toString('utf8')); }
        catch (e) { fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS is not parseable JSON`, { field: 'DETAILS' }); }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS must decode to a JSON object`, { field: 'DETAILS' });
        if (jsonDepth(parsed) > BET_LIMITS.MAX_BET_DETAILS_DEPTH)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: DETAILS nests deeper than ${BET_LIMITS.MAX_BET_DETAILS_DEPTH} levels`, { field: 'DETAILS' });

        return parsed;
    }
};
