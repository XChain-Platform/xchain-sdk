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
 * XChain Platform SDK - XChainSDK (Software Development Kit)
 *
 * This file handles parsing XChain Platform SDK requests
 *
 ********************************************************************/

const { reconcileEncoded, psbtPrevouts } = require('../carrier/reconcile_encoded.js');
const { assertCarrierBinding } = require('../carrier/bind_action_carrier.js');
const { SDKConfigError, SDKExplorerError } = require('../utils/errors.js');

// Validate and append a quoted native fee so refused quotes cannot reach the encoder.
function appendNativeFeeOutput(nativeFeeQuote, customOutputs) {
    // Paying the fee in the native coin only works where the network offers it for this action.
    if (!nativeFeeQuote || nativeFeeQuote.supported === false)
        throw new SDKConfigError('NATIVE_FEE_UNSUPPORTED', 'Native-coin fee not available for this action: ' + ((nativeFeeQuote && nativeFeeQuote.error) || 'unsupported'), { quote: nativeFeeQuote });
    // Offered is not enough: the quote also has to come back with a price we can actually pay.
    if (nativeFeeQuote.valid === false)
        throw new SDKConfigError('NATIVE_FEE_INVALID', 'Native-coin fee cannot be priced: ' + (nativeFeeQuote.error || 'invalid'), { quote: nativeFeeQuote });
    if (Number(nativeFeeQuote.requiredFeeSats) > 0)
        customOutputs.push({ address: nativeFeeQuote.feeDestination, value: Number(nativeFeeQuote.requiredFeeSats) });
}

// Build the encoder request together so every supported option is forwarded as one shape.
function buildFeeEstimateRequest(result, encoderOpts, customOutputs) {
    return {
        data:             result.actionString,
        pubkey:           encoderOpts.pubkey,
        change:           encoderOpts.change,
        utxos:            encoderOpts.utxos,
        encoding:         encoderOpts.encoding,
        fee:              encoderOpts.fee,
        feePerKb:         encoderOpts.feePerKb,
        rbf:              encoderOpts.rbf,
        dust:             encoderOpts.dust,
        unconfirmed:      encoderOpts.unconfirmed,
        compressedPubKey: encoderOpts.compressedPubKey,
        customOutputs:    customOutputs
    };
}

// Reconcile and annotate the fee result synchronously before it becomes signable.
function reconcileFeeEstimate(sdk, feeResult, result, encoderOpts, customOutputs, nativeFeeQuote) {
    // An envelope answers as a PAIR, and the reveal is what pins the commit's
    // funding leg below. Take it off the result and keep it LOCAL: this method
    // hands back one signable PSBT, and a second one riding along in the return
    // value would be a signable PSBT that nothing here reconciles - the same gap
    // the pre-sign intent gate above closes, reopened one field over. Callers that
    // need to sign a reveal go through submitAction, which gates commit and reveal
    // separately.
    let revealPsbt = feeResult.revealPsbt;
    delete feeResult.revealPsbt;

    // The returned PSBT is documented as directly signable, and the encoder that
    // authored it is a REMOTE service, so it gets the SAME fail-closed intent gate
    // LifecycleManager.submitAction applies before it signs. Without this the
    // blessed estimate-then-sign fast path was the one signing route in the SDK
    // with no reconciliation on it, and a compromised encoder could swap outputs
    // or drop change on it. Fail-closed: reconcileEncoded throws, so
    // the single PSBT this method returns is one it could account for in full.
    let reconcileNetwork;
    try { reconcileNetwork = sdk.wallet.getBitcoinNetwork(); } catch (e) { reconcileNetwork = undefined; }
    reconcileEncoded(feeResult.psbt, {
        network:             reconcileNetwork,
        customOutputs:       customOutputs,
        changeAddresses:     encoderOpts.change,
        callerIdentities:    encoderOpts.pubkey,
        maxFeeSats:          encoderOpts.maxFeeSats,
        maxPhaseFundingSats: encoderOpts.maxPhaseFundingSats,
        label:               'fee estimate',
        // Single-phase only: an estimate carries phase 1 (plus an envelope's reveal
        // when the encoder answered as a pair), never a chunked action's phase 2.
        phaseShapes: (feeResult.encoding === 'P2SH' || feeResult.encoding === 'P2WSH') ? ['p2sh', 'p2wsh']
            : (revealPsbt ? ['p2tr'] : []),
        phaseSpends: revealPsbt ? (psbtPrevouts(revealPsbt) || []) : null,
    });

    // ... and the same carrier bind, for the same reason. The gate above reads
    // outputs, values and the fee and deliberately never reads the data carrier,
    // so a PSBT that reconciles perfectly can still carry a different command
    // than the one this method was asked to price. A signable PSBT handed back
    // unbound is the identical exposure to signing it here.
    assertCarrierBinding({
        psbt:           feeResult.psbt,
        actionString:   result.actionString,
        encoding:       feeResult.encoding,
        carrierScripts: feeResult.carrierScripts,
        network:        reconcileNetwork,
        label:          'fee estimate',
    });

    feeResult.actionString = result.actionString;
    feeResult.action       = result.action;
    feeResult.version      = result.version;
    if (nativeFeeQuote) feeResult.nativeFeeQuote = nativeFeeQuote;
}

