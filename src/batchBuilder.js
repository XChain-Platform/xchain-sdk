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

    // VM action convenience methods (DEPLOY excluded: too large for BATCH)
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

        let mintCount = 0;
        let issueCount = 0;
        let fileCount = 0;

        for (let entry of this._actions) {
            if (entry.action === 'BATCH')
                throw new SDKValidationError('BATCH_CONSTRAINT', 'BATCH cannot contain nested BATCH actions');
            if (entry.action === 'DEPLOY')
                throw new SDKValidationError('BATCH_CONSTRAINT', 'BATCH cannot contain DEPLOY actions');
            if (entry.action === 'MINT') mintCount++;
            if (entry.action === 'ISSUE') issueCount++;
            if (entry.action === 'FILE') fileCount++;
        }

        if (mintCount > 1)
            throw new SDKValidationError('BATCH_CONSTRAINT', 'BATCH can contain at most 1 MINT action', { count: mintCount });
        if (issueCount > 1)
            throw new SDKValidationError('BATCH_CONSTRAINT', 'BATCH can contain at most 1 ISSUE action', { count: issueCount });
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
