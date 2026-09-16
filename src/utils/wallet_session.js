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
 * XChain Platform SDK - Wallet Session
 *
 * Bound wallet object that bundles address/key/UTXO state with
 * action convenience methods. Provides a "I am this address" mental
 * model for developers.
 *
 * Usage:
 *   let session = sdk.session(wif);
 *   await session.send({ tick: 'TOKEN', amount: '100', destination: addr });
 *   let balances = await session.getBalances();
 *
 ********************************************************************/

const UTXOCache        = require('../carrier/utxo_cache.js');
const LifecycleManager = require('../carrier/lifecycle_manager.js');
const { SDKWalletError } = require('./errors.js');
const { installMethods } = require('./install_methods.js');

async function loadAvailableUTXOs(session, encoderOpts) {
    // An explicit `unconfirmed` is a policy the CALLER stated about
    // zero-confirmation inputs, and injecting `utxos` below is what decides
    // whether it can hold: once the encoder is handed a set it stops making
    // its own mempool-inclusive fetch, so a cache snapshot taken before
    // those outputs existed silently denies an opt-in the caller believes it
    // made. Re-pull the tracker view first so what was opted into is
    // actually on offer. Only for an EXPLICIT true: a caller who said
    // nothing keeps the cached, chained fast path and its saved round trip.
    let wantsUnconfirmed  = (encoderOpts.unconfirmed === true);
    let refusesUnconfirmed = (encoderOpts.unconfirmed === false);

    // Lazy-load UTXOs if cache is empty and no explicit UTXOs provided
    let justRefreshed = false;
    if (!encoderOpts.utxos && (wantsUnconfirmed || !session._utxoCache.isLoaded())) {
        await session.refreshUTXOs();
        justRefreshed = true;
    }

    let utxos = session._utxoCache.getAvailable();
    // Fallback for a submit whose change could not be tracked (a
    // caller-supplied change address off the session key, an encoding
    // whose change output this SDK cannot recognize): the cache is then
    // drained, and the second leg of a two-step workflow (setRoster,
    // attachContent) would otherwise fall through to the encoder's
    // pubkey-keyed UTXO fetch, which cannot resolve a hex pubkey to an
    // address. With waitForIndexer (the default) the prior action's change
    // is confirmed by now: re-pull it. In the normal case the change was
    // registered speculatively above and this branch never fires, which is
    // what chains the transactions.
    // justRefreshed: an explicit unconfirmed:true already pulled this view a
    // few lines up, and re-pulling the same empty answer buys nothing.
    if (!encoderOpts.utxos && utxos.length === 0 && session._utxoCache.isLoaded() && !justRefreshed) {
        await session.refreshUTXOs();
        utxos = session._utxoCache.getAvailable();
    }

    return { utxos, refusesUnconfirmed };
}

function buildEncoderOptions(session, encoderOpts, utxos, refusesUnconfirmed) {
    let mergedEncoder = {
        // The encoder's `pubkey` field is the SENDER identity and must be
        // the ADDRESS: the P2SH/P2WSH data-script path base58-decodes it
        // (a hex pubkey throws "Non-base58 character" as soon as an action
        // string outgrows OP_RETURN), and the UTXO-fetch fallback can only
        // key on an address.
        pubkey: session.address,
        change: session.address,
        ...encoderOpts
    };
    // Only inject cached UTXOs if caller didn't provide their own
    if (!encoderOpts.utxos && utxos.length > 0) {
        if (refusesUnconfirmed) {
            // unconfirmed:false refuses zero-conf inputs. The encoder applies
            // the same filter to whatever it is handed, so the SET it ends up
            // with is identical either way; what differs is the error when
            // the filter empties it. Every speculative change output the
            // session chains carries confirmations:0, so a session mid-chain
            // is exactly the case that empties, and the encoder then reports
            // "no utxos found on the blockchain" - which points the operator
            // at an address that is in fact funded. Filter here so that case
            // can say what actually happened.
            let confirmedOnly = utxos.filter(u => Number(u.confirmations) !== 0);
            if (confirmedOnly.length === 0) {
                throw new SDKWalletError(
                    'NO_CONFIRMED_UTXOS',
                    `unconfirmed:false was requested but every available UTXO for ${session.address} ` +
                    `is unconfirmed (${utxos.length} zero-confirmation output(s), including this ` +
                    `session's own chained change); wait for a block or drop unconfirmed:false`,
                    { address: session.address, available: utxos.length }
                );
            }
            mergedEncoder.utxos = confirmedOnly;
        } else {
            mergedEncoder.utxos = utxos;
        }
    }

    return mergedEncoder;
}

async function submitAndTrack(session, actionData, mergedEncoder, submitOpts) {
    let mergedOpts = {
        ...session._defaultOpts,
        ...submitOpts,
        wif: session.wif
    };

    let mgr = new LifecycleManager(session.sdk);
    let result = await mgr.submitAction(actionData, mergedEncoder, mergedOpts);

    // Update UTXO cache: mark spent inputs, then register the change this
    // action paid back to us. Registering the change is what makes the NEXT
    // submit spend THIS one's output, chaining parent -> child. Without it
    // the cache is drained after every submit, the re-pull below falls back
    // to whatever the tracker has CONFIRMED, and two consecutive sends from
    // one session pick independent inputs and land as siblings.
    //
    // Order matters: markSpent first, so a phase that spent an earlier
    // phase's output is never re-offered as available.
    if (result.spentInputs) {
        session._utxoCache.markSpent(result.spentInputs);
    }
    if (Array.isArray(result.changeOutputs)) {
        for (let utxo of result.changeOutputs) {
            session._utxoCache.addSpeculative(utxo);
        }
    }

    return result;
}