// Keep fee and service reads together because they share remote-client validation.
module.exports = {

    // Estimate fees for an action without signing or broadcasting.
    // Returns { fee, inputTotal, outputTotal, encoding, psbt, actionString }
    // The ONE PSBT this returns can be signed directly to skip a second encode call: it
    // has already cleared the same fail-closed reconcileEncoded intent gate submitAction
    // applies before IT signs, so the encoder cannot swap outputs or drop change on this
    // path. Throws SDKActionError rather than returning a PSBT it cannot
    // account for. An envelope's reveal leg is deliberately NOT returned (see below);
    // signing one goes through submitAction, which reconciles both legs.
    //
    // Native-coin protocol fee (opt-in via encoderOpts.payFeeInNativeCoin): pay the XCHAIN
    // protocol fee in BTC/LTC/DOGE at the USD-equivalent by adding a FEE_DESTINATION output.
    // This runs the indexer pre-flight (quoteNativeFee) to size that output exactly and REFUSES
    // to build a doomed tx (unsupported action / stale-or-missing oracle price). A failed
    // native-fee action forfeits the fee on-chain, so we never produce one that can't be priced.
    // The quote is attached as feeResult.nativeFeeQuote.
    async estimateFees(actionData, encoderOpts = {}) {
        let result = this.actions.createAction(actionData);
        let encoder = this._requireEncoder();

        let customOutputs  = Array.isArray(encoderOpts.customOutputs) ? encoderOpts.customOutputs.slice() : [];
        let nativeFeeQuote = null;
        if (encoderOpts.payFeeInNativeCoin) {
            nativeFeeQuote = await this.quoteNativeFee(actionData, { source: encoderOpts.source || encoderOpts.change });
            appendNativeFeeOutput(nativeFeeQuote, customOutputs);
        }

        let feeResult = await encoder.estimateFee(buildFeeEstimateRequest(result, encoderOpts, customOutputs));
        reconcileFeeEstimate(this, feeResult, result, encoderOpts, customOutputs, nativeFeeQuote);
        return feeResult;
    },

    // Native-coin fee pre-flight for an action (without signing/broadcasting). Builds the action
    // string, splits off the ACTION + wire params, and asks the indexer (via the explorer proxy)
    // for the authoritative native fee + accept/reject verdict. A client should size the
    // FEE_DESTINATION output to `requiredFeeSats` and refuse to broadcast when
    // `supported === false` or `valid === false`.
    //
    // `valid === null` is a third answer, not a failure: the VM actions (DEPLOY/EXECUTE) are
    // priced from the indexer's gas schedule without a dry-run (`staticQuote:true`,
    // `validated:false`), so the fee is authoritative but on-chain validity was never judged.
    // Size the output and broadcast, but surface that the action itself is unverified: those two
    // are otherwise unpayable on LTC/DOGE, which have no XCHAIN fee lane to fall back to.
    // A `busy:true, retryable:true` quote (indexer
    // admission cap) is retried once after a short delay (opts.busyRetryDelayMs, default 1s)
    // before being returned. See xchain-documentation/concepts/GAS.md.
    //
    // `actionData` may also be an ALREADY-FORMATTED action string. A caller re-quoting a
    // fee it composed earlier (the wallet's Approve-time re-check) holds the exact bytes it is
    // about to broadcast, and re-deriving them from the form params it started with would price a
    // second, independently built action: the same mirror-drift class as the VOTE params mirror.
    // Same request either way, since the only thing this method ever wanted from `actionData` was
    // the action string.
    async quoteNativeFee(actionData, opts = {}) {
        let actionString = (typeof actionData === 'string')
                         ? actionData
                         : this.actions.createAction(actionData).actionString;
        let parts   = String(actionString).split('|');
        let action  = parts.shift();
        let request = {
            action:        action,
            params:        parts,
            source:        opts.source,
            feeOutputSats: opts.feeOutputSats
        };
        let quote = await this._fetchFeeQuote(request);
        // The indexer's admission cap answers `busy:true, retryable:true` under transient
        // load; one short-delay retry rides that out before callers turn the (valid:false)
        // busy quote into a hard NATIVE_FEE_INVALID refusal.
        if (quote.busy === true && quote.retryable === true) {
            let delayMs = opts.busyRetryDelayMs != null ? Number(opts.busyRetryDelayMs) : 1000;
            await new Promise(resolve => setTimeout(resolve, delayMs));
            quote = await this._fetchFeeQuote(request);
        }
        quote.actionString = actionString;
        return quote;
    },

    async _fetchFeeQuote(request) {
        let quote = await this._requireExplorer().getFeeQuote(request);
        // An explorer that doesn't serve this coin can answer 200 with an HTML page or an
        // unrelated JSON body; treating that as a quote builds a doomed fee-forfeiting tx.
        if (!quote || typeof quote !== 'object' || Array.isArray(quote) || typeof quote.supported !== 'boolean') {
            let detail = (quote && typeof quote === 'object' && quote.error) ? String(quote.error) : 'not a quote object';
            throw new SDKExplorerError('EXPLORER_BAD_FEEQUOTE', 'Explorer returned a malformed native-fee quote (' + detail + '): refusing to size the fee output', { quote: typeof quote === 'string' ? quote.slice(0, 200) : quote });
        }
        return quote;
    },

    async getFeeSchedule() {
        return this._requireExplorer().getFeeSchedule();
    },

    async pingEncoder() {
        return this._requireEncoder().ping();
    },

    // Check encoder hard-dependency health (UTXO tracker reachability + sync state).
    // Returns { tracker_reachable, tracker_synced, tracker_lag }. A passing pingEncoder
    // does not guarantee create_tx will succeed; this call does.
    async healthEncoder() {
        return this._requireEncoder().health();
    },

    // Suggested network fee tiers (base-unit/vByte) at low/medium/high confirmation
    // targets from the coin node's estimatesmartfee. Multiply a tier value by 1000 to
    // pass as feePerKb to submitAction or encodeTx.
    async getFeeTiers() {
        return this._requireEncoder().getFeeTiers();
    },


    /*
     *  Hub Methods
     */

    async pingHub() {
        // No hub address was given, so there is nothing to ping.
        if (!this.hub) throw new SDKConfigError('HUB_NOT_CONFIGURED', 'Hub not configured. Provide hubUrl in SDK options.');
        return this.hub.ping();
    },

    getHubConfig() {
        if (!this.hub) return null;
        return this.hub.configs;
    },

    // Per-capability MIN_STAKE thresholds for capability staking, read live
    // from the hub. Returns an array of { capability, min_stake, disabled }
    // rows, or null when no hub is configured (e.g. regtest) or unreachable.
    // Capabilities are global governance config, so this is not chain-scoped.
    async getCapabilityThresholds() {
        if (!this.hub) return null;
        return this.hub.getCapabilityThresholds();
    },
};
