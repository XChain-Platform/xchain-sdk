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
 * XChain Platform SDK - Batch Builder
 *
 * Fluent API for building BATCH actions with validation
 *
 ********************************************************************/

const { SDKValidationError } = require('./errors.js');
const {
    BATCH_ACTION_LIMITS_ACTIVE,
    BATCH_COMMAND_LIMIT,
    BATCH_WEIGHT_BUDGET,
    CHILD_ISSUE_KEY,
    actionWeight,
    classifyIssueTick,
    maxMintsPerDistinctTick,
    paramsTick,
} = require('./batchLimits.js');

// Wording for the per-ACTION caps this builder enforces, keyed the same way
// batchLimits keys them. The LIMITS live in the shared mirror so a future
// change lands once; only the sentence a caller reads lives here.
const LIMIT_MESSAGES = {
    BATCH:  'BATCH cannot contain nested BATCH actions',
    DEPLOY: 'BATCH can contain at most 1 DEPLOY action',
    MINT:   'BATCH can contain at most 1 MINT action per distinct TICK',
    ISSUE:  'BATCH can contain at most 1 top-level ISSUE action (child TICKs like JDOG.1 are exempt)',
};


class BatchBuilder {

    constructor(sdk) {
        this.sdk      = sdk;
        this._actions = [];
    }

    // Add a raw action by name + params
    add(action, params) {
        this._actions.push({ action: String(action).toUpperCase(), params: params || {} });
        return this;
    }

    // Convenience methods for each action type
    send(params)      { return this.add('SEND', params); }
    issue(params)     { return this.add('ISSUE', params); }
    mint(params)      { return this.add('MINT', params); }
    destroy(params)   { return this.add('DESTROY', params); }
    order(params)     { return this.add('ORDER', params); }
    broadcast(params) { return this.add('BROADCAST', params); }
    dispenser(params) { return this.add('DISPENSER', params); }
    dividend(params)  { return this.add('DIVIDEND', params); }
    sweep(params)     { return this.add('SWEEP', params); }
    swap(params)      { return this.add('SWAP', params); }
    callback(params)  { return this.add('CALLBACK', params); }
    sleep(params)     { return this.add('SLEEP', params); }
    airdrop(params)   { return this.add('AIRDROP', params); }
    message(params)   { return this.add('MESSAGE', params); }
    list(params)      { return this.add('LIST', params); }
    link(params)      { return this.add('LINK', params); }
    address(params)   { return this.add('ADDRESS', params); }

    // VM action convenience methods. DEPLOY is CAPPED AT 1 per BATCH, not
    // forbidden: every DEPLOY runs a constructor in the VM, by far the most
    // expensive per-command work in the system, and the 250-command cap was
    // sized for cheap commands. The old outright ban here was never a protocol
    // rule - it was a legacy-lane size fact (8192 bytes) that the Taproot
    // envelope lane retired, and oversize is self-enforcing at the encoder.
    deploy(params)    { return this.add('DEPLOY', params); }
    execute(params)   { return this.add('EXECUTE', params); }
    deposit(params)   { return this.add('DEPOSIT', params); }
    withdraw(params)  { return this.add('WITHDRAW', params); }

    // FILE may appear at most once per BATCH (a transaction carries one rawData
    // payload). Most common composition: BATCH(FILE, MESSAGE-to-self) when an
    // issuer publishes token-gated content and records the recoverable key
    // atomically.
    file(params)      { return this.add('FILE', params); }