class WalletSession {

    constructor(sdk, wif, opts = {}) {
        if (!wif) throw new SDKWalletError('INVALID_WIF', 'WIF is required for WalletSession');

        this.sdk = sdk;

        let keyInfo    = sdk.wallet.importWIF(wif);
        this.wif       = wif;
        this.pubkey    = keyInfo.publicKeyHex;
        this.publicKey = keyInfo.publicKey;
        this.address   = sdk.wallet.deriveAddress(keyInfo.publicKey, { type: opts.addressType || 'p2pkh' });
        this.compressed = keyInfo.compressed;

        // UTXO cache for transaction chaining
        this._utxoCache = new UTXOCache();

        // Serializes submit() calls from this session. The submits share one
        // UTXO cache, and each does read-available -> broadcast -> mark-spent
        // with a long async gap in the middle; two concurrent sends would both
        // reserve the same UTXOs and one would double-spend. This tail promise
        // chains each submit behind the previous, so concurrent callers queue
        // safely instead of racing the cache. (Same idiom as x402's per-nonce
        // mutex and the deposit-ledger lock.)
        this._submitTail = Promise.resolve();

        this._defaultOpts = {
            waitForIndexer: opts.waitForIndexer !== undefined ? opts.waitForIndexer : true,
            timeout:        opts.timeout || 120000,
            pollInterval:   opts.pollInterval || 2000,
            requireValid:   opts.requireValid !== false
        };
    }

    // Refresh UTXO set from the UTXO tracker
    async refreshUTXOs() {
        let encoder = this.sdk.requireEncoder();
        return this._utxoCache.refresh(this.address, encoder);
    }

    // Complete a hand-picked input list into what createTx actually accepts.
    //
    // The encoder REQUIRES scriptPubKey on every explicitly supplied utxo
    // (validateUtxoEntry rejects the entry otherwise), and the public
    // balance/UTXO surfaces callers pick their inputs from do not carry it. So
    // "select the inputs yourself" - the documented way around any UTXO
    // selection the session makes for you - fails on a shape the caller has no
    // way to source. Match each outpoint against the session's tracker view,
    // which does carry scriptPubKey, and hand back entries that can go straight
    // into submit({ utxos }).
    //
    // Caller-supplied fields WIN: only what is missing is filled in, so an entry
    // that already carries its own scriptPubKey is passed through untouched.
    // opts.refresh = false reuses an already-loaded cache instead of re-pulling.
    async hydrateUTXOs(utxos, opts = {}) {
        if (!Array.isArray(utxos)) {
            throw new SDKWalletError('INVALID_UTXOS', 'hydrateUTXOs requires an array of { txid, vout } entries');
        }
        if (utxos.length === 0) return [];

        if (opts.refresh !== false || !this._utxoCache.isLoaded()) {
            await this.refreshUTXOs();
        }

        let known = new Map();
        for (let u of this._utxoCache.getAvailable()) {
            known.set(u.txid + ':' + u.vout, u);
        }

        let hydrated = [];
        let unresolved = [];
        for (let u of utxos) {
            if (!u || typeof u.txid !== 'string' || u.vout === undefined || u.vout === null) {
                throw new SDKWalletError('INVALID_UTXOS', 'each hydrateUTXOs entry needs a txid and a vout');
            }
            let match = known.get(u.txid + ':' + u.vout);
            let entry = {
                ...(match || {}),
                ...u
            };
            if (entry.scriptPubKey === undefined && match) entry.scriptPubKey = match.scriptPubKey;
            if (entry.value === undefined && match)        entry.value        = match.value;
            // The encoder's unconfirmed filter compares confirmations loosely
            // against 0, and a missing field is not the same as a zero: default
            // it only when the tracker view has no answer either.
            if (entry.confirmations === undefined) entry.confirmations = match ? match.confirmations : 0;

            if (typeof entry.scriptPubKey !== 'string' || entry.scriptPubKey.length === 0) {
                unresolved.push(u.txid + ':' + u.vout);
            }
            hydrated.push(entry);
        }

        if (unresolved.length > 0) {
            throw new SDKWalletError(
                'UTXO_NOT_FOUND',
                `cannot complete ${unresolved.length} hand-picked input(s) for ${this.address}: ` +
                `${unresolved.join(', ')} carry no scriptPubKey and are not in this address's UTXO ` +
                `tracker view (spent, belonging to another address, or not yet seen)`,
                { address: this.address, unresolved }
            );
        }

        return hydrated;
    }

    // Submit any action using this session's key, address, and UTXO cache
    // actionData     = { action, params }
    // encoderOpts    = override encoder options (optional)
    // submitOpts     = override submit options (optional)
    //
    // Submits are serialized per session (see _submitTail): if a caller fires
    // several sends concurrently, they queue rather than racing the shared UTXO
    // cache into a double-spend. A failed submit does not block the queue.
    async submit(actionData, encoderOpts = {}, submitOpts = {}) {
        let run = this._submitTail.then(() => this.submitInner(actionData, encoderOpts, submitOpts));
        // Advance the tail regardless of this submit's outcome so one failure
        // (or rejection) never wedges every later send behind it.
        this._submitTail = run.then(() => {}, () => {});
        return run;
    }

    async submitInner(actionData, encoderOpts = {}, submitOpts = {}) {
        let { utxos, refusesUnconfirmed } = await loadAvailableUTXOs(this, encoderOpts);
        let mergedEncoder = buildEncoderOptions(this, encoderOpts, utxos, refusesUnconfirmed);
        return submitAndTrack(this, actionData, mergedEncoder, submitOpts);
    }
}

installMethods(WalletSession.prototype, require('./wallet_session/action_shortcuts.js'));

module.exports = WalletSession;
