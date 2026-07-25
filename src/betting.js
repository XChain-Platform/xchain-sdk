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

const mathjs = require('mathjs');
const { SDKValidationError } = require('./errors.js');

// Consensus limits, mirrored from the indexer's BET config (xchain-indexer
// src/config.js) and documented in protocol/actions/BET.md. These are NOT in
// the vendored protocol/constants.js because they are action limits rather than
// consensus primitives, the same treatment MAX_TICK_LENGTH / MAX_MEMO_LENGTH
// get in validator.js. They must stay byte-equal with the indexer; the SDK
// being more permissive burns fees, being stricter blocks valid markets.
const BET_LIMITS = {
    MAX_BET_LABEL_LENGTH:      250,
    MAX_BET_OUTCOMES:          16,
    MAX_BET_OUTCOME_LENGTH:    64,
    MAX_FEED_FEE:              10,
    DEFAULT_BET_REFUND_WINDOW: 1209600,   // 14 days, Counterparty parity
    MIN_BET_REFUND_WINDOW:     3600,      // 1 hour
    MAX_BET_REFUND_WINDOW:     31536000,  // 1 year
    // DECODED bytes. DETAILS rides the wire base64-encoded (+33%) and the whole
    // ACTION string shares one 8192-byte compiled ceiling with LABEL, OUTCOMES,
    // TICK and MEMO, so this cannot be raised without re-deriving the worst-case
    // create. xchain-decoder/test/unit/betActionGate.test.js pins the arithmetic.
    MAX_BET_DETAILS_LENGTH:    4096,
    MAX_BET_DETAILS_DEPTH:     8,
    MAX_BETS_PER_FEED:         10000,
    MAX_BET_DEADLINE_HORIZON:  31536000   // 1 year past the block time
};

// Characters an outcome label may not contain: the OUTCOMES separator, the
// field separator, the BATCH command separator, and ASCII control characters
// (which render invisibly and would let two labels look identical). Spaces and
// ordinary punctuation are fine: "Kansas City Chiefs" is a normal label.
// eslint-disable-next-line no-control-regex
const OUTCOME_FORBIDDEN = /[,|;]|[\x00-\x1f\x7f]/;

// The DETAILS JSON schema. `required` and `type` are enforced by
// buildBetDetails; unknown keys are preserved untouched so a market can carry
// application-specific data the protocol never looks at.
const BET_DETAILS_SCHEMA = {
    title:               { type: 'string',   required: true,  maxLength: 250 },
    description:         { type: 'string',   required: false, maxLength: 2000 },
    outcomes:            { type: 'string[]', required: false },
    outcome_details:     { type: 'string[]', required: false },
    resolution_criteria: { type: 'string',   required: false, maxLength: 1000 },
    source:              { type: 'string',   required: false, maxLength: 500 },
    category:            { type: 'string',   required: false, maxLength: 64 }
};

function isSet(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
}

function fail(code, message, context) {
    throw new SDKValidationError(code, message, context || {});
}

// Nesting depth of a parsed JSON value. A scalar is depth 1, so a flat object
// is depth 2. Mirrors the indexer's walk, which is what MAX_BET_DETAILS_DEPTH
// bounds: the cap exists so the explorer renderer and this validator cannot be
// driven into deep recursion by attacker-chosen on-chain input.
function jsonDepth(value, depth = 1) {
    if (value === null || typeof value !== 'object') return depth;
    let max = depth;
    for (const key of Object.keys(value))
        max = Math.max(max, jsonDepth(value[key], depth + 1));
    return max;
}


class BettingHelpers {