    // Validate BATCH constraints before building
    _validate() {
        if (this._actions.length === 0)
            throw new SDKValidationError('BATCH_EMPTY', 'BATCH must contain at least one action');

        // Global command cap, checked FIRST so a batch breaking it and the ISSUE
        // limit reports the cap - the same precedence the arbiter pins. Each
        // queued action serializes to exactly one ';'-separated command, so the
        // queue length IS the count the chain will make.
        if (this._actions.length > BATCH_COMMAND_LIMIT)
            throw new SDKValidationError('BATCH_CONSTRAINT',
                'BATCH can contain at most ' + BATCH_COMMAND_LIMIT + ' commands',
                { count: this._actions.length, limit: BATCH_COMMAND_LIMIT });

        // BATCH_COST_WEIGHTING: the WEIGHTED budget, in the arbiter's own
        // position - immediately after the count and before every per-ACTION
        // cap (xchain-indexer/src/actions/batch.js parse(): the count
        // pre-filter, then the weighted sum, then the cap loop). Both bounds
        // are the same on-chain rejection, `invalid: COMMAND (limit)`; the
        // count stays first and is an EXACT pre-filter rather than a
        // conservative one, because every weight is an integer >= 1, so a batch
        // over the count is over the budget too and weighing it teaches nobody
        // anything.
        //
        // WHAT COUNTING CANNOT SEE, which is the whole reason this check
        // exists: nine EXECUTEs weigh 270 and eleven AIRDROPs weigh 275, and
        // both are nowhere near 250 commands. Until this ran, the builder
        // composed those batches happily and the chain rejected them whole.
        //
        // Weighed off the QUEUED action name rather than the serialized string,
        // which does not exist yet; that is the same name build() serializes as
        // the leading token, and actionWeight expands aliases exactly as the
        // arbiter does, so `DROP` costs an AIRDROP's 25 here too.
        //
        // A REFUSAL, not a warning, matching the count cap beside it and the
        // "WHICH SIDE OF THE FLAG" note in batchLimits.js: this mirror speaks
        // for the POST-flag rule set on every network. BATCH_COST_WEIGHTING is
        // genesis-active on testnet and regtest and unarmed on mainnet, so
        // composing to the tighter rule is the shape that lands everywhere, and
        // the alternative is emitting a batch that is rejected wholesale on two
        // of the three networks. The DECODE-side sites (decoder/parse.js,
        // preflight/checks/batch.js) report the same overflow as a finding
        // instead, because they describe a batch someone else already composed
        // and cannot refuse anything.
        let weight = 0;
        for (let entry of this._actions) weight += actionWeight(entry.action);
        if (weight > BATCH_WEIGHT_BUDGET)
            throw new SDKValidationError('BATCH_CONSTRAINT',
                'BATCH commands weigh ' + weight + ' (VM and fan-out actions cost more than 1 each); '
                + 'the chain rejects the whole batch above a total weight of ' + BATCH_WEIGHT_BUDGET,
                { count: this._actions.length, weight, limit: BATCH_WEIGHT_BUDGET });

        // Occurrences per counting key, and the MINT TICKs, collected in ONE
        // pass so the two can never disagree about which entries are MINTs.
        let counts = {};
        let mintTicks = [];
        let fileCount = 0;
        // First-appearance order of the counting keys (spec R2b). Kept as a LIST
        // because `Object.keys(counts)` returns insertion order only by
        // convention, and R2b's whole point is that a consensus-shaped
        // precedence must not rest on that.
        let keyOrder = [];

        for (let entry of this._actions) {
            // Only a TOP-LEVEL (undotted, non-caret) ISSUE consumes the single
            // top-level slot; child issuances (JDOG.1, JDOG.1.2) are uncapped, so
            // one BATCH registers a parent plus any number of its children. The
            // TICK is read from the queued params here rather than the serialized
            // string, which does not exist yet; tickResolver never compacts an
            // ISSUE's defining TICK to `^<id>`, so the value classified here is
            // the one that reaches the wire.
            let key = entry.action === 'ISSUE'
                ? classifyIssueTick(paramsTick(entry.params))
                : entry.action;
            if (counts[key] === undefined) keyOrder.push(key);
            counts[key] = (counts[key] || 0) + 1;
            if (key === 'MINT') mintTicks.push(paramsTick(entry.params));
            if (key === 'FILE') fileCount++;
        }

        // MINT is capped per DISTINCT token, not per occurrence: minting twelve
        // different tokens in one transaction takes nothing from anyone, while a
        // batch of 100 MINTs of ONE fair-mint token beats 100 separate
        // transactions on both fee and in-block ordering.
        let mint = mintTicks.length ? maxMintsPerDistinctTick(mintTicks) : { max: 0, approximate: false };

        // The caps themselves come from the shared mirror, so a limit change (or
        // a new capped action) lands in batchLimits.js alone. Iterated over the
        // OBSERVED keys in FIRST-APPEARANCE order (spec R2b), the arbiter's own
        // rule, rather than a precedence this builder invents. Worth stating where a caller reads these throws:
        // BATCH_ISSUANCE_LIMITS is ARMED on every network (mainnet at
        // 2026-08-16T00:00:00Z, testnet and regtest at genesis), so the
        // LOOSENINGS this enforces (a parent plus children, MINTs of several
        // distinct tokens) are accepted on chain as well. Below the mainnet
        // instant they are rejected on chain; the DEPLOY cap is the one rule
        // both sides of the flag agree on, since the chain never caps DEPLOY
        // below it and at most 1 is accepted either way.
        for (let key of keyOrder) {
            let limit = BATCH_ACTION_LIMITS_ACTIVE[key];
            if (limit === undefined) continue;
            let observed = key === 'MINT' ? mint.max : counts[key];
            if (observed > limit)
                throw new SDKValidationError('BATCH_CONSTRAINT',
                    LIMIT_MESSAGES[key] || ('BATCH can contain at most ' + limit + ' ' + key + ' action(s)'),
                    { count: observed, limit });
        }

        // Checked AFTER the counted caps so a batch that is over a limit on the
        // strings alone gets that precise verdict. What is left here is a shape
        // whose verdict genuinely depends on a resolution only an indexer can do:
        // `JDOG` and `^614` can name ONE token, which would be two bites at one
        // scarce token. Composing is the side that can still fix it, so refuse
        // and say how, rather than emit a batch the chain may reject.
        //
        // `approximate` is already exactly this shape and nothing narrower is
        // needed here: the seam sets it only when a caret coexists with a
        // NON-caret key. An ALL-caret set is two distinct ids by construction
        // and is left alone deliberately - refusing it would be a false refusal
        // reachable by default, because tickResolver COMPACTS a MINT's TICK to
        // `^<id>` before serializing, so the SDK's own builder normally emits
        // all-caret MINT batches.
        if (mint.approximate)
            throw new SDKValidationError('BATCH_CONSTRAINT',
                'BATCH mixes a `^<id>` MINT TICK with another MINT: a caret alias and a name can be the ' +
                'SAME token, which this SDK cannot resolve. Spell every MINT TICK by name.',
                { ticks: mintTicks.map(t => (t === undefined || t === null) ? '' : String(t)) });

        if (fileCount > 1)
            throw new SDKValidationError('BATCH_CONSTRAINT',
                'BATCH can contain at most 1 FILE action (one rawData per transaction)',
                { count: fileCount });
    }

