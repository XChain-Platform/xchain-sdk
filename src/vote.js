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
 * XChain Platform SDK - VOTE (token-weighted governance) Helpers
 *
 * Pure builders for the four VOTE versions (see
 * xchain-documentation/protocol/actions/VOTE.md): v0 create a poll, v1
 * cast a ballot, v3 set/clear a delegation. v2 (finalize) is
 * system-synthesized and never user-broadcast, so there is no builder for it.
 *
 * These return camelCase param objects with `version` set; the field
 * normalizer + serializer turn them into the wire action, so all the
 * VOTE-shape knowledge (option/ballot encoding, mode enums, binding-poll
 * pairing rules) lives here in one place. All pure: no network, no consensus.
 * Submit-flow recipes live on sdk.workflows (createPoll / castBallot /
 * delegateVote); the raw action wrapper is sdk.vote().
 *
 ********************************************************************/

const WEIGHT_MODES = ['balance', 'flat', 'quadratic', 'time_weighted'];
const TALLY_MODES  = ['approval', 'split'];
const CALLBACK_ON  = ['pass', 'always'];

function isSet(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
}

class VoteHelpers {

    // Exposed so callers can populate dropdowns / validate without hardcoding.
    get WEIGHT_MODES() { return WEIGHT_MODES.slice(); }
    get TALLY_MODES()  { return TALLY_MODES.slice(); }
    get CALLBACK_ON()  { return CALLBACK_ON.slice(); }

    // Build VOTE v0 params (create a poll). `options` is an array of at least
    // two labels (or a comma string). Optional gates default per VOTE.md; the
    // five callback fields, when set, make the poll binding.
    createPollParams({
        tick, endBlock, options, maxSelections, tallyMode, weightMode,
        quorum, minVoters, minVoteBalance, decideThreshold, question, deposit,
        callbackContract, callbackMethod, callbackParams, callbackOn, gasEscrow,
    } = {}) {
        const ctx = 'voting.createPollParams';
        if (!isSet(tick))     throw new Error(`${ctx}: tick is required`);
        if (!isSet(endBlock)) throw new Error(`${ctx}: endBlock is required (a future block)`);

        const opts = this._optionArray(options, ctx);

        // MAX_SELECTIONS defaults to 1; must be 1..optionCount.
        let ms = isSet(maxSelections) ? Number(maxSelections) : 1;
        if (!Number.isInteger(ms) || ms < 1 || ms > opts.length) {
            throw new Error(`${ctx}: maxSelections must be an integer between 1 and the option count (${opts.length})`);
        }

        const tm = isSet(tallyMode) ? String(tallyMode) : 'approval';
        if (!TALLY_MODES.includes(tm)) throw new Error(`${ctx}: tallyMode must be one of ${TALLY_MODES.join(', ')}`);

        const wm = isSet(weightMode) ? String(weightMode) : 'balance';
        if (!WEIGHT_MODES.includes(wm)) throw new Error(`${ctx}: weightMode must be one of ${WEIGHT_MODES.join(', ')}`);

        // quadratic needs a per-voter floor or a holder can split across
        // addresses to inflate total weight (VOTE.md Rules).
        if (wm === 'quadratic' && !(Number(minVoteBalance) > 0)) {
            throw new Error(`${ctx}: quadratic weighting requires minVoteBalance > 0`);
        }
        if (isSet(quorum)) this._assertFraction(quorum, 'quorum', ctx);
        if (isSet(decideThreshold)) this._assertFraction(decideThreshold, 'decideThreshold', ctx);
        if (isSet(minVoters) && (!Number.isInteger(Number(minVoters)) || Number(minVoters) < 0)) {
            throw new Error(`${ctx}: minVoters must be a non-negative integer`);
        }

        const p = {
            version: 0,
            tick: String(tick).trim(),
            endBlock: String(endBlock),
            options: opts.join(','),
            maxSelections: String(ms),
            tallyMode: tm,
            weightMode: wm,
        };
        if (isSet(quorum))          p.quorum = String(quorum);
        if (isSet(minVoters))       p.minVoters = String(minVoters);
        if (isSet(minVoteBalance))  p.minVoteBalance = String(minVoteBalance);
        if (isSet(decideThreshold)) p.decideThreshold = String(decideThreshold);
        if (isSet(question))        p.question = String(question);
        if (isSet(deposit))         p.deposit = String(deposit);

        // Callback fields make the poll binding. CALLBACK_METHOD is required
        // once a contract is set; the other three are optional.
        if (isSet(callbackContract)) {
            if (!isSet(callbackMethod)) {
                throw new Error(`${ctx}: callbackMethod is required when callbackContract is set (binding poll)`);
            }
            p.callbackContract = String(callbackContract);
            p.callbackMethod = String(callbackMethod);
            if (isSet(callbackParams)) {
                p.callbackParams = Array.isArray(callbackParams) ? JSON.stringify(callbackParams) : String(callbackParams);
            }
            const cbOn = isSet(callbackOn) ? String(callbackOn) : 'pass';
            if (!CALLBACK_ON.includes(cbOn)) throw new Error(`${ctx}: callbackOn must be one of ${CALLBACK_ON.join(', ')}`);
            p.callbackOn = cbOn;
            if (isSet(gasEscrow)) p.gasEscrow = String(gasEscrow);
        }
        return p;
    }

