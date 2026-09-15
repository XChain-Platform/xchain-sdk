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
 * XChain Platform SDK - Validator
 *
 * Per-action input validation rules for all 30 ACTION types
 *
 ********************************************************************/

// Safe at the top, measured rather than assumed: nothing betting.js loads at
// require time leads back here, so no cycle can hand this file a half-built
// module. The decoder's parse below is the opposite case and stays in its body.
const { BET_LIMITS } = require('../../actions/betting.js');
// BATCH limit scan (command cap + dotted-TICK child classification), shared
// with the builder, the decoder mirror and pre-flight. See src/protocol/batch_limits.js.
const {
    BATCH_ACTION_LIMITS_ACTIVE,
    BATCH_COMMAND_LIMIT,
    BATCH_WEIGHT_BUDGET,
    CHILD_ISSUE_KEY,
    batchWeight,
    classifyCommand,
    commandTick,
    limitKeysInListOrder,
    maxMintsPerDistinctTick,
} = require('../batch_limits.js');
const { BATCH_LIMIT_MESSAGES } = require('./field_limits.js');
module.exports = {
    _validateBatch(fields) {
        let errors = [];
        if (this._isEmpty(fields.COMMAND)) return errors;

        let commands = String(fields.COMMAND).split(';');
        // Occurrences per counting key, and the MINT TICKs, collected in ONE
        // pass so the two can never disagree about which entries are MINTs.
        let counts = {};
        let mintTicks = [];
        let fileCount = 0;

        // Global command cap, FIRST and alone. The arbiter rejects an over-cap
        // BATCH as one record before any other scan runs, so reporting the cap
        // and stopping mirrors both the verdict and its precedence - and spares
        // the caller a full per-command parse of a batch the chain never reads.
        // Empty elements count, exactly as they do on-chain.
        if (commands.length > BATCH_COMMAND_LIMIT) {
            errors.push(this._error('BATCH_CONSTRAINT',
                'BATCH can contain at most ' + BATCH_COMMAND_LIMIT + ' commands',
                { count: commands.length, limit: BATCH_COMMAND_LIMIT }));
            return errors;
        }

        // BATCH_COST_WEIGHTING: the same whole-batch rejection, reached by
        // WEIGHT instead of count, in the same position the arbiter checks it.
        // Weighed only when the count already fits, which is the arbiter's own
        // ordering: every weight is an integer >= 1, so the count check is a
        // sound pre-filter and a batch over the count reports the count. The
        // early return mirrors the cap's precedence too: on-chain the budget
        // rejects the batch before any per-action scan runs, so per-command
        // findings here would describe rules the chain never reads.
        let weight = batchWeight(commands);
        if (weight > BATCH_WEIGHT_BUDGET) {
            errors.push(this._error('BATCH_CONSTRAINT',
                'BATCH commands weigh ' + weight + ' (VM and fan-out actions cost more than 1 each); '
                + 'the chain rejects the whole batch above a total weight of ' + BATCH_WEIGHT_BUDGET,
                { count: commands.length, weight, limit: BATCH_WEIGHT_BUDGET }));
            return errors;
        }

        for (let i = 0; i < commands.length; i++) {
            let cmd = commands[i];
            // Child (dotted-TICK) issuances are exempt from the top-level limit
            // of 1; a caret TICK never is. classifyCommand reads the TICK the
            // executor will see, so a legacy no-VERSION command classifies off
            // params[0] the same way the arbiter's injection makes it params[1].
            let key = classifyCommand(cmd);
            counts[key] = (counts[key] || 0) + 1;
            if (key === 'MINT') mintTicks.push(commandTick(cmd));
            if (key === 'FILE') fileCount++;

            // Nested BATCH is reported HERE rather than with the counted caps
            // below because this is also where descent stops: handing a child
            // BATCH to _validateBatchCommand would re-enter this method.
            if (key === 'BATCH') {
                errors.push(this._error('BATCH_CONSTRAINT', 'BATCH cannot contain nested BATCH actions'));
                continue;                         // never descend into a forbidden child
            }

            errors.push(...this._validateBatchCommand(cmd, i));
        }

        // MINT is capped per DISTINCT token, not per occurrence: minting twelve
        // different tokens in one transaction takes nothing from anyone, while a
        // batch of 100 MINTs of ONE fair-mint token beats 100 separate
        // transactions on both fee and in-block ordering.
        let mint = mintTicks.length ? maxMintsPerDistinctTick(mintTicks) : { max: 0, approximate: false };

        // The caps come from the shared mirror, so a limit change (or a new
        // capped action) lands in batch_limits.js alone. BATCH is skipped: its
        // limit of 0 was already reported per occurrence in the descent-stop
        // above. Worth stating where a caller reads these findings:
        // BATCH_ISSUANCE_LIMITS is ARMED on every network (mainnet at
        // 2026-08-16T00:00:00Z, testnet and regtest at genesis), so the
        // LOOSENINGS this accepts (a parent plus children, MINTs of several
        // distinct tokens) are accepted on chain as well. Below the mainnet
        // instant they are rejected on chain; DEPLOY is the one rule both
        // sides of the flag agree on, since the chain never caps it below the
        // flag and at most 1 is accepted either way. Keys are read in
        // FIRST-APPEARANCE order (spec R2b) through the shared mirror, never
        // `Object.keys` insertion order.
        for (let key of limitKeysInListOrder(commands)) {
            let limit = BATCH_ACTION_LIMITS_ACTIVE[key];
            if (limit === undefined || key === 'BATCH') continue;
            let observed = key === 'MINT' ? mint.max : counts[key];
            if (observed > limit)
                errors.push(this._error('BATCH_CONSTRAINT',
                    BATCH_LIMIT_MESSAGES[key] || ('BATCH can contain at most ' + limit + ' ' + key + ' action(s)'),
                    { count: observed, limit }));
        }

        // Reported after the counted caps so a batch already over a limit on the
        // strings alone gets that precise finding first. What is left is a shape
        // whose verdict genuinely depends on a resolution only an indexer can do:
        // `JDOG` and `^614` can name ONE token, which would be two bites at one
        // scarce token. This is the compose-side pre-check, the last point where
        // the caller can still fix the spelling, so it refuses. decoder/parse.js
        // reuses this method under `validate: true`, which is why the message
        // claims only what is true on BOTH paths - that this SDK cannot resolve
        // the pair - and never that the chain rejected the batch.
        //
        // `approximate` is already exactly this shape and nothing narrower is
        // needed here: the seam sets it only when a caret coexists with a
        // NON-caret key. An ALL-caret set is two distinct ids by construction
        // and is left alone deliberately - refusing it would be a false refusal
        // reachable by default, because tickResolver COMPACTS a MINT's TICK to
        // `^<id>` before serializing, so the SDK's own builder normally emits
        // all-caret MINT batches.
        if (mint.approximate)
            errors.push(this._error('BATCH_CONSTRAINT',
                'BATCH mixes a `^<id>` MINT TICK with another MINT: a caret alias and a name can be the ' +
                'SAME token, which this SDK cannot resolve. Spell every MINT TICK by name.',
                { ticks: mintTicks.slice() }));

        if (fileCount > 1)
            errors.push(this._error('BATCH_CONSTRAINT', 'BATCH can contain at most 1 FILE action (one rawData per transaction)', { count: fileCount }));

        return errors;
    },
    // Validate ONE raw BATCH child command through the AUTHORITATIVE action path.
    // The loop above only ever read parts[0] to count MINT/ISSUE/FILE, so a child
    // like 'NOTREAL|0|x', or a real action carrying the wrong field count or an
    // invalid value, passed validateAction untouched and got serialized, encoded
    // and paid for before the chain rejected it. Rather than re-derive the
    // per-action rules here (a second copy is exactly how this pre-check and the
    // decoder drifted apart), run the child through decoder/parse, which owns the
    // action name, alias, version, field-mapping and value rules.
    //
    // The require is deferred because decoder/parse.js requires THIS module at
    // load time. By the time any BATCH is validated both halves are resolved, so
    // deferring breaks the cycle instead of papering over it. Recursion is bounded:
    // a BATCH child is rejected above and never reaches here, so a child parse can
    // never re-enter _validateBatch.
    _validateBatchCommand(cmd, index) {
        const { parse } = require('../../decoder/parse.js');
        let res;
        try {
            res = parse(cmd, { validate: true });
        } catch (e) {
            return [this._error('BATCH_COMMAND_INVALID',
                'BATCH command ' + index + ' could not be parsed: ' + e.message,
                { index, command: cmd })];
        }
        if (!res || res.ok === false)
            return [this._error('BATCH_COMMAND_INVALID',
                'BATCH command ' + index + ' is not a valid action: ' +
                    ((res && res.code) || 'PARSE_FAILED') + ((res && res.detail) ? ' (' + res.detail + ')' : ''),
                { index, command: cmd, code: (res && res.code) || 'PARSE_FAILED' })];
        // Carry the child's own findings up, tagged with its position so the
        // caller can point at the offending command rather than the whole batch.
        const findings = (res.validation && res.validation.findings) || [];
        return findings.map(f => this._error(f.code,
            'BATCH command ' + index + ' (' + res.action + '): ' + f.message,
            Object.assign({ index, command: cmd }, f.details || {})));
    },
    // BET-specific validation. Mirrors the consensus rules in
    // xchain-documentation/protocol/actions/BET.md so a malformed market fails in
    // the caller's hands instead of after paying a fee. Stateless only: whether
    // the market is open, whether the tick has a `trade` controller, whether the
    // bettor is the oracle, and gating-list membership are all indexer-owned.
    //
    // The three FEED_ACTION_INDEX formats are told apart by the fields present,
    // matching the format table: cancel carries neither OUTCOME nor AMOUNT,
    // resolve carries OUTCOME, place carries OUTCOME + AMOUNT.
    _validateBet(fields) {
        let errors = [];
        const limits = BET_LIMITS;
        const isCreate = this._isEmpty(fields.FEED_ACTION_INDEX);

        if (isCreate) {
            // LABEL length. Presence is handled by ACTION_REQUIRED_FIELDS.
            if (!this._isEmpty(fields.LABEL) && String(fields.LABEL).length > limits.MAX_BET_LABEL_LENGTH)
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'LABEL must be ' + limits.MAX_BET_LABEL_LENGTH + ' characters or less',
                    { field: 'LABEL', value: String(fields.LABEL).length, constraint: { max: limits.MAX_BET_LABEL_LENGTH } }));

            // OUTCOMES: 2..MAX entries, each non-empty, length-capped, and
            // byte-unique after trim. Case variants are legal, so not checked.
            if (!this._isEmpty(fields.OUTCOMES)) {
                const labels = String(fields.OUTCOMES).split(',').map(o => o.trim());
                if (labels.length < 2 || labels.length > limits.MAX_BET_OUTCOMES)
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'OUTCOMES must have between 2 and ' + limits.MAX_BET_OUTCOMES + ' comma-separated entries',
                        { field: 'OUTCOMES', value: labels.length }));
                if (labels.some(l => l === ''))
                    errors.push(this._error('INVALID_FIELD_VALUE', 'OUTCOMES entries may not be empty', { field: 'OUTCOMES' }));
                if (labels.some(l => l.length > limits.MAX_BET_OUTCOME_LENGTH))
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'each OUTCOMES entry must be ' + limits.MAX_BET_OUTCOME_LENGTH + ' characters or less',
                        { field: 'OUTCOMES', constraint: { max: limits.MAX_BET_OUTCOME_LENGTH } }));
                if (new Set(labels).size !== labels.length)
                    errors.push(this._error('INVALID_FIELD_VALUE', 'OUTCOMES entries must be unique', { field: 'OUTCOMES' }));
            }

            // Betting is token-only: an empty TICK means native coin, which
            // cannot be escrowed at parse. Presence is required above, so this
            // only catches a whitespace-only tick.
            if (!this._isEmpty(fields.TICK) && String(fields.TICK).trim() === '')
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'TICK is required: betting is token-only and native coin is not supported',
                    { field: 'TICK' }));

            // FEE is a PERCENT of the pot (1.00 = 1%), at most 2 decimals.
            if (!this._isEmpty(fields.FEE)) {
                const fee = String(fields.FEE).trim();
                if (!/^\d+(\.\d{1,2})?$/.test(fee))
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'FEE must be a non-negative number with at most 2 decimal places (a percent of the pot: 1.00 = 1%)',
                        { field: 'FEE', value: fields.FEE }));
                else if (Number(fee) > limits.MAX_FEED_FEE)
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'FEE must be at most ' + limits.MAX_FEED_FEE + ' percent',
                        { field: 'FEE', value: fee, constraint: { max: limits.MAX_FEED_FEE } }));
            }

            // DEADLINE is a Unix timestamp. "In the future" is a block-time
            // question the indexer owns; only the shape is checked here.
            if (!this._isEmpty(fields.DEADLINE)) {
                const dl = Number(fields.DEADLINE);
                if (!Number.isInteger(dl) || dl <= 0)
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'DEADLINE must be a positive integer Unix timestamp',
                        { field: 'DEADLINE', value: fields.DEADLINE }));
            }

            if (!this._isEmpty(fields.REFUND_WINDOW)) {
                const rw = Number(fields.REFUND_WINDOW);
                if (!Number.isInteger(rw) || rw < limits.MIN_BET_REFUND_WINDOW || rw > limits.MAX_BET_REFUND_WINDOW)
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'REFUND_WINDOW must be an integer between ' + limits.MIN_BET_REFUND_WINDOW +
                        ' and ' + limits.MAX_BET_REFUND_WINDOW + ' seconds',
                        { field: 'REFUND_WINDOW', value: fields.REFUND_WINDOW }));
            }

            if (!this._isEmpty(fields.MIN_AMOUNT)) {
                if (!this.util.isNumeric(fields.MIN_AMOUNT) || Number(fields.MIN_AMOUNT) <= 0)
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'MIN_AMOUNT must be a positive amount',
                        { field: 'MIN_AMOUNT', value: fields.MIN_AMOUNT }));
            }

            // The same list in both slots builds a market nobody can ever bet on.
            if (!this._isEmpty(fields.ALLOW_LIST) && !this._isEmpty(fields.BLOCK_LIST) &&
                String(fields.ALLOW_LIST).trim() === String(fields.BLOCK_LIST).trim())
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'BLOCK_LIST must differ from ALLOW_LIST: the same list in both slots bars every address',
                    { field: 'BLOCK_LIST', value: fields.BLOCK_LIST }));

            // DETAILS: strict base64 of a JSON object, size- and depth-capped,
            // with any `outcomes` key matching OUTCOMES byte-for-byte.
            if (!this._isEmpty(fields.DETAILS))
                errors.push(...this._validateBetDetails(String(fields.DETAILS), fields.OUTCOMES, limits));

        } else {
            // Lifecycle formats. FEED_ACTION_INDEX is the market reference.
            if (!/^\d+$/.test(String(fields.FEED_ACTION_INDEX).trim()))
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'FEED_ACTION_INDEX must be a numeric ACTION_INDEX',
                    { field: 'FEED_ACTION_INDEX', value: fields.FEED_ACTION_INDEX }));

            // OUTCOME is a zero-based index. Its upper bound depends on the
            // market's outcome count, which is on-chain state, so only the
            // non-negative-integer shape is checkable here.
            if (!this._isEmpty(fields.OUTCOME) || fields.OUTCOME === 0 || fields.OUTCOME === '0') {
                if (!/^\d+$/.test(String(fields.OUTCOME).trim()))
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'OUTCOME must be a zero-based integer index into the market OUTCOMES',
                        { field: 'OUTCOME', value: fields.OUTCOME }));
            }

            if (!this._isEmpty(fields.AMOUNT)) {
                if (!this.util.isNumeric(fields.AMOUNT) || Number(fields.AMOUNT) <= 0)
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'AMOUNT must be a positive stake',
                        { field: 'AMOUNT', value: fields.AMOUNT }));
            }

            // A place-bet needs an outcome to stake on. Without this an AMOUNT
            // with no OUTCOME selects format 1 (cancel) and silently becomes a
            // different action than the caller meant.
            if (!this._isEmpty(fields.AMOUNT) && this._isEmpty(fields.OUTCOME) &&
                fields.OUTCOME !== 0 && fields.OUTCOME !== '0')
                errors.push(this._error('MISSING_REQUIRED_FIELD',
                    'BET place-bet requires OUTCOME alongside AMOUNT',
                    { field: 'OUTCOME' }));
        }

        return errors;
    },
    // DETAILS shape rules, shared by the create path. Kept separate because the
    // explorer and wallet render paths need the same checks against on-chain
    // (therefore hostile) input; betting.js parseBetDetails is the throwing twin.
    _validateBetDetails(details, outcomes, limits) {
        let errors = [];

        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(details) || details.length % 4 !== 0) {
            errors.push(this._error('INVALID_FIELD_VALUE',
                'DETAILS must be strict base64 (A-Za-z0-9+/ with = padding, length a multiple of 4)',
                { field: 'DETAILS' }));
            return errors;
        }

        const buf = Buffer.from(details, 'base64');
        if (buf.toString('base64') !== details) {
            errors.push(this._error('INVALID_FIELD_VALUE',
                'DETAILS is not canonical base64: it does not re-encode to itself',
                { field: 'DETAILS' }));
            return errors;
        }
        if (buf.length > limits.MAX_BET_DETAILS_LENGTH) {
            errors.push(this._error('INVALID_FIELD_VALUE',
                'DETAILS decodes to ' + buf.length + ' bytes, max ' + limits.MAX_BET_DETAILS_LENGTH,
                { field: 'DETAILS', value: buf.length, constraint: { max: limits.MAX_BET_DETAILS_LENGTH } }));
            return errors;
        }

        let parsed;
        try {
            parsed = JSON.parse(buf.toString('utf8'));
        } catch (e) {
            errors.push(this._error('INVALID_FIELD_VALUE', 'DETAILS must decode to parseable JSON', { field: 'DETAILS' }));
            return errors;
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            errors.push(this._error('INVALID_FIELD_VALUE',
                'DETAILS must decode to a JSON object, not an array or a bare value',
                { field: 'DETAILS' }));
            return errors;
        }

        const depth = (function walk(value, level) {
            if (value === null || typeof value !== 'object') return level;
            let max = level;
            for (const key of Object.keys(value)) max = Math.max(max, walk(value[key], level + 1));
            return max;
        })(parsed, 1);
        if (depth > limits.MAX_BET_DETAILS_DEPTH)
            errors.push(this._error('INVALID_FIELD_VALUE',
                'DETAILS nests ' + depth + ' levels deep, max ' + limits.MAX_BET_DETAILS_DEPTH,
                { field: 'DETAILS', value: depth, constraint: { max: limits.MAX_BET_DETAILS_DEPTH } }));

        // The cross-check that stops a market's human-readable outcomes drifting
        // from the ones bets are actually settled against.
        if (parsed.outcomes !== undefined && !this._isEmpty(outcomes)) {
            const canonical = String(outcomes).split(',').map(o => o.trim());
            if (!Array.isArray(parsed.outcomes)) {
                errors.push(this._error('INVALID_FIELD_VALUE',
                    'DETAILS.outcomes must be an array when present', { field: 'DETAILS' }));
            } else {
                const given = parsed.outcomes.map(o => String(o == null ? '' : o).trim());
                if (given.length !== canonical.length || given.some((o, i) => o !== canonical[i]))
                    errors.push(this._error('INVALID_FIELD_VALUE',
                        'DETAILS.outcomes must match the OUTCOMES field exactly (same order, same count)',
                        { field: 'DETAILS', outcomes: canonical, details: given }));
            }
        }

        return errors;
    }
};