    get LIMITS()         { return Object.assign({}, BET_LIMITS); }
    // A copy, so a caller building a form cannot mutate the shared schema.
    get DETAILS_SCHEMA() { return JSON.parse(JSON.stringify(BET_DETAILS_SCHEMA)); }

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
    }

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
    }

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

        // Canonical outcomes, when the caller supplied them, are authoritative.
        if (options.outcomes !== undefined) {
            const canonical = this.outcomeArray(options.outcomes, ctx);
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
    }

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

    // Build BET v0 params (create a market).
    //
    // `details` may be a plain object (encoded here, and cross-checked against
    // `outcomes` so the two can never disagree) or an already-encoded base64
    // string (validated, and its outcomes cross-checked if it carries any).
    // `now` is injectable so deadline pre-flight is testable; it defaults to the
    // local clock, which approximates BLOCK_TIME closely enough for a warning.
    createMarketParams({
        label, outcomes, tick, fee, deadline, refundWindow, minAmount,
        allowList, blockList, details, memo, now
    } = {}) {
        const ctx = 'betting.createMarketParams';

        if (!isSet(label)) fail('MISSING_REQUIRED_FIELD', `${ctx}: label is required`, { field: 'LABEL' });
        const labelStr = String(label);
        if (labelStr.length > BET_LIMITS.MAX_BET_LABEL_LENGTH)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: label is ${labelStr.length} characters, max ${BET_LIMITS.MAX_BET_LABEL_LENGTH}`,
                { field: 'LABEL' });

        const outcomeList = this.outcomeArray(outcomes, ctx);

        // Native coin is rejected at parse: stakes must be escrowable, and a
        // native-coin wager would need COINPAY-style obligation machinery.
        if (!isSet(tick))
            fail('MISSING_REQUIRED_FIELD',
                `${ctx}: tick is required. Betting is token-only; native coin (empty TICK) is not supported`,
                { field: 'TICK' });

        if (!isSet(deadline)) fail('MISSING_REQUIRED_FIELD', `${ctx}: deadline is required`, { field: 'DEADLINE' });
        const deadlineNum = Number(deadline);
        if (!Number.isInteger(deadlineNum) || deadlineNum <= 0)
            fail('INVALID_FIELD_VALUE', `${ctx}: deadline must be a positive integer Unix timestamp`, { field: 'DEADLINE', value: deadline });
        const nowSec = Number.isFinite(Number(now)) ? Number(now) : Math.floor(Date.now() / 1000);
        if (deadlineNum <= nowSec)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: deadline ${deadlineNum} is in the past (now ${nowSec}). Betting closes at the deadline, so it must be ahead of the block time`,
                { field: 'DEADLINE', value: deadlineNum });
        if (deadlineNum - nowSec > BET_LIMITS.MAX_BET_DEADLINE_HORIZON)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: deadline is more than ${BET_LIMITS.MAX_BET_DEADLINE_HORIZON} seconds ahead, the protocol maximum`,
                { field: 'DEADLINE', value: deadlineNum });

        let feeOut = '';
        if (isSet(fee)) {
            const feeStr = String(fee).trim();
            if (!/^\d+(\.\d{1,2})?$/.test(feeStr))
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: fee must be a number with at most 2 decimal places. It is a PERCENT of the pot: 1.00 means 1%`,
                    { field: 'FEE', value: fee });
            if (Number(feeStr) > BET_LIMITS.MAX_FEED_FEE)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: fee ${feeStr}% exceeds the maximum ${BET_LIMITS.MAX_FEED_FEE}%`,
                    { field: 'FEE', value: feeStr, constraint: { max: BET_LIMITS.MAX_FEED_FEE } });
            feeOut = feeStr;
        }

        let refundOut = '';
        if (isSet(refundWindow)) {
            const rw = Number(refundWindow);
            if (!Number.isInteger(rw) || rw < BET_LIMITS.MIN_BET_REFUND_WINDOW || rw > BET_LIMITS.MAX_BET_REFUND_WINDOW)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: refundWindow must be an integer between ${BET_LIMITS.MIN_BET_REFUND_WINDOW} and ${BET_LIMITS.MAX_BET_REFUND_WINDOW} seconds`,
                    { field: 'REFUND_WINDOW', value: refundWindow });
            refundOut = String(rw);
        }

        let minOut = '';
        if (isSet(minAmount)) {
            const min = String(minAmount).trim();
            if (!/^\d+(\.\d+)?$/.test(min) || Number(min) <= 0)
                fail('INVALID_FIELD_VALUE', `${ctx}: minAmount must be a positive amount`, { field: 'MIN_AMOUNT', value: minAmount });
            minOut = min;
        }

        const allowOut = isSet(allowList) ? this._actionIndex(allowList, 'ALLOW_LIST', ctx) : '';
        const blockOut = isSet(blockList) ? this._actionIndex(blockList, 'BLOCK_LIST', ctx) : '';
        if (allowOut !== '' && blockOut !== '' && allowOut === blockOut)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: allowList and blockList are the same list (${allowOut}). Nobody could ever bet on that market`,
                { field: 'BLOCK_LIST', value: blockOut });

        let detailsOut = '';
        if (details !== undefined && details !== null && details !== '') {
            if (typeof details === 'object') {
                detailsOut = this.buildBetDetails(details, { outcomes: outcomeList });
            } else {
                // Already encoded: validate it, and cross-check any outcomes it
                // carries, so a hand-rolled DETAILS cannot silently disagree.
                const parsed = this.parseBetDetails(details);
                if (parsed.outcomes !== undefined) {
                    if (!Array.isArray(parsed.outcomes))
                        fail('INVALID_FIELD_VALUE', `${ctx}: DETAILS.outcomes must be an array when present`, { field: 'DETAILS' });
                    const given = parsed.outcomes.map(o => String(o == null ? '' : o).trim());
                    if (given.length !== outcomeList.length || given.some((o, i) => o !== outcomeList[i]))
                        fail('INVALID_FIELD_VALUE',
                            `${ctx}: DETAILS.outcomes must match the OUTCOMES field exactly (same order, same count)`,
                            { field: 'DETAILS', outcomes: outcomeList, details: given });
                }
                detailsOut = String(details);
            }
        }

        return {
            version:      0,
            label:        labelStr,
            outcomes:     outcomeList.join(','),
            tick:         String(tick),
            fee:          feeOut,
            deadline:     String(deadlineNum),
            refundWindow: refundOut,
            minAmount:    minOut,
            allowList:    allowOut,
            blockList:    blockOut,
            details:      detailsOut,
            memo:         isSet(memo) ? String(memo) : ''
        };
    }

    // Build BET v1 params (cancel a market). Owner-only on-chain.
    cancelMarketParams({ feedActionIndex, memo } = {}) {
        const ctx = 'betting.cancelMarketParams';
        return {
            version:         1,
            feedActionIndex: this._actionIndex(feedActionIndex, 'FEED_ACTION_INDEX', ctx),
            memo:            isSet(memo) ? String(memo) : ''
        };
    }

    // Build BET v2 params (place a bet).
    //
    // `outcome` is the ZERO-BASED index into the market's OUTCOMES, not a label.
    // Pass `outcomes` to resolve a label to its index and to range-check it.
    placeBetParams({ feedActionIndex, outcome, amount, outcomes, memo } = {}) {
        const ctx = 'betting.placeBetParams';
        const feed = this._actionIndex(feedActionIndex, 'FEED_ACTION_INDEX', ctx);

        const index = this.outcomeIndex(outcome, outcomes, ctx);

        if (!isSet(amount)) fail('MISSING_REQUIRED_FIELD', `${ctx}: amount is required`, { field: 'AMOUNT' });
        const amt = String(amount).trim();
        if (!/^\d+(\.\d+)?$/.test(amt) || Number(amt) <= 0)
            fail('INVALID_FIELD_VALUE', `${ctx}: amount must be a positive stake`, { field: 'AMOUNT', value: amount });

        return {
            version:         2,
            feedActionIndex: feed,
            outcome:         String(index),
            amount:          amt,
            memo:            isSet(memo) ? String(memo) : ''
        };
    }

    // Build BET v3 params (resolve a market to an outcome). Owner-only on-chain.
    resolveMarketParams({ feedActionIndex, outcome, outcomes, memo } = {}) {
        const ctx = 'betting.resolveMarketParams';
        return {
            version:         3,
            feedActionIndex: this._actionIndex(feedActionIndex, 'FEED_ACTION_INDEX', ctx),
            outcome:         String(this.outcomeIndex(outcome, outcomes, ctx)),
            memo:            isSet(memo) ? String(memo) : ''
        };
    }

    // Resolve an outcome to its wire index. Accepts the index itself, or a label
    // when the market's `outcomes` are supplied. Range-checked against the
    // market when known, because an out-of-range OUTCOME is rejected on-chain
    // after the fee is paid.
    outcomeIndex(outcome, outcomes, ctx = 'betting') {
        if (!isSet(outcome) && outcome !== 0)
            fail('MISSING_REQUIRED_FIELD', `${ctx}: outcome is required`, { field: 'OUTCOME' });

        const list = outcomes === undefined ? null : this.outcomeArray(outcomes, ctx);

        // A label is only accepted when the market's outcomes are known. A
        // numeric string is always read as an index: outcome labels that look
        // like numbers ("0", "1") are legal, so guessing would be ambiguous.
        if (!/^\d+$/.test(String(outcome).trim())) {
            if (!list)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: outcome "${outcome}" is not an index. Pass the market's outcomes to resolve a label`,
                    { field: 'OUTCOME', value: outcome });
            const found = list.indexOf(String(outcome).trim());
            if (found === -1)
                fail('INVALID_FIELD_VALUE',
                    `${ctx}: outcome "${outcome}" is not one of ${JSON.stringify(list)}`,
                    { field: 'OUTCOME', value: outcome });
            return found;
        }

        const index = Number(String(outcome).trim());
        if (list && index >= list.length)
            fail('INVALID_FIELD_VALUE',
                `${ctx}: outcome index ${index} is out of range for ${list.length} outcomes (0..${list.length - 1})`,
                { field: 'OUTCOME', value: index, constraint: { max: list.length - 1 } });
        return index;
    }

    // Projected payout for a prospective stake at the current pools, computed in
    // the exact operation order and rounding direction settlement uses: fee is
    // floored first, then each payout is floored against the post-fee pot.
    //
    // Display-only. The real payout runs on the pools as they stand at resolve
    // time, and every later bet moves them. It is still done in mathjs bignumber
    // rather than JS floats, both because the amounts can carry 18 decimals and
    // because a projection that disagrees with the settled amount in the last
    // decimal place reads as a bug to the user. All values are returned as
    // fixed-decimal STRINGS at the token's precision, for the same reason.
    //
    // Returns null when the projection is undefined (an empty winning pool).
    //
    // pools    - per-outcome staked totals, indexed like OUTCOMES
    // outcome  - the outcome index being backed
    // stake    - the prospective stake
    // feePct   - the market's FEE, as a percent (1.00 = 1%)
    // decimals - the wager token's DECIMALS
    projectPayout({ pools, outcome, stake, feePct = 0, decimals = 8 } = {}) {
        const ctx = 'betting.projectPayout';
        if (!Array.isArray(pools)) fail('INVALID_FIELD_VALUE', `${ctx}: pools must be an array`, { field: 'pools' });

        const index = Number(outcome);
        if (!Number.isInteger(index) || index < 0 || index >= pools.length)
            fail('INVALID_FIELD_VALUE', `${ctx}: outcome is out of range for the pools given`, { field: 'outcome' });

        const d = Number(decimals);
        if (!Number.isInteger(d) || d < 0 || d > 18)
            fail('INVALID_FIELD_VALUE', `${ctx}: decimals must be an integer between 0 and 18`, { field: 'decimals' });

        const bn = mathjs.bignumber;
        const stakeBn = bn(String(stake == null ? 0 : stake));
        if (!(stakeBn.gt(0))) fail('INVALID_FIELD_VALUE', `${ctx}: stake must be positive`, { field: 'stake' });

        // Floor at `d` decimals. mathjs `format` with a precision ROUNDS, which
        // would overstate a payout by one base unit; settlement floors.
        const scale = mathjs.pow(bn(10), d);
        const floorAt = v => mathjs.divide(mathjs.floor(mathjs.multiply(v, scale)), scale);
        const fixed   = v => mathjs.format(v, { notation: 'fixed', precision: d });

        const total   = pools.reduce((sum, p) => mathjs.add(sum, bn(String(p == null ? 0 : p))), bn(0));
        const totalIn = mathjs.add(total, stakeBn);
        const winning = mathjs.add(bn(String(pools[index] == null ? 0 : pools[index])), stakeBn);
        if (!winning.gt(0)) return null;

        const fee    = floorAt(mathjs.divide(mathjs.multiply(totalIn, bn(String(feePct))), bn(100)));
        const pot    = mathjs.subtract(totalIn, fee);
        const payout = floorAt(mathjs.divide(mathjs.multiply(stakeBn, pot), winning));

        return {
            payout:      fixed(payout),
            profit:      fixed(mathjs.subtract(payout, stakeBn)),
            // Gross return per unit staked, the number a market page shows as
            // odds. Carried at 8 decimals regardless of the token's precision:
            // it is a ratio for display, not an amount.
            impliedOdds: mathjs.format(mathjs.divide(payout, stakeBn), { notation: 'fixed', precision: 8 }),
            total:       fixed(totalIn),
            winningPool: fixed(winning),
            fee:         fixed(fee)
        };
    }

    _actionIndex(value, field, ctx) {
        if (!isSet(value))
            fail('MISSING_REQUIRED_FIELD', `${ctx}: ${field} is required`, { field });
        const str = String(value).trim();
        if (!/^\d+$/.test(str))
            fail('INVALID_FIELD_VALUE', `${ctx}: ${field} must be a numeric ACTION_INDEX`, { field, value });
        return str;
    }

}

module.exports = BettingHelpers;
module.exports.BET_LIMITS = BET_LIMITS;
module.exports.BET_DETAILS_SCHEMA = BET_DETAILS_SCHEMA;