    // Build VOTE v1 params (cast a ballot against an existing poll). `ballot`
    // accepts several shapes; see _formatBallot.
    castBallotParams({ pollRef, ballot, memo } = {}) {
        const ctx = 'voting.castBallotParams';
        if (!isSet(pollRef)) throw new Error(`${ctx}: pollRef is required (the poll's action_index)`);
        const p = {
            version: 1,
            pollRef: String(pollRef),
            ballot: this._formatBallot(ballot, ctx),
        };
        if (isSet(memo)) p.memo = String(memo);
        return p;
    }

    // Build VOTE v3 params (set a standing delegation of TICK voting weight).
    delegateParams({ tick, delegateTo, memo } = {}) {
        const ctx = 'voting.delegateParams';
        if (!isSet(tick))       throw new Error(`${ctx}: tick is required`);
        if (!isSet(delegateTo)) throw new Error(`${ctx}: delegateTo is required (use clearDelegationParams to clear)`);
        const p = { version: 3, tick: String(tick).trim(), delegateTo: String(delegateTo).trim() };
        if (isSet(memo)) p.memo = String(memo);
        return p;
    }

    // Build VOTE v3 params that CLEAR a standing delegation (blank DELEGATE_TO).
    clearDelegationParams({ tick, memo } = {}) {
        const ctx = 'voting.clearDelegationParams';
        if (!isSet(tick)) throw new Error(`${ctx}: tick is required`);
        const p = { version: 3, tick: String(tick).trim(), delegateTo: '' };
        if (isSet(memo)) p.memo = String(memo);
        return p;
    }

    // Normalize a BALLOT into the wire string. Accepts:
    //   - a single option:            0        -> '0'
    //   - approval (multi option):    [0, 2]   -> '0,2'
    //   - split as entry objects:     [{ option: 0, share: 60 }, { option: 2, share: 40 }] -> '0:60,2:40'
    //   - split as an option->share map: { 0: 60, 2: 40 } -> '0:60,2:40'
    //   - a pre-formatted string:     '0:60,2:40' (passed through, trimmed)
    _formatBallot(ballot, ctx) {
        if (ballot === undefined || ballot === null || ballot === '') {
            throw new Error(`${ctx}: ballot is required`);
        }
        if (typeof ballot === 'number') return String(ballot);
        if (typeof ballot === 'string') return ballot.trim();
        if (Array.isArray(ballot)) {
            if (ballot.length === 0) throw new Error(`${ctx}: ballot has no entries`);
            return ballot.map((e) => {
                if (typeof e === 'number' || typeof e === 'string') return String(e).trim();
                if (e && typeof e === 'object' && e.option !== undefined) {
                    return isSet(e.share) ? `${e.option}:${e.share}` : String(e.option);
                }
                throw new Error(`${ctx}: invalid ballot entry ${JSON.stringify(e)}`);
            }).join(',');
        }
        if (typeof ballot === 'object') {
            const entries = Object.entries(ballot);
            if (entries.length === 0) throw new Error(`${ctx}: ballot has no entries`);
            return entries.map(([opt, share]) => `${opt}:${share}`).join(',');
        }
        throw new Error(`${ctx}: invalid ballot ${JSON.stringify(ballot)}`);
    }

    _optionArray(options, ctx) {
        let arr = options;
        if (typeof options === 'string') arr = options.split(',');
        if (!Array.isArray(arr)) throw new Error(`${ctx}: options is required (array of at least two labels)`);
        const labels = arr.map((o) => String(o).trim()).filter((o) => o.length > 0);
        if (labels.length < 2) throw new Error(`${ctx}: options must have at least two non-empty labels`);
        if (labels.some((o) => o.includes(','))) throw new Error(`${ctx}: option labels cannot contain a comma`);
        return labels;
    }

    _assertFraction(value, name, ctx) {
        const n = Number(value);
        if (!(n > 0 && n <= 1)) throw new Error(`${ctx}: ${name} must be a fraction 0 < x <= 1`);
    }
}

module.exports = VoteHelpers;
