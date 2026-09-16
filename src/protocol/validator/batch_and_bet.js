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

const { validateBatch } = require('./batch_rules.js');
const { validateBet } = require('./bet_rules.js');
const { validateBetDetails } = require('./bet_details.js');
module.exports = {
    validateBatchFields(fields) {
        return validateBatch(this, fields);
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
    // never re-enter validateBatchFields.
    validateBatchCommand(cmd, index) {
        const { parse } = require('../../decoder/parse.js');
        let res;
        try {
            res = parse(cmd, { validate: true });
        } catch (e) {
            return [this.buildError('BATCH_COMMAND_INVALID',
                'BATCH command ' + index + ' could not be parsed: ' + e.message,
                { index, command: cmd })];
        }
        if (!res || res.ok === false)
            return [this.buildError('BATCH_COMMAND_INVALID',
                'BATCH command ' + index + ' is not a valid action: ' +
                    ((res && res.code) || 'PARSE_FAILED') + ((res && res.detail) ? ' (' + res.detail + ')' : ''),
                { index, command: cmd, code: (res && res.code) || 'PARSE_FAILED' })];
        // Carry the child's own findings up, tagged with its position so the
        // caller can point at the offending command rather than the whole batch.
        const findings = (res.validation && res.validation.findings) || [];
        return findings.map(f => this.buildError(f.code,
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
    validateBetFields(fields) {
        return validateBet(this, fields);
    },
    // DETAILS shape rules, shared by the create path. Kept separate because the
    // explorer and wallet render paths need the same checks against on-chain
    // (therefore hostile) input; betting.js parseBetDetails is the throwing twin.
    validateBetDetailsShape(details, outcomes, limits) {
        return validateBetDetails(this, details, outcomes, limits);
    }
};