    // Build the BATCH action: validates each sub-action, enforces constraints,
    // produces the semicolon-joined command string. If a FILE sub-action carries
    // `rawData` in its params (gated-content publishing), that rawData is
    // promoted to BATCH-level encoder options so the encoder attaches it to the
    // transaction.
    //
    // NOTE: returns a Promise. Sub-action strings are built synchronously via
    // sdk.actions.createAction (validate + format select + serialize); the Promise
    // comes from the final sdk.createAction call, which is async only when
    // encoder.pubkey is supplied and a PSBT needs to be built. Callers MUST await:
    //   const batchAction = await sdk.batch().send(...).mint(...).build();
    async build(encoderOpts) {
        this._validate();

        // Build each sub-action through the full pipeline (validate + format select + serialize).
        // The serialize step itself is synchronous (sdk.actions.createAction); the
        // per-action await is the ticker-compaction lookup that rewrites names to
        // their `^<id>` wire form before serializing.
        let commandParts = [];
        let extractedRawData = null;
        for (let entry of this._actions) {
            // FILE's rawData is encoder-level, not part of the action string:
            // strip it from params before serializing and hoist it to encoder opts.
            let subParams = entry.params;
            if (entry.action === 'FILE' && subParams && subParams.rawData !== undefined) {
                let { rawData, ...rest } = subParams;
                subParams = rest;
                extractedRawData = rawData;
            }
            let resolvedParams = await this.sdk.tickResolver.resolveActionParams(entry.action, subParams);
            resolvedParams = await this.sdk.addressResolver.resolveActionParams(entry.action, resolvedParams);
            let result = this.sdk.actions.createAction({
                action: entry.action,
                params: resolvedParams
            });
            commandParts.push(result.actionString);
        }

        // Join with semicolons
        let command = commandParts.join(';');

        // Merge extracted rawData into encoder opts (caller-supplied takes precedence)
        let mergedEncoder = encoderOpts || {};
        if (extractedRawData !== null && mergedEncoder.rawData === undefined) {
            mergedEncoder = { ...mergedEncoder, rawData: extractedRawData };
        }

        // Now create the BATCH action itself (async: may build a PSBT if pubkey supplied)
        return this.sdk.createAction({
            action: 'BATCH',
            params: { command },
            encoder: mergedEncoder
        });
    }

    // Reset the builder for reuse
    reset() {
        this._actions = [];
        return this;
    }

    // Get count of queued actions
    get length() {
        return this._actions.length;
    }

}

module.exports = BatchBuilder;
